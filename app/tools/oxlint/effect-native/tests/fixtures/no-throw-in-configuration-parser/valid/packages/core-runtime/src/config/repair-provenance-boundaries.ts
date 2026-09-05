// A3 provenance must not spread through cyclic lookalikes, total maps, or shadowed type constructors.
export function cyclicLookalike(): string {
  const bag = { PORT: bag.PORT };
  const value = bag.PORT;
  throw new Error(String(value));
}

export function readHeaders(values: Readonly<Record<string, string>>): string {
  throw new Error(values['content-type']);
}

namespace Domain {
  type Record<K, V> = { readonly kind: 'domain'; readonly value: V };
  export function parse(values: Record<string, string | undefined>): string {
    throw new Error(values.kind);
  }
}

export function stageLength(environment: string): number {
  const length = environment[`length`];
  if (length === 0) throw new Error('stage name required');
  return length;
}
