export {
  PrincipalBindingAmbiguousError,
  PrincipalBindingInactiveError,
  PrincipalBindingMissingError,
  PrincipalInactiveError,
  PrincipalResolverUnavailableError,
  TenantInactiveError,
} from './auth/principal-resolver-errors.ts';
export type { PrincipalResolutionError } from './auth/principal-resolver-errors.ts';
export {
  PrincipalResolver,
  PrincipalResolverLive,
  classifyPrincipalResolution,
  makePrincipalResolver,
} from './auth/principal-resolver.ts';
export type {
  PrincipalResolutionRecord,
  PrincipalResolverShape,
  ResolvedPrincipalIdentity,
} from './auth/principal-resolver.ts';
export {
  CoreDatabase,
  CoreDatabaseLive,
  DatabaseConnectionError,
  acquirePoolResource,
  makeCoreDatabase,
} from './db/client.ts';
export {
  DatabaseConfig,
  DatabaseConfigError,
  DatabaseConfigLive,
  ROOT_ENV_PATH,
  loadDatabaseConfig,
  parseDatabaseConfig,
} from './db/config.ts';
export {
  ACTION_AUTH_METHODS,
  ACTION_INVOCATION_STATUSES,
  CORE_SCHEMA_NAME,
  CORE_TABLE_INVENTORY,
  CORE_TABLES,
  actionInvocations,
  coreDatabaseSchema,
} from './db/schema.ts';
export type { CoreDatabaseExecutor, CoreDbExecutor, CoreTransaction } from './db/types.ts';
