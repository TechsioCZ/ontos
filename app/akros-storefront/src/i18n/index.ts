import { cs } from "./cs";
import { en } from "./en";
import { sk } from "./sk";

/** Same keys as the Czech dictionary, with any (translated) string value. */
type Widen<T> = T extends string
  ? string
  : T extends (...args: infer A) => infer R
    ? (...args: A) => Widen<R>
    : T extends readonly (infer U)[]
      ? readonly Widen<U>[]
      : { readonly [K in keyof T]: Widen<T[K]> };
export type Dictionary = Widen<typeof cs>;

const dictionaries: Readonly<Record<string, Dictionary>> = { cs, sk, en };

/**
 * UI chrome strings of a market locale (`cs`, `sk`, `en`); any other locale (e.g. `de` before a German
 * dictionary exists) falls back to English. Product content stays as stored in OntOS.
 */
export const dictionaryFor = (locale: string | undefined): Dictionary =>
  dictionaries[dictionaryLanguage(locale)] ?? en;
/** The language the chrome of `locale` is shown in (`<html lang>` of pages without a market). */
export const dictionaryLanguage = (locale: string | undefined): string =>
  locale !== undefined && Object.hasOwn(dictionaries, locale) ? locale : "en";
