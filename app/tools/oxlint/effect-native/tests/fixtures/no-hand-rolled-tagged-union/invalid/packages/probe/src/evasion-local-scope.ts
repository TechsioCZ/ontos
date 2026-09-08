// expect-count: 3
// Function-scoped type declarations are declarations too.
export function classify(raw: string): string {
  interface LocalOutcome {
    readonly _tag: 'LocalOutcome';
    readonly raw: string;
  }
  type LocalUnion = { readonly _tag: 'yes' } | { readonly _tag: 'no' };
  const outcome: LocalOutcome = { _tag: 'LocalOutcome', raw };
  const decision: LocalUnion = { _tag: 'yes' };
  return outcome._tag + decision._tag;
}
