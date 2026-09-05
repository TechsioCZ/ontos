import { Effect, Match, Predicate, Schema } from "effect";

class ContactsCustomerNotFound extends Schema.TaggedError<ContactsCustomerNotFound>()(
  "ContactsCustomerNotFound",
  {},
) {}

/** The Effect-native replacements this rule asks for. */
export const classify = (error: { readonly _tag: string }): string =>
  Match.value(error).pipe(
    Match.tag("HttpClientError", () => "transport"),
    Match.tags({ ContactsUnavailableProblem: () => "unavailable" }),
    Match.orElse(() => "other"),
  );

export const guard = (error: unknown): boolean => Schema.is(ContactsCustomerNotFound)(error);

export const tagged = (error: unknown): boolean => Predicate.isTagged(error, "ContactsCustomerNotFound");

export const recover = <A>(program: Effect.Effect<A, { readonly _tag: "AresSubjectThrottled" }>) =>
  program.pipe(
    Effect.catchTag("AresSubjectThrottled", () => Effect.succeed(null)),
    Effect.catchTags({ AresSubjectThrottled: () => Effect.succeed(null) }),
  );

/** Object patterns are already the Effect-native form and are never binary comparisons. */
export const patterned = (error: { readonly _tag: string }) =>
  Match.value(error).pipe(
    Match.when({ _tag: "ContactsUnavailableProblem" }, () => "unavailable"),
    Match.orElse(() => "failed"),
  );
