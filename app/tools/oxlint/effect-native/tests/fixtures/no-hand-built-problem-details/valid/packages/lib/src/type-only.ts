// Type-level declarations belong to effect-native/no-hand-rolled-tagged-union, not to this rule.
export interface ShellProblem {
  readonly _tag: 'ShellUnavailableProblem';
  readonly detail: string;
  readonly retryable: true;
  readonly status: 503;
  readonly title: string;
  readonly type: string;
}

export type GatewayProblem = {
  readonly _tag: 'GatewayInternalProblem';
  readonly status: 500;
  readonly title: string;
};

declare const problem: ShellProblem;

// Destructuring a status out of an existing typed problem is a read, not a declaration.
export const { status, title } = problem;
