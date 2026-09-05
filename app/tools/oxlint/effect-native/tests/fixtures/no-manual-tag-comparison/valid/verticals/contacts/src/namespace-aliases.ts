import * as EffectNs from "effect/Effect";
import { Match as M, Schema as S } from "effect";

class ContactsUnavailable extends S.TaggedError<ContactsUnavailable>()("ContactsUnavailableProblem", {}) {}

/** Aliased and namespace-imported Effect modules still resolve to the Effect-native forms. */
export const recover = <A>(program: EffectNs.Effect<A, ContactsUnavailable>) =>
  EffectNs.catchTag(program, "ContactsUnavailableProblem", () => EffectNs.succeed(null));

export const classify = (error: unknown): string =>
  S.is(ContactsUnavailable)(error) ? "unavailable" : M.value(error).pipe(M.orElse(() => "other"));
