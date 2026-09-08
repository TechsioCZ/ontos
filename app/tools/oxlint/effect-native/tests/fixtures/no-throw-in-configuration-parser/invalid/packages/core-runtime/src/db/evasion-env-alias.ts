// expect-count: 3
// A3 evasion: the ambient bag is aliased to a module-scope local whose name does not match
// `environmentIdentifiers`. Every read inside the parsers below is still `process.env`.
const secrets = process.env;

export const parseDatabaseAdminUrl = (): string => {
  const url = secrets['DATABASE_ADMIN_URL'];
  if (url === undefined || url.length === 0) {
    throw new Error('DATABASE_ADMIN_URL is required');
  }
  if (!url.startsWith('postgres:')) {
    throw new Error('DATABASE_ADMIN_URL must use PostgreSQL');
  }
  return url;
};

export const parsePoolSize = (): number => {
  const raw = secrets?.['DATABASE_POOL_SIZE'];
  const size = Number(raw ?? '10');
  if (!Number.isSafeInteger(size) || size < 1) {
    throw new RangeError('DATABASE_POOL_SIZE must be a positive integer');
  }
  return size;
};
