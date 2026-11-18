import nodeProcess from 'node:process';
import { fileURLToPath } from 'node:url';

import { NodeServices } from '@effect/platform-node';
import { eq, sql } from 'drizzle-orm';
import {
  Config,
  ConfigProvider,
  DateTime,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Match,
  Option,
  Schema,
  Stdio,
} from 'effect';
import { HttpClient, HttpClientResponse } from 'effect/http';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';
import { parse } from 'yaml';

import { makeCoreDatabase } from '../../packages/core-runtime/src/db/client.ts';
import { parseDatabaseConnectionPair } from '../../packages/core-runtime/src/db/config.ts';
import { applicationCompositionAuthority } from '../../packages/core-runtime/src/db/schema.ts';
import { ApplicationCompositionAuthorityError } from '../../packages/core-runtime/src/modules/application-composition-authority.ts';
import { makeApplicationCompositionSnapshotFixture } from '../../packages/core-runtime/src/testing/module-contract.ts';
import { MIGRATION_REQUIREMENTS_ENV, MIGRATION_VERIFY_ONLY_ENV } from '../application-migration-publication.mts';
import { ApplicationReleaseIntentSchema } from '../application-release-intent.mts';
import { OpsShellLive } from '../ops/ops-shell.mts';
import { main } from '../publish-active-application-composition.mts';

const INTENT_FILE = 'scripts/tests/fixtures/migration-selected-intent.json';
const PROJECT_ID = 'lifecycle-project';
const SERVICE_ID = 'lifecycle-migrator';
const VERSION_NAME = 'lifecycle-version';
const ZEROPS_TOKEN = 'lifecycle-zerops-token';
const BASELINE_REVISION = '1'.repeat(64);
const FOREIGN_REVISION = '2'.repeat(64);
const PROVIDER_COPY = '<provider copy>';
const ZEROPS_YAML_FLAG = '--zerops-yaml-path';
const STOP_PROCESS_ID = 'lifecycle-migrator-stop';
const MIGRATION_ALREADY_COMPLETED = 'The completed migration requires replacement publication before another migration';
const BASELINE_MOVED = 'The native publication authority no longer matches the captured baseline or active target';

interface Deployment {
  readonly args: readonly string[];
  readonly provider: string;
  readonly providerPath: string;
}

const ProviderCopySchema = Schema.Struct({
  zerops: Schema.Array(
    Schema.Struct({
      run: Schema.optionalKey(
        Schema.Struct({ envVariables: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)) }),
      ),
      setup: Schema.String,
    }),
  ),
});

/** zcli is the external deployment tool: record its exact request and answer as a successful push. */
const recordMigratorPush = Effect.fn(function* recordMigratorPush(
  native: {
    readonly filesystem: FileSystem.FileSystem;
    readonly spawner: ChildProcessSpawner.ChildProcessSpawner['Service'];
  },
  deployments: Deployment[],
  push: ChildProcess.StandardCommand,
) {
  const { filesystem, spawner } = native;
  const providerPath = push.args[push.args.indexOf(ZEROPS_YAML_FLAG) + 1] ?? '';
  deployments.push({ args: push.args, provider: yield* filesystem.readFileString(providerPath), providerPath });
  return yield* spawner.spawn(ChildProcess.make(nodeProcess.execPath, ['-e', '']));
});

const recordingDeploymentTool = (deployments: Deployment[]) =>
  Layer.effect(
    ChildProcessSpawner.ChildProcessSpawner,
    Effect.gen(function* deploymentToolSpawner() {
      const native = {
        filesystem: yield* FileSystem.FileSystem,
        spawner: yield* ChildProcessSpawner.ChildProcessSpawner,
      };
      return ChildProcessSpawner.make((command) =>
        Match.value(command).pipe(
          Match.tag('StandardCommand', (standard) =>
            standard.command === 'zcli'
              ? recordMigratorPush(native, deployments, standard)
              : native.spawner.spawn(standard),
          ),
          Match.tag('PipedCommand', () => Effect.die('The migrate CLI must not pipe native commands')),
          Match.exhaustive,
        ),
      );
    }),
  ).pipe(Layer.provide(NodeServices.layer));

/** The Zerops public API stop protocol: one stop mutation, its finished process and a STOPPED readback. */
const zeropsStopProtocol = (requests: string[]) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url) => {
      requests.push(`${request.method} ${url.pathname}`);
      expect(request.headers.authorization).toBe(`Bearer ${ZEROPS_TOKEN}`);
      let response: Response;
      if (request.method === 'PUT' && url.pathname === `/api/rest/public/service-stack/${SERVICE_ID}/stop`) {
        response = Response.json({ id: STOP_PROCESS_ID, status: 'PENDING' });
      } else if (request.method === 'GET' && url.pathname === `/api/rest/public/process/${STOP_PROCESS_ID}`) {
        response = Response.json({ id: STOP_PROCESS_ID, status: 'FINISHED' });
      } else if (request.method === 'GET' && url.pathname === `/api/rest/public/service-stack/${SERVICE_ID}`) {
        response = Response.json({ id: SERVICE_ID, name: 'migrator', status: 'STOPPED', subdomainAccess: false });
      } else {
        return Effect.die(`Unexpected migration provider request: ${request.method} ${url.pathname}`);
      }
      return Effect.succeed(HttpClientResponse.fromWeb(request, response));
    }),
  );

it.live(
  'the actual migrate CLI takes native pending SQL and verifier-only plans through the publication lifecycle in their exact mode',
  () =>
    Effect.gen(function* cliUsesMigrationLifecycle() {
      const filesystem = yield* FileSystem.FileSystem;
      const appDirectory = yield* filesystem.realPath(fileURLToPath(new URL('../../', import.meta.url)));
      const directory = yield* filesystem.makeTempDirectoryScoped({ prefix: 'migration-cli-lifecycle-' });
      const evidenceDirectory = yield* filesystem.makeTempDirectoryScoped({ prefix: 'migration-cli-evidence-' });
      yield* filesystem.chmod(evidenceDirectory, 0o700);
      const intent = yield* Schema.decodeEffect(Schema.fromJsonString(ApplicationReleaseIntentSchema))(
        yield* filesystem.readFileString(`${appDirectory}/${INTENT_FILE}`),
      );
      const { composition } = yield* makeApplicationCompositionSnapshotFixture();
      const candidateFile = `${directory}/candidate.json`;
      const expectedCompositionFile = `${directory}/expected.json`;
      const selectionFile = `${directory}/selection.json`;
      const zeropsYamlPath = `${appDirectory}/zerops.yaml`;
      yield* filesystem.writeFileString(
        candidateFile,
        JSON.stringify({
          baseline: { retainedModuleAppIds: [], revision: BASELINE_REVISION, shellMode: 'fresh' },
          modules: [],
          shell: {
            deployment: composition.shell.deployment,
            federationManifest: composition.shell.federationManifest,
            runtimeContract: composition.shell.runtimeContract,
          },
        }),
      );
      yield* filesystem.writeFileString(expectedCompositionFile, JSON.stringify(composition));
      yield* filesystem.writeFileString(
        selectionFile,
        JSON.stringify({
          complete: [],
          fresh: [],
          migrationRequirements: intent.migrationRequirements,
          removed: [],
          retained: [],
          shell: {
            mode: 'fresh',
            unit: {
              id: 'shell-super-app',
              packageName: 'shell-super-app',
              path: 'apps/shell-super-app',
              workerName: 'shell',
            },
          },
        }),
      );

      const [runtimeUrl, adminUrl] = yield* Effect.all([
        Config.String('DATABASE_URL'),
        Config.String('DATABASE_ADMIN_URL'),
      ]);
      const connections = yield* parseDatabaseConnectionPair({
        DATABASE_ADMIN_URL: adminUrl,
        DATABASE_URL: runtimeUrl,
      });
      const observer = yield* makeCoreDatabase(connections.admin);
      expect(yield* observer.executor.select().from(applicationCompositionAuthority)).toEqual([]);
      yield* Effect.addFinalizer(() =>
        observer.executor
          .delete(applicationCompositionAuthority)
          .where(eq(applicationCompositionAuthority.authorityKey, 'active'))
          .pipe(Effect.orDie),
      );
      const setAuthority = Effect.fn(function* setAuthority(revision: string, phase: 'active' | 'migrated') {
        const now = yield* DateTime.nowAsDate;
        const authority = {
          authorityKey: 'active',
          durableWorkAdmission: 'open' as const,
          phase,
          revision,
          subscriptionsJson: [],
          validUntil: DateTime.makeUnsafe(now).pipe(DateTime.add({ hours: 1 }), DateTime.toDateUtc),
        };
        yield* observer.executor
          .insert(applicationCompositionAuthority)
          .values(authority)
          .onConflictDoUpdate({ set: authority, target: applicationCompositionAuthority.authorityKey });
      });
      const readAuthority = observer.executor
        .select({ phase: applicationCompositionAuthority.phase, revision: applicationCompositionAuthority.revision })
        .from(applicationCompositionAuthority);
      const journalSize = observer.executor
        .execute<{ readonly entries: number }>(
          sql`select count(*)::int as entries from drizzle."__drizzle_migrations_core"`,
          'objects',
        )
        .pipe(Effect.map(([row]) => row?.entries));
      // Native Core evidence decides the mode: the newest journaled Core migration is temporarily
      // pending, then restored byte-for-byte for the next suite on this lane database.
      const withNewestCoreMigrationPending = <Value, Failure, Requirements>(
        effect: Effect.Effect<Value, Failure, Requirements>,
      ) =>
        Effect.acquireUseRelease(
          observer.executor
            .execute<{ readonly row: string }>(
              sql`delete from drizzle."__drizzle_migrations_core" as journal
                where journal.id = (select max(id) from drizzle."__drizzle_migrations_core")
                returning to_jsonb(journal)::text as row`,
              'objects',
            )
            .pipe(
              Effect.flatMap(([removed]) =>
                removed === undefined ? Effect.die('The lane Core journal must be migrated') : Effect.succeed(removed),
              ),
            ),
          () => effect,
          (removed) =>
            observer.executor
              .execute(
                sql`insert into drizzle."__drizzle_migrations_core"
                  select * from jsonb_populate_record(null::drizzle."__drizzle_migrations_core", ${removed.row}::jsonb)`,
                'objects',
              )
              .pipe(Effect.orDie),
        );

      const runMigrateCli = Effect.fn(function* runMigrateCli() {
        const deployments: Deployment[] = [];
        const requests: string[] = [];
        const spawner = recordingDeploymentTool(deployments);
        const exit = yield* main.pipe(
          Effect.provide(
            Layer.mergeAll(
              spawner,
              OpsShellLive.pipe(Layer.provide(spawner)),
              zeropsStopProtocol(requests),
              Reactivity.layer,
              Stdio.layerTest({
                args: Effect.succeed([
                  'migrate',
                  '--environment',
                  'lifecycle-cli-test',
                  '--intent-file',
                  INTENT_FILE,
                  '--candidate-file',
                  candidateFile,
                  '--expected-composition-file',
                  expectedCompositionFile,
                  '--selection-file',
                  selectionFile,
                  '--project-id',
                  PROJECT_ID,
                  '--service-id',
                  SERVICE_ID,
                  '--version-name',
                  VERSION_NAME,
                  ZEROPS_YAML_FLAG,
                  zeropsYamlPath,
                ]),
              }),
              ConfigProvider.layer(
                ConfigProvider.fromUnknown({
                  DATABASE_ADMIN_URL: adminUrl,
                  DATABASE_URL: runtimeUrl,
                  ONTOS_LEGACY_COMPLETION_EVIDENCE_DIRECTORY: evidenceDirectory,
                  ZEROPS_TOKEN,
                }),
              ),
            ),
          ),
          Effect.provide(NodeServices.layer),
          Effect.scoped,
          Effect.exit,
        );
        return { deployments, exit, requests };
      });
      const expectVerifierOnlyDeployment = Effect.fn(function* expectVerifierOnlyDeployment(
        run: Effect.Success<ReturnType<typeof runMigrateCli>>,
      ) {
        expect(Exit.isSuccess(run.exit)).toBe(true);
        const [deployment] = run.deployments;
        expect(run.deployments).toHaveLength(1);
        if (deployment === undefined) {
          return yield* Effect.die('The verifier-only migrator must be deployed');
        }
        expect(deployment.providerPath).not.toBe(zeropsYamlPath);
        expect(
          deployment.args.map((argument) => (argument === deployment.providerPath ? PROVIDER_COPY : argument)),
        ).toEqual([
          'push',
          '--working-dir',
          '.',
          ZEROPS_YAML_FLAG,
          PROVIDER_COPY,
          '--workspace-state',
          'clean',
          '--deploy-git-folder',
          '--project-id',
          PROJECT_ID,
          '--service-id',
          SERVICE_ID,
          '--setup',
          'migrator',
          '--version-name',
          VERSION_NAME,
        ]);
        const provider = yield* Schema.decodeUnknownEffect(ProviderCopySchema)(parse(deployment.provider));
        expect(provider.zerops.find(({ setup }) => setup === 'migrator')?.run?.envVariables).toMatchObject({
          [MIGRATION_REQUIREMENTS_ENV]: INTENT_FILE,
          [MIGRATION_VERIFY_ONLY_ENV]: 'true',
        });
        expect(run.requests).toEqual([
          `PUT /api/rest/public/service-stack/${SERVICE_ID}/stop`,
          `GET /api/rest/public/process/${STOP_PROCESS_ID}`,
          `GET /api/rest/public/service-stack/${SERVICE_ID}`,
        ]);
        return yield* Effect.void;
      });
      const expectRefusedBeforeDeployment = (run: Effect.Success<ReturnType<typeof runMigrateCli>>, reason: string) => {
        const failure = Option.getOrUndefined(Exit.findErrorOption(run.exit));
        expect(Schema.is(ApplicationCompositionAuthorityError)(failure)).toBe(true);
        expect(failure).toMatchObject({ reason });
        expect(run.deployments).toEqual([]);
        expect(run.requests).toEqual([]);
      };

      // A completed migration at the captured baseline is settled: verification may repeat.
      yield* setAuthority(BASELINE_REVISION, 'migrated');
      yield* expectVerifierOnlyDeployment(yield* runMigrateCli());
      expect(yield* readAuthority).toEqual([{ phase: 'migrated', revision: BASELINE_REVISION }]);

      // The same authority with native pending Core SQL takes the migrate mode, which refuses
      // another migration before deploying anything or changing the journal.
      const completeJournal = yield* journalSize;
      const pendingRun = yield* withNewestCoreMigrationPending(
        Effect.gen(function* migrateWithPendingCoreSql() {
          const run = yield* runMigrateCli();
          expect(yield* journalSize).toBe((completeJournal ?? 0) - 1);
          return run;
        }),
      );
      expectRefusedBeforeDeployment(pendingRun, MIGRATION_ALREADY_COMPLETED);
      expect(yield* journalSize).toBe(completeJournal);
      expect(yield* readAuthority).toEqual([{ phase: 'migrated', revision: BASELINE_REVISION }]);

      // The lifecycle receives the exact captured baseline and target revisions.
      yield* setAuthority(FOREIGN_REVISION, 'migrated');
      expectRefusedBeforeDeployment(yield* runMigrateCli(), BASELINE_MOVED);
      yield* setAuthority(composition.revision, 'active');
      yield* expectVerifierOnlyDeployment(yield* runMigrateCli());
      expect(yield* readAuthority).toEqual([{ phase: 'active', revision: composition.revision }]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
