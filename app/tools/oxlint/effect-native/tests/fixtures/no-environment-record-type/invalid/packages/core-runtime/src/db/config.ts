// expect-count: 1
// The canonical A3 shape: one alias declaration is the whole configuration authority, and every
// consumer below re-derives `undefined` handling by hand. The alias *references* must not report.
type Environment = Readonly<Record<string, string | undefined>>;

export interface DatabaseConfigOptions {
	readonly environment?: Environment;
}

export const readDatabaseUrl = (environment: Environment): string => {
	const value = environment['ONTOS_DATABASE_URL'];
	if (value === undefined) throw new Error('ONTOS_DATABASE_URL is not set');
	return value;
};

export const readPoolSize = (environment: Environment): number =>
	Number.parseInt(environment['ONTOS_DATABASE_POOL_SIZE'] ?? '10', 10);
