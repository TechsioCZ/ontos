import { PgClient } from '@effect/sql-pg';
import { Context, Effect, Layer, Option, Redacted, Scope } from 'effect';

import { guardedPgClientLayer } from '../db/client.ts';
import { loadDatabaseConfig } from '../db/config.ts';
import { SHARED_RUNTIME_IDENTITY } from '../db/database-identity-manifest.ts';
import { DRIVER_DEFAULT_MAX_CONNECTIONS, configureDatabasePool } from '../db/pool-configuration.ts';
import { ActiveApplicationCompositionService } from '../modules/active-application-composition.ts';
import { buildApplicationCompositionCatalog } from '../modules/application-composition-catalog.ts';
import { loadSpiceDbConfig } from '../permissions/config.ts';
import { openSpiceDbRpc } from '../permissions/spicedb-transaction-guard.ts';
import {
  BootWarmUpStepFailed,
  asBootWarmUpStep,
  compositionWarmUp,
  databasePoolWarmUp,
  importsWarmUp,
  runBootWarmUp,
  spiceDbWarmUp,
} from './boot-warm-up.ts';
import type { BootWarmUpBudget, BootWarmUpStep } from './boot-warm-up.ts';

const SPICEDB_WARM_UP_DEADLINE_MS = 4000;

/**
 * The shared runtime role's pool from the process registry, through the guarded client every Core database uses, held
 * by the process scope: the registry closes a pool when its last holder leaves, and the requests that come later must
 * find these sessions open. Same URL and settings as the requests' clients, so the same registry key and native pool.
 * With `ONTOS_DATABASE_POOL_MIN_CONNECTIONS` the pool opens its minimum itself when created here and keeps it past the
 * idle timeout; the `select 1` statements then only confirm those sessions.
 */
const sharedRuntimePool = Effect.fn('BootWarmUp.sharedRuntimePool')(function* openSharedRuntimePool(
  processScope: Scope.Scope,
) {
  const database = yield* loadDatabaseConfig({ identity: SHARED_RUNTIME_IDENTITY });
  const connectionString = Redacted.make(database.connectionString);
  const configuration = yield* configureDatabasePool(connectionString);
  if (!configuration.processShared) {
    return Option.none();
  }
  const services = yield* Layer.build(guardedPgClientLayer(connectionString, { pooling: 'pooled' })).pipe(
    Scope.provide(processScope),
  );
  const client = Context.get(services, PgClient.PgClient);
  return Option.some({
    maxConnections: configuration.maxConnections ?? DRIVER_DEFAULT_MAX_CONNECTIONS,
    run: (statement: string) => client.unsafe(statement),
  });
});

/** A SpiceDB client over the transport the requests use, closed when the step ends. */
const spiceDbClient = Effect.gen(function* openWarmUpSpiceDb() {
  const configuration = yield* loadSpiceDbConfig();
  return yield* Effect.acquireRelease(
    Effect.try({
      catch: (cause) => new BootWarmUpStepFailed({ cause: Redacted.make(cause), step: 'spicedb' }),
      try: () => openSpiceDbRpc(configuration, SPICEDB_WARM_UP_DEADLINE_MS),
    }),
    (rpc) => Effect.sync(() => rpc.close()),
  );
});

/** The lazy imports the units registered (`registerBootWarmUpImport`), read when the step runs. */
const registeredImports = Effect.sync(() => [...(globalThis.ontosBootWarmUpImports ?? [])]);

export interface NodeHostBootWarmUpOptions {
  readonly budget?: BootWarmUpBudget;
}

/**
 * The boot warm-up of a Node process host that serves units (`scripts/zerops/serve-units.mts`), run in the background
 * by its caller, which provides the active composition source the units read. Once the host's composition is
 * published it opens two sessions of the shared runtime pool with `select 1`, reads the SpiceDB schema, loads the
 * snapshot through the process-shared source reads and builds its catalog, and loads the modules its units registered
 * as lazy imports. It writes nothing and decides nothing; it never fails.
 */
export const nodeHostBootWarmUp = Effect.fn('BootWarmUp.nodeHost')(function* nodeHostBootWarmUp(
  options: NodeHostBootWarmUpOptions = {},
): Effect.fn.Return<void, never, ActiveApplicationCompositionService | Scope.Scope> {
  const processScope = yield* Effect.scope;
  const composition = yield* ActiveApplicationCompositionService;
  const steps: readonly BootWarmUpStep[] = [
    databasePoolWarmUp(sharedRuntimePool(processScope)),
    spiceDbWarmUp(spiceDbClient),
    compositionWarmUp(composition.load, buildApplicationCompositionCatalog),
    importsWarmUp(registeredImports),
  ];
  return yield* runBootWarmUp({ serving: asBootWarmUpStep('serving')(composition.load), steps }, options.budget);
});
