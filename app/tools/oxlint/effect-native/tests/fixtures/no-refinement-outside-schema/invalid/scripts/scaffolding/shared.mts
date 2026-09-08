// expect-count: 3
export type JsonValue = string | number | boolean | null | { readonly [key: string]: JsonValue } | readonly JsonValue[];
export type JsonObject = { readonly [key: string]: JsonValue };

const isJsonObject = (value: JsonValue): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const isStringValue = (value: JsonValue | undefined): value is string => typeof value === 'string';

export function assertJsonObject(value: JsonValue): asserts value is JsonObject {
  if (!isJsonObject(value)) throw new Error('expected object');
}

export const helpers = { isJsonObject, isStringValue };
