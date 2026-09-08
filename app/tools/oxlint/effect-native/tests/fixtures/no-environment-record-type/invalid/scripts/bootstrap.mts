// expect-count: 4
import type { ReadonlyRecord } from 'effect/Record';

export type LocalDevelopmentEnvironment = Readonly<Record<string, string | undefined>>;

export type LooseEnvironment = ReadonlyRecord<string, (string) | (undefined)>;

export const readAll = (environment: { [name: string]: string | undefined | null }): readonly string[] =>
	Object.keys(environment);

export type ShellEnvironment = typeof globalThis.process.env;
