/** `switch (error._tag)` exhaustiveness is `prefer-match-over-tag-switch`'s concern, not this rule's. */
export const label = (error: { readonly _tag: string }): string => {
  switch (error._tag) {
    case "ShellTargetNotFoundProblem":
      return "not-found";
    case "ShellTargetForbiddenProblem":
      return "forbidden";
    default:
      return "other";
  }
};

/** Comparing two discriminants is an identity test, not a case analysis. */
export const sameTag = (a: { readonly _tag: string }, b: { readonly _tag: string }): boolean => a._tag === b._tag;

/** String methods on something that is not a `_tag` access. */
export const known = ["ShellTargetNotFoundProblem"];
export const isKnown = (error: { readonly _tag: string }): boolean => known.includes(error.toString());
export const probeOther = (error: { readonly reason: string }): boolean => error.reason.startsWith("Shell");

/** A property literally named `_tag` in an object literal or key position never reports. */
export const keys = { _tag: "ShellTargetNotFoundProblem" } as const;
export const inOther = (value: object): boolean => "reason" in value;
