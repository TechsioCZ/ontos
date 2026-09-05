// expect-count: 2
// A class that hand-rolls the discriminant is the same second authority as the interface form, and
// the rule's own message points at Schema.TaggedClass. Neither class derives from Schema/Data.
export class HandRolledProblem {
  readonly _tag = 'HandRolledProblem' as const;
  constructor(readonly status: number) {}
}

export abstract class AbstractProblem {
  abstract readonly _tag: 'AbstractProblem';
}
