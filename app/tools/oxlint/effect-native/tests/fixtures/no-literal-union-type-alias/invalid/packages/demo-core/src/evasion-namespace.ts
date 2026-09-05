// expect-count: 2
// A non-ambient `namespace` is first-party code we own: a closed vocabulary declared inside one is
// the same B5 duplication as one at module top level, and must still report.
export namespace OutboxVocabulary {
  export type OutboxFailureStatus = 'dead' | 'pending';
}

namespace Nested {
  export namespace Deep {
    export type ModuleStateDecision = 'allow' | 'deny';
  }
}

export const nestedDecision: Nested.Deep.ModuleStateDecision = 'allow';
