/**
 * Regression fixture for a false positive in `no-sync-schema-codec`.
 *
 * When a file imports a sync codec entry point directly
 * (`import { decodeUnknownSync } from "effect/Schema"`), the `Identifier` visitor reports every
 * identifier of that name that is not in one of the declaration positions listed in
 * `isDeclarationPosition`. That list covers `Property`, `PropertyDefinition`, `MethodDefinition`,
 * `ExportSpecifier` and the import specifiers, but none of the TypeScript type-level nodes, so a
 * *type* that merely declares or names a member called `decodeUnknownSync` is reported even though
 * nothing is decoded and nothing can throw:
 *
 *   - `TSPropertySignature` — an `interface` / type-literal member named `decodeUnknownSync`.
 *     The rule's own header promises that "an object literal *declaring* a `decodeUnknownSync`
 *     property" is allowed; its type-level equivalent must be allowed for the same reason.
 *   - `TSTypeQuery` — `typeof decodeUnknownSync`, a type-only reference that performs no decode.
 *
 * Neither shape performs a synchronous decode, so neither is an A3/A7 instance. The only value
 * reference below is the `export { ... }` re-export, which `isDeclarationPosition` already excludes,
 * so this file must report zero diagnostics.
 */
import { decodeUnknownSync } from "effect/Schema";

export { decodeUnknownSync };

/** Type-only alias: no runtime decode happens here. */
export type DecodeUnknownSync = typeof decodeUnknownSync;

/** A hand-rolled port whose member merely *shares the name*; the key is a declaration, not a call. */
export interface CodecPort {
	readonly decodeUnknownSync: (value: unknown) => unknown;
}

export type CodecPortLiteral = {
	readonly decodeUnknownSync: (value: unknown) => unknown;
};

/** Implementing the port is a `PropertyDefinition`, which the rule already excludes correctly. */
export class HandRolledCodec implements CodecPort {
	readonly decodeUnknownSync = (value: unknown): unknown => value;
}
