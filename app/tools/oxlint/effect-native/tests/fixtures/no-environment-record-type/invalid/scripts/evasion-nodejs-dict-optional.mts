// expect-count: 2
// `NodeJS.Dict<T>` is `{ [key: string]: T | undefined }`, so an already-optional `T` is still the env bag.
export const readOptional = (environment: NodeJS.Dict<string | undefined>): string | undefined =>
	environment['ONTOS_DATABASE_URL'];

export const readNullable = (environment: NodeJS.Dict<string | null>): string | null | undefined =>
	environment['ONTOS_GATEWAY_ISSUER'];
