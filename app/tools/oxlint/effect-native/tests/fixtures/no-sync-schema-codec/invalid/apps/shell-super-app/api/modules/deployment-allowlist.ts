// expect-count: 3
// Aliased import plus a point-free reference: both are the same A7 sync-decode seam.
import { Schema as S } from 'effect';

const JsonObjectSchema = S.Record(S.String, S.Unknown);

export const asJsonObject = (value: unknown): Record<string, unknown> =>
	S.decodeUnknownSync(JsonObjectSchema)(value);

/** Point-free: the throwing decoder is stored and applied later. */
export const decodeAllowlist = S.decodeUnknownSync(JsonObjectSchema);

export const encodeAllowlist = (value: Record<string, unknown>): unknown =>
	[value].map(S.encodeUnknownSync(JsonObjectSchema))[0];
