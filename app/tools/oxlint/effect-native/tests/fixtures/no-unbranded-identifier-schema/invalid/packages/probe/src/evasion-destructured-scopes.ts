// expect-count: 3
import { Schema } from "effect";
import { Struct, String as Str } from "effect/Schema";
export const first = Struct({ tenantId: Str });
export function second() {
  const { Struct, String: Str } = Schema;
  return Struct({ accountId: Str });
}
export function third() {
  const { Struct, String: Str } = Schema;
  return Struct({ memberId: Str });
}
