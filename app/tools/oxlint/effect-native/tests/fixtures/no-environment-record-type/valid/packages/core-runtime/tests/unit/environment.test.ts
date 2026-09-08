/** Tests are excluded by default (`ignoreTestFiles: true`), so these must not report. */
type Environment = Readonly<Record<string, string | undefined>>;

export const stubEnvironment: Environment = { ONTOS_DATABASE_URL: 'postgres://localhost/ontos' };

export const readStub = (environment: NodeJS.ProcessEnv): string | undefined => environment['ONTOS_DATABASE_URL'];

export type StubProcessEnvironment = typeof process.env;

export interface StubOverrides {
	readonly [key: string]: string | undefined;
}
