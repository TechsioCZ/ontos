// Ambient contracts describe externally owned types; runtime Schemas cannot replace them.
declare interface AmbientProblem {
  readonly _tag: 'AmbientProblem';
}

declare global {
  interface GlobalProblem {
    readonly _tag: 'GlobalProblem';
  }
}

declare module 'external-thing' {
  interface AugmentedProblem {
    readonly _tag: 'AugmentedProblem';
  }
}

export type { AmbientProblem };
