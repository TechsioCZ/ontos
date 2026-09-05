// expect-count: 10
// Evasion probe: signature-only and ambient positions, plus predicates on declaration forms TypeScript
// itself rejects but the parser accepts (`async`/generator), inside a `.mts` script.
export interface JsonObject {
  readonly [key: string]: unknown;
}

export declare function isJsonObject(value: unknown): value is JsonObject;
export declare function isJsonObject(value: unknown, strict: boolean): value is JsonObject;

declare module 'ambient-scaffolding' {
  export function isScaffoldCommand(value: unknown): value is string;
}

declare namespace Scaffolding {
  function isReadAuthorization(value: unknown): value is 'public';
}

export type JsonGuard = (value: unknown) => value is JsonObject;
export type GuardTable = { readonly [Key in 'a' | 'b']: (value: unknown) => value is JsonObject };

export interface GuardBag {
  (value: unknown): value is JsonObject;
  readonly nested: (value: unknown) => value is JsonObject;
}

export async function isAsyncJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null;
}

export function* isGeneratedJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null;
}
