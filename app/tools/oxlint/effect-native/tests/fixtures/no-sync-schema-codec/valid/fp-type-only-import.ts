/**
 * Regression fixture for a second false positive in `no-sync-schema-codec`.
 *
 * `collectSchemaLocals` records every `ImportSpecifier` of `effect/Schema` without looking at
 * `importKind`, so a **type-only** import is tracked exactly like a value import. A type-only
 * import is erased before the module runs: no `SchemaError` can escape, no `ParseIssue` can be
 * collapsed, and there is nothing for A3/A7 to migrate. Typing a first-party port against the
 * upstream signature is not the anti-pattern; calling the decoder is.
 *
 * This file must report zero diagnostics.
 */
import type { decodeUnknownSync, encodeUnknownSync } from "effect/Schema";

export type Decode = typeof decodeUnknownSync;
export type Encode = typeof encodeUnknownSync;

export interface CodecSignatures {
	readonly decode: Decode;
	readonly encode: Encode;
}
