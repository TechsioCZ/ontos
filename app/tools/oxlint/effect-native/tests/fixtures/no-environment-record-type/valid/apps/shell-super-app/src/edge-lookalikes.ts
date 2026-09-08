/** Dictionary-shaped types that are NOT the optional string-keyed environment bag. */
declare const runtimeConfig: { readonly env: { readonly mode: string } };

export type NumericValues = Record<string, string | number>;
export type AlwaysMissing = Record<string, undefined>;
export type TemplateKeyed = Record<`ONTOS_${string}`, string | undefined>;
export type NumericIndex = { readonly [index: number]: string | undefined };
export type MixedIndex = { readonly [key: string]: string | number | undefined };
export type OptionalValues = Map<string, string | undefined>;
export type ReadonlyOptionalValues = ReadonlyMap<string, string | undefined>;
export type DictOfNumbers = NodeJS.Dict<number>;
export type WholeProcess = typeof process;
export type LocalEnvObject = typeof runtimeConfig.env;
export type FilePath = import('node:fs').PathLike;
export type ProcessModule = typeof import('node:process');

export const inspect = (values: NumericValues, missing: AlwaysMissing, keyed: TemplateKeyed): number =>
	Object.keys(values).length + Object.keys(missing).length + Object.keys(keyed).length;
