/**
 * The SpiceDB connection configuration of the access graph.
 *
 * The access engine and the projection writer reach SpiceDB through this module. The legacy
 * permissions package still hosts the implementation until it is deleted; that deletion moves the
 * implementation here without changing this public surface.
 */
export {
  loadSpiceDbConfig,
  parseSpiceDbConfig,
  SPICEDB_ROOT_ENV_PATH,
  type LoadSpiceDbConfigOptions,
  type SpiceDbConfigValue,
  type SpiceDbEnvironment,
} from '../permissions/config.ts';
