// expect-count: 8
import { Predicate } from "effect";

interface ContactsProblem {
  readonly _tag: string;
}

/** Prefix/suffix probes turn a closed vocabulary into a naming convention. */
export const isContactsProblem = (error: { readonly _tag: string }): error is ContactsProblem =>
  error._tag.startsWith("Contacts") && error._tag.endsWith("Problem");

export const looksTagged = (value: unknown): boolean =>
  Predicate.isObjectKeyword(value) && value !== null && "_tag" in value;

/** Shape test plus computed access — both are hand-written narrowing. */
export const isUnavailable = (error: { readonly _tag: string }): boolean =>
  "_tag" in error && error["_tag"] === "ContactsUnavailableProblem";

/**
 * Three probes, three reports: the tag as receiver (`.includes`), the tag as the *argument* of a
 * regex probe (`/Problem$/u.test(error._tag)` — the mirrored spelling of the same naming
 * convention), and `.match`.
 */
export const probes = (error: { readonly _tag: string }): boolean =>
  error._tag.includes("Customer") || /Problem$/u.test(error._tag) || error._tag.match(/^Contacts/u) !== null;
