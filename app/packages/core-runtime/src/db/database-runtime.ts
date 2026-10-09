import type { ConfigProvider, Effect } from 'effect';

import type { DatabaseConfigError } from './config-error.ts';

/**
 * Where the running platform's runtime `DATABASE_URL` comes from. `#database-runtime` selects it by
 * runtime: Node reads the process environment; a Worker takes it from its `HYPERDRIVE` binding.
 */
export interface DatabaseRuntime {
  /** Layers the platform's runtime `DATABASE_URL` over the process configuration. */
  readonly runtimeDatabaseProvider: (
    base: ConfigProvider.ConfigProvider,
  ) => Effect.Effect<ConfigProvider.ConfigProvider, DatabaseConfigError>;
}
