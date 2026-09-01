export interface SpiceDbDatabaseBootstrapConfig {
  readonly adminUrl: string;
  readonly database: 'spicedb';
  readonly password: string;
  readonly user: 'spicedb';
}

const parsePostgresUrl = (name: string, value: string | undefined): URL => {
  const candidate = value?.trim();
  if (candidate === undefined || candidate.length === 0) {
    throw new Error(`${name} is required`);
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(`${name} must be a valid PostgreSQL URL`);
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error(`${name} must use PostgreSQL`);
  }
  return parsed;
};

export const parseSpiceDbDatabaseBootstrapConfig = (
  environment: Readonly<Record<string, string | undefined>>,
): SpiceDbDatabaseBootstrapConfig => {
  const admin = parsePostgresUrl('DATABASE_ADMIN_URL', environment['DATABASE_ADMIN_URL']);
  const spicedb = parsePostgresUrl('SPICEDB_DATABASE_URL', environment['SPICEDB_DATABASE_URL']);

  if (spicedb.hostname !== admin.hostname || spicedb.port !== admin.port) {
    throw new Error('SPICEDB_DATABASE_URL must target the administrative PostgreSQL service');
  }
  if (decodeURIComponent(spicedb.username) !== 'spicedb' || spicedb.pathname !== '/spicedb') {
    throw new Error('SPICEDB_DATABASE_URL must use the spicedb login and database');
  }
  if (spicedb.password.length === 0) {
    throw new Error('SPICEDB_DATABASE_URL must contain the spicedb password');
  }
  if (admin.href === spicedb.href || admin.username === spicedb.username) {
    throw new Error('Administrative and SpiceDB PostgreSQL identities must be distinct');
  }

  return {
    adminUrl: admin.href,
    database: 'spicedb',
    password: decodeURIComponent(spicedb.password),
    user: 'spicedb',
  };
};
