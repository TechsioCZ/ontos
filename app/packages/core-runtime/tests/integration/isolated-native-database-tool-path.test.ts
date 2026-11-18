import { NodeServices } from '@effect/platform-node';
import { ConfigProvider, Crypto, Effect, Exit, FileSystem, Layer, Schema } from 'effect';
import { expect, it, rs } from 'effect-rstest';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';

import { loadDatabaseConnectionPair } from '../../src/db/config.ts';
import { makeIsolatedNativeDatabaseFixture } from '../../src/testing/isolated-native-database.ts';
import { makeApplicationCompositionSnapshotFixture } from '../../src/testing/module-contract.ts';
import { makeTestPgClient } from '../support/database.ts';

const receiptSchema = Schema.fromJsonString(
  Schema.Struct({
    args: Schema.Array(Schema.String),
    environmentNames: Schema.Array(Schema.String),
    input: Schema.String,
    password: Schema.String,
    path: Schema.String,
    secretForwarded: Schema.Boolean,
  }),
);

const cloneNameSchema = Schema.String.check(Schema.isPattern(/^ontos_test_party_gateway_[a-f0-9]{32}$/u));
const cloneNameFrom = (args: readonly string[]) =>
  Schema.decodeUnknownSync(cloneNameSchema)(args[args.indexOf('--dbname') + 1]);

// Observe native entropy without replacing it with a predetermined test identity.
const observeCloneNames = (crypto: Crypto.Crypto, names: string[]) => ({
  ...crypto,
  randomUUIDv4: () =>
    crypto.randomUUIDv4().pipe(
      Effect.tap((uuid) =>
        Effect.sync(() => {
          names.push(`ontos_test_party_gateway_${uuid.replaceAll('-', '')}`);
        }),
      ),
    ),
});

it.live('passes only explicit PATH and PGPASSWORD to both real clone helper children', () =>
  Layer.build(NodeServices.layer).pipe(
    Effect.flatMap((services) =>
      Effect.gen(function* cloneHelperPath() {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'ontos-clone-path-' });
        const nativeSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        // Refuse unsafe resolution before native spawning, even on CI hosts with Docker installed.
        const guardedSpawner = ChildProcessSpawner.make((command) => {
          if (
            !ChildProcess.isStandardCommand(command) ||
            command.command !== 'docker' ||
            command.options.env?.['PATH'] !== directory ||
            command.options.extendEnv === true
          ) {
            return Effect.die('TEST_REFUSED_UNCONTROLLED_EXECUTABLE');
          }
          return nativeSpawner.spawn(command);
        });
        const refusedFallback = yield* guardedSpawner
          .spawn(ChildProcess.make('docker', [], { env: { PGPASSWORD: 'TEST_DUMMY' } }))
          .pipe(Effect.exit);
        expect(Exit.isFailure(refusedFallback)).toBe(true);
        const directoryLiteral = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.String))(directory);
        yield* fs.writeFileString(
          `${directory}/docker`,
          `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const program = args[5];
let input = '';
const record = () => fs.writeFileSync(${directoryLiteral} + '/' + program + '.json', JSON.stringify({
  args, input, environmentNames: Object.keys(process.env).sort(), path: process.env.PATH, password: process.env.PGPASSWORD,
  secretForwarded: Object.hasOwn(process.env, 'ONTOS_CLONE_AMBIENT_SECRET')
}));
if (program === 'pg_dump') {
  record();
  process.stdout.write('TEST_');
  setTimeout(() => process.stdout.end('DUMP', () => {
    fs.writeFileSync(${directoryLiteral} + '/dump-finished', '');
    if (fs.existsSync(${directoryLiteral} + '/refuse-dump')) process.exitCode = 1;
  }), 25);
} else {
  const dumpFinished = fs.existsSync(${directoryLiteral} + '/dump-finished');
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { input += chunk; });
  process.stdin.on('end', () => {
    record();
    if (!dumpFinished || fs.existsSync(${directoryLiteral} + '/refuse-restore')) process.exitCode = 1;
  });
}
`,
        );
        yield* fs.chmod(`${directory}/docker`, 0o700);
        rs.stubEnv('ONTOS_CLONE_AMBIENT_SECRET', 'TEST_AMBIENT_DUMMY');
        yield* Effect.addFinalizer(() => Effect.sync(() => rs.unstubAllEnvs()));
        // The integration slot's own disposable PostgreSQL is the source; every clone is dropped.
        const sourceConnections = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
        const sourceAdmin = sourceConnections.admin;
        const admin = yield* makeTestPgClient(sourceAdmin.connectionString, { maxConnections: 1 });
        const databaseExists = (name: string) =>
          admin
            .unsafe<{ readonly exists: boolean }>(
              'select exists(select 1 from pg_catalog.pg_database where datname = $1) as exists',
              [name],
            )
            .pipe(Effect.map(([row]) => row?.exists === true));
        const compositionSnapshot = yield* makeApplicationCompositionSnapshotFixture(['privacy'], 'TEST-PATH');
        const crypto = yield* Crypto.Crypto;
        const generatedCloneNames: string[] = [];
        const attempt = makeIsolatedNativeDatabaseFixture({
          compositionSnapshot,
          mode: 'schema-only',
          purpose: 'stabilization-1257-approval-fresh-proof',
          sourceConnections,
        }).pipe(
          Effect.provideService(Crypto.Crypto, observeCloneNames(crypto, generatedCloneNames)),
          Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({ PATH: directory })),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, guardedSpawner),
          Effect.scoped,
        );
        const result = yield* Effect.exit(attempt);
        const dumpExists = yield* fs.exists(`${directory}/pg_dump.json`);
        const restoreExists = yield* fs.exists(`${directory}/pg_restore.json`);
        if (!dumpExists && Exit.isFailure(result)) {
          expect(String(result.cause)).toBe('private pg_dump executed');
        }
        expect({ dumpExists, restoreExists }).toEqual({ dumpExists: true, restoreExists: true });
        const dump = yield* fs
          .readFileString(`${directory}/pg_dump.json`)
          .pipe(Effect.flatMap(Schema.decodeEffect(receiptSchema)));
        const restore = yield* fs
          .readFileString(`${directory}/pg_restore.json`)
          .pipe(Effect.flatMap(Schema.decodeEffect(receiptSchema)));
        for (const receipt of [dump, restore]) {
          // macOS may inject this system key even when spawn receives only our two keys.
          expect(receipt.environmentNames.filter((key) => key !== '__CF_USER_TEXT_ENCODING')).toEqual([
            'PATH',
            'PGPASSWORD',
          ]);
          expect(receipt.path).toBe(directory);
          expect(receipt.password).toBe(decodeURIComponent(new URL(sourceAdmin.connectionString).password));
          expect(receipt.secretForwarded).toBe(false);
        }
        expect(dump.args).toEqual([
          'exec',
          '-i',
          '-e',
          'PGPASSWORD',
          'ontos-db',
          'pg_dump',
          '--host',
          'localhost',
          '--username',
          sourceAdmin.user,
          '--dbname',
          sourceAdmin.database,
          '--schema-only',
          '--no-comments',
          '--format=custom',
        ]);
        expect(restore.args).toEqual([
          'exec',
          '-i',
          '-e',
          'PGPASSWORD',
          'ontos-db',
          'pg_restore',
          '--host',
          'localhost',
          '--username',
          sourceAdmin.user,
          '--dbname',
          expect.stringMatching(/^ontos_test_party_gateway_[a-f0-9]{32}$/u),
          '--schema-only',
          '--exit-on-error',
          '--single-transaction',
        ]);
        expect(restore.input).toBe('TEST_DUMP');
        // The scope that owned the restored clone dropped it.
        const restoredClone = cloneNameFrom(restore.args);
        expect(yield* databaseExists(restoredClone)).toBe(false);
        // A producer that wrote bytes but failed must never start the restore.
        yield* fs.remove(`${directory}/pg_restore.json`);
        yield* fs.remove(`${directory}/dump-finished`);
        yield* fs.writeFileString(`${directory}/refuse-dump`, '');
        const dumpFailure = yield* Effect.flip(attempt);
        expect(dumpFailure).toMatchObject({ reason: 'Schema-only dump failed' });
        expect(yield* fs.exists(`${directory}/pg_restore.json`)).toBe(false);
        const failedDumpClone = yield* Schema.decodeUnknownEffect(cloneNameSchema)(generatedCloneNames.at(-1));
        expect(failedDumpClone).not.toBe(restoredClone);
        expect(yield* databaseExists(failedDumpClone)).toBe(false);

        // A rejected archive is a failed clone, and its database is still dropped.
        yield* fs.remove(`${directory}/refuse-dump`);
        yield* fs.remove(`${directory}/dump-finished`);
        yield* fs.writeFileString(`${directory}/refuse-restore`, '');
        const restoreFailure = yield* Effect.flip(attempt);
        expect(restoreFailure).toMatchObject({ reason: 'Schema-only restore failed' });
        const rejectedRestore = yield* fs
          .readFileString(`${directory}/pg_restore.json`)
          .pipe(Effect.flatMap(Schema.decodeEffect(receiptSchema)));
        const rejectedClone = cloneNameFrom(rejectedRestore.args);
        expect(rejectedClone).not.toBe(restoredClone);
        expect(yield* databaseExists(rejectedClone)).toBe(false);
      }).pipe(Effect.provide(services)),
    ),
    Effect.scoped,
  ),
);
