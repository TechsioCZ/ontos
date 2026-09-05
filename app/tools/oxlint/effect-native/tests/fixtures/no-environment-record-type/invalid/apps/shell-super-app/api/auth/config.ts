// expect-count: 5
export type GatewayEnvironment = typeof process.env;

export const parseIssuer = (environment: NodeJS.ProcessEnv): string | undefined =>
	environment['ONTOS_GATEWAY_ISSUER'];

export const parseKeys = (environment: NodeJS.Dict<string>): string | undefined =>
	environment['ONTOS_GATEWAY_PUBLIC_JWKS'];

export interface AuthConfigOptions {
	readonly environment: Readonly<Record<string, string | undefined>>;
	readonly overrides: { readonly [key: string]: string | undefined };
}
