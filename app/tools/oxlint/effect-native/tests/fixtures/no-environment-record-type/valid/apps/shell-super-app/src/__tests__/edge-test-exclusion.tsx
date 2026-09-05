/** Every violation at once, inside a `__tests__/` directory: `ignoreTestFiles` must keep this silent. */
type Environment = Readonly<Record<string, string | undefined>>;

export const stub: Environment = {};

export const readStub = (environment: NodeJS.ProcessEnv, dict: NodeJS.Dict<string>): string | undefined =>
	environment['ONTOS_DATABASE_URL'] ?? dict['ONTOS_GATEWAY_ISSUER'];

export type Ambient = typeof process.env;

export interface Overrides {
	readonly [key: string]: string | undefined;
}

export const Badge = ({ overrides }: { readonly overrides: Overrides }) => <span>{overrides['A'] ?? ''}</span>;
