// A local binding named `Schema` shadows the import and is not Effect's Schema.
import { Schema } from 'effect';

interface FakeSchema {
  readonly Literals: (members: readonly string[]) => string;
}

export const Real = Schema.Literals(['queued', 'running']);

export function first(local: FakeSchema): string {
  const Schema = local;
  return Schema.Literals(['alpha', 'beta', 'gamma']);
}

export function second(local: FakeSchema): string {
  const Schema = local;
  return Schema.Literals(['alpha', 'beta', 'gamma']);
}
