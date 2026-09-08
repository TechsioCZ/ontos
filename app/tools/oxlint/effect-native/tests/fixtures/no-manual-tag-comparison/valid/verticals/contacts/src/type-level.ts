/** Type-level `_tag` is the Schema-owned vocabulary itself, never a hand-written comparison. */
export interface ContactsProblem {
  readonly _tag: "ContactsUnavailableProblem" | "ContactsCustomerNotFound";
}

export type Narrow<P extends { readonly _tag: string }> = Exclude<P, { readonly _tag: "ContactsCustomerNotFound" }>;

export type TagOf<P extends { readonly _tag: string }> = P["_tag"];

export type ClassificationInput<Failure> = Failure extends { readonly _tag: infer Tag extends string }
  ? { readonly _tag: Tag }
  : never;

/** Constructing, reading and destructuring a tag are all fine; only hand-written narrowing is not. */
export const build = (tag: ContactsProblem["_tag"]): ContactsProblem => ({ _tag: tag });

export const readTag = ({ _tag }: ContactsProblem): string => _tag;

export const annotate = (problem: ContactsProblem) => ({ failureTag: problem._tag });

/** A discriminant that is not `_tag` is out of scope for this rule. */
export const byKind = (value: { readonly kind: string }): boolean => value.kind === "unavailable";
