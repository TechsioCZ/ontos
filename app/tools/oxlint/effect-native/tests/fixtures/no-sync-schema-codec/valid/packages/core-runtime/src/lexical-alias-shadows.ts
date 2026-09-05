import { Schema } from "effect";
const Codec = Schema;
export function local(Codec: { decodeUnknownSync(s: unknown): unknown }) { return Codec.decodeUnknownSync({}); }
import type { validateSync } from "effect/Schema";
export type Validate = typeof validateSync;
export type Port = { readonly decodeUnknownSync: typeof validateSync };
