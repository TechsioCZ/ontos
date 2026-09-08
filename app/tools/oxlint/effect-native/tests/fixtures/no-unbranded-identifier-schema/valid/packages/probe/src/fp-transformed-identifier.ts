import { Schema, pipe } from "effect";
import { decodeIdentifier } from "./identifier-codec";

// Encoded strings do not prove decoded values are unbranded strings.
const TenantId = Schema.String.pipe(Schema.brand("TenantId"));
export const TenantIdSchema = Schema.String.pipe(Schema.decodeTo(TenantId));
export const OtherIdSchema = pipe(Schema.String, decodeIdentifier);
export const Payload = Schema.Struct({
  tenantId: Schema.String.pipe(Schema.decodeTo(TenantId)),
  accountId: Schema.String.pipe(decodeIdentifier),
});

// A local function named pipe does not inherit Effect.Function.pipe semantics.
export function local(pipe: (a: unknown, b: unknown) => unknown) {
  return Schema.Struct({ customId: pipe(Schema.String, {}) });
}
