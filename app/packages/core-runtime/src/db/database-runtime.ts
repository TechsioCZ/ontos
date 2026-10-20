import type { ConfigProvider, Effect } from 'effect';

import type { DatabaseConfigError } from './config-error.ts';
import type { DatabaseIdentity } from './database-identities.ts';

/**
 * Where the running platform takes a runtime identity's connection URL from. `#database-runtime`
 * selects it by runtime: Node reads the process environment; a Worker takes it from the identity's
 * Hyperdrive binding.
 */
export interface DatabaseRuntime {
  /** Layers the identity's platform connection URL over the process configuration. */
  readonly runtimeDatabaseProvider: (
    base: ConfigProvider.ConfigProvider,
    identity: DatabaseIdentity,
  ) => Effect.Effect<ConfigProvider.ConfigProvider, DatabaseConfigError>;
}
