// expect-count: 5
// Aliases hidden in function bodies, arrow bodies, class static blocks, methods and async
// generators are the same closed vocabulary, just harder to grep for.
export function decide(): string {
  type LocalDecision = 'allow' | 'deny';
  const value: LocalDecision = 'allow';
  return value;
}

export const pick = (): string => {
  type ArrowFilter = 'active' | 'all' | 'archived';
  const value: ArrowFilter = 'all';
  return value;
};

export class Gate {
  static {
    type StaticPhase = 'start' | 'stop';
    const phase: StaticPhase = 'start';
    void phase;
  }

  method(): string {
    type MethodOutcome = 'failure' | 'success';
    const outcome: MethodOutcome = 'success';
    return outcome;
  }
}

export async function* stream(): AsyncGenerator<string> {
  type ChunkKind = 'data' | 'end';
  const kind: ChunkKind = 'data';
  yield kind;
}
