// expect-count: 4
// A3: an environment-record parser plus the file-local helper it exists for, both throwing.
const parsePostgresUrl = (name: string, value: string | undefined): URL => {
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  const parsed = new URL(value);
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error(`${name} must use PostgreSQL`);
  }
  return parsed;
};

export interface SpiceDbDatabaseBootstrapConfig {
  readonly adminUrl: string;
  readonly password: string;
}

export const parseSpiceDbDatabaseBootstrapConfig = (
  environment: Readonly<Record<string, string | undefined>>,
): SpiceDbDatabaseBootstrapConfig => {
  const admin = parsePostgresUrl('DATABASE_ADMIN_URL', environment['DATABASE_ADMIN_URL']);
  const spicedb = parsePostgresUrl('SPICEDB_DATABASE_URL', environment['SPICEDB_DATABASE_URL']);

  if (spicedb.hostname !== admin.hostname || spicedb.port !== admin.port) {
    throw new Error('SPICEDB_DATABASE_URL must target the administrative PostgreSQL service');
  }
  if (spicedb.password.length === 0) {
    throw new Error('SPICEDB_DATABASE_URL must contain the spicedb password');
  }

  return { adminUrl: admin.href, password: decodeURIComponent(spicedb.password) };
};
