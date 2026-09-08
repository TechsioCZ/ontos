// expect-count: 3
interface Problem {
  readonly _tag: string;
}

const known = ["ShellTargetNotFoundProblem"];

/**
 * Loose equality and a hand-maintained membership array are the same anti-pattern: `known` is a
 * second, unchecked copy of the union's vocabulary, so both halves report.
 */
export const isKnown = (problem: Problem): boolean =>
  problem._tag == "ShellTargetNotFoundProblem" || known.includes(problem._tag);

export const hasTag = (value: object): boolean => "_tag" in value;
