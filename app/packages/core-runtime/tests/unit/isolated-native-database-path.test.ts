import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { ConfigProvider, Effect, Exit, FileSystem, Layer, Schema } from 'effect';
import { afterAll, expect, it, rs } from 'effect-rstest';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';

import { parseDatabaseConnectionPair } from '../../src/db/config.ts';
import { makeIsolatedNativeDatabaseFixture } from '../../src/testing/isolated-native-database.ts';
import { makeApplicationCompositionSnapshotFixture } from '../../src/testing/module-contract.ts';

const database = rs.hoisted(() => ({ acquisitions: 0, statements: 0 }));

// Replace only database I/O. The real fixture constructs both commands and the installed
// Node spawner executes them. Stop after cloning, before any further fixture work.
// Catalog audits must not be a precondition of acquiring a business-test database.
rs.mock('../../src/db/client.ts', () => ({
  ...rs.requireActual('../../src/db/client.ts'),
  makeCoreDatabase: () => {
    database.acquisitions += 1;
    if (database.acquisitions > 1) {
      return Effect.fail('TEST_STOP_AFTER_CLONE');
    }
    const execute = () => {
      database.statements += 1;
      return Effect.succeed([]);
    };
    return Effect.succeed({
      executor: {
        execute,
        transaction: <Result, Failure>(
          body: (transaction: { execute: typeof execute }) => Effect.Effect<Result, Failure>,
        ) => body({ execute }),
      },
    });
  },
}));

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

it.live(
  'passes only explicit PATH and PGPASSWORD to both real clone helper children',
  () =>
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
          database.acquisitions = 0;
          database.statements = 0;
          rs.stubEnv('ONTOS_CLONE_AMBIENT_SECRET', 'TEST_AMBIENT_DUMMY');
          yield* Effect.addFinalizer(() => Effect.sync(() => rs.unstubAllEnvs()));
          const sourceConnections = yield* parseDatabaseConnectionPair({
            DATABASE_ADMIN_URL: 'postgresql://test_admin:TEST%3Adummy@localhost/test_source',
            DATABASE_URL: 'postgresql://test_runtime:TEST_runtime_dummy@localhost/test_source',
          });
          const compositionSnapshot = yield* makeApplicationCompositionSnapshotFixture(['privacy'], 'TEST-PATH');
          const attempt = makeIsolatedNativeDatabaseFixture({
            compositionSnapshot,
            mode: 'schema-only',
            purpose: 'stabilization-1257-approval-fresh-proof',
            sourceConnections,
          }).pipe(
            Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({ PATH: directory })),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, guardedSpawner),
            Effect.scoped,
          );
          const result = yield* Effect.exit(attempt);
          expect(Exit.isFailure(result)).toBe(true);
          const dumpExists = yield* fs.exists(`${directory}/pg_dump.json`);
          const restoreExists = yield* fs.exists(`${directory}/pg_restore.json`);
          if (!dumpExists && Exit.isFailure(result)) {
            expect(String(result.cause)).toBe('private pg_dump executed');
          }
          expect({ dumpExists, restoreExists }).toEqual({ dumpExists: true, restoreExists: true });
          // Source admin pool, then the clone pool whose scripted failure interrupts the concurrent runtime-role pool before it is acquired.
          expect(database.acquisitions).toBe(2);
          // Only create and finalizer drop run before the clone pool is acquired.
          expect(database.statements).toBe(2);
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
            expect(receipt.password).toBe('TEST:dummy');
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
            'test_admin',
            '--dbname',
            'test_source',
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
            'test_admin',
            '--dbname',
            expect.stringMatching(/^ontos_test_party_gateway_[a-f0-9]{32}$/u),
            '--schema-only',
            '--exit-on-error',
            '--single-transaction',
          ]);
          expect(restore.input).toBe('TEST_DUMP');
          // A producer that wrote bytes but failed must never start the restore.
          yield* fs.remove(`${directory}/pg_restore.json`);
          yield* fs.remove(`${directory}/dump-finished`);
          yield* fs.writeFileString(`${directory}/refuse-dump`, '');
          database.acquisitions = 0;
          database.statements = 0;
          const dumpFailure = yield* Effect.flip(attempt);
          expect(dumpFailure).toMatchObject({ reason: 'Schema-only dump failed' });
          expect(yield* fs.exists(`${directory}/pg_restore.json`)).toBe(false);
          expect(database.acquisitions).toBe(1);
          expect(database.statements).toBe(2);

          // A rejected archive is a failed clone; no clone client or trust initialization runs.
          yield* fs.remove(`${directory}/refuse-dump`);
          yield* fs.remove(`${directory}/dump-finished`);
          yield* fs.writeFileString(`${directory}/refuse-restore`, '');
          database.acquisitions = 0;
          database.statements = 0;
          const restoreFailure = yield* Effect.flip(attempt);
          expect(restoreFailure).toMatchObject({ reason: 'Schema-only restore failed' });
          expect(yield* fs.exists(`${directory}/pg_restore.json`)).toBe(true);
          expect(database.acquisitions).toBe(1);
          expect(database.statements).toBe(2);
        }).pipe(Effect.provide(services)),
      ),
      Effect.scoped,
    ),
  5000,
);

it.effect(
  'keeps the Assortment authorization purpose forbidden in deployed environments before database or process I/O',
  () =>
    Effect.scoped(
      Effect.gen(function* rejectsDeployedAssortmentFixture() {
        const context = yield* Layer.build(
          NodeChildProcessSpawner.layer.pipe(
            Layer.provideMerge(NodeServices.layer),
            Layer.provideMerge(NodeCrypto.layer),
          ),
        );
        const compositionSnapshot = yield* makeApplicationCompositionSnapshotFixture(['privacy'], 'UNIT-GUARD');
        const failure = yield* Effect.flip(
          makeIsolatedNativeDatabaseFixture({
            compositionSnapshot,
            mode: 'schema-only',
            purpose: 'implementation-1290-assortment-authorization',
          }).pipe(
            Effect.provideContext(context),
            Effect.provideService(
              ConfigProvider.ConfigProvider,
              ConfigProvider.fromUnknown({ ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'production' }),
            ),
          ),
        );
        expect(failure).toMatchObject({
          reason: 'Isolated native database fixtures are forbidden in deployed environments',
        });
      }),
    ),
);

// With `isolate: false` one module registry is shared by every file a worker runs, so these
// replacements outlive this file and would leak into whatever runs next. Remove them and drop the
// modules they replaced, so the next file evaluates the real implementations.
afterAll(() => {
  rs.doUnmock('../../src/db/client.ts');
  rs.resetModules();
});
