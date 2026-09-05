// expect-count: 8
// Evasion probe: the same hand-written narrowing spelled through a destructured `_tag`, a renamed
// destructuring and a local alias. The sibling rules `no-raw-effect-adt-tag-check`
// (invalid/packages/core-runtime/src/evasion-indirection.ts) and `prefer-match-over-tag-switch`
// (invalid/apps/shell-super-app/api/evasion-indirect-tag.ts) both treat this indirection as in
// scope, so the rule that owns *domain* tags in predicate position must too.
interface Failure {
  readonly _tag: string;
}

export const viaDestructuring = (error: Failure): string => {
  const { _tag } = error;
  return _tag === "ContactsUnavailableProblem" ? "unavailable" : "other";
};

export const viaRenamedDestructuring = (error: Failure): string => {
  const { _tag: classification } = error;
  return classification === "ContactsCustomerNotFound" ? "missing" : "other";
};

export const viaLocalAlias = (error: Failure): boolean => {
  const tag = error._tag;
  return tag === "ContactsGatewayProblem" || tag.startsWith("Contacts");
};

export const viaNestedDestructuring = (error: { readonly reason: Failure }): string => {
  const {
    reason: { _tag },
  } = error;
  return _tag === "ContactsRequestInvalidProblem" ? "invalid" : "other";
};

/** A destructured *parameter* is the same narrowing written in the signature. */
export const viaParameterPattern = ({ _tag }: Failure): boolean => _tag === "ContactsTimeoutProblem";

/** A `for...of` head binds the tag just as a `const` does. */
export const countUnavailable = (failures: readonly Failure[]): number => {
  let total = 0;
  for (const { _tag: kind } of failures) {
    if (kind === "ContactsUnavailableProblem") total += 1;
  }
  return total;
};

/** A `catch` clause pattern is a binding too. */
export const classifyThrown = (run: () => void): string => {
  try {
    run();
    return "ok";
  } catch ({ _tag }: any) {
    return _tag === "ContactsGatewayProblem" ? "gateway" : "other";
  }
};
