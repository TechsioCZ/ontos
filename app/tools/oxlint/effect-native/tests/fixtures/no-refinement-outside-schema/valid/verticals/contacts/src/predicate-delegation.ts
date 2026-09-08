import { Predicate as P } from 'effect';
import { isString } from 'effect/Predicate';

export type LocaleResource = string | { readonly [key: string]: LocaleResource };
export type JsonValue = string | number | boolean | null | { readonly [key: string]: JsonValue } | readonly JsonValue[];

// `verticals/contacts/src/modern.runtime.ts` shape: a named `effect/Predicate` import.
export const isLocaleText = (resource: LocaleResource): resource is string => isString(resource);

// Aliased `Predicate` namespace from the `effect` barrel.
export const isLocaleRecord = (resource: LocaleResource): resource is Record<string, LocaleResource> =>
  P.isRecord(resource);

// "Existing patterns to preserve": `Array.isArray` in recursive JSON normalisation.
export const isJsonArray = (value: JsonValue): value is readonly JsonValue[] => Array.isArray(value);

export const normalise = (value: JsonValue): JsonValue =>
  isJsonArray(value) ? value.map((entry) => normalise(entry)) : value;
