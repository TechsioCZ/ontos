// expect-count: 2
// `(typeof process)['env']` is `typeof process.env` spelled through an indexed access.
export type IndexedEnvironment = (typeof process)['env'];

export type ContainerIndexedEnvironment = (typeof globalThis.process)['env'];

export const read = (environment: IndexedEnvironment, other: ContainerIndexedEnvironment): string | undefined =>
	environment['ONTOS_DATABASE_URL'] ?? other['ONTOS_DATABASE_URL'];
