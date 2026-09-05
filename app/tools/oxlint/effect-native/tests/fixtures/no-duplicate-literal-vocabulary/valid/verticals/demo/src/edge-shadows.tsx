// Every duplicate here resolves to a local shadow, not the Effect import.
import { Schema } from 'effect';

interface Fake {
  readonly Literals: (members: readonly string[]) => string;
}

export const Real = Schema.Literals(['red', 'green']);

export function viaParam(Schema: Fake) {
  return Schema.Literals(['blue', 'cyan', 'teal']);
}

export class Holder {
  render(Schema: Fake) {
    return <i data-x={Schema.Literals(['blue', 'cyan', 'teal'])} />;
  }
}

export function viaCatch(make: () => Fake) {
  try {
    throw make();
  } catch (Schema) {
    return (Schema as Fake).Literals(['blue', 'cyan', 'teal']);
  }
}

export const viaArrow = (Schema: Fake) => Schema.Literals(['blue', 'cyan', 'teal']);
