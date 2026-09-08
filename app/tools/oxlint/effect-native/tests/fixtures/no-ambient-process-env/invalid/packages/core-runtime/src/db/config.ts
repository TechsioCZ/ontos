// expect-count: 6
// A3: hand-parsed database configuration read straight off the ambient environment.
export const databaseUrl = process.env["DATABASE_URL"]?.trim();

export const poolSize = Number(process.env.DB_POOL_SIZE ?? "10");

export const load = (environment: Record<string, string | undefined> = process.env): string | undefined =>
	environment["PGHOST"];

const { DATABASE_PASSWORD, PGUSER } = process.env;

export const sslMode = process?.env?.SSL_MODE;

export const nodeEnvironment = globalThis.process.env.NODE_ENV;

export const credentials = { DATABASE_PASSWORD, PGUSER };
