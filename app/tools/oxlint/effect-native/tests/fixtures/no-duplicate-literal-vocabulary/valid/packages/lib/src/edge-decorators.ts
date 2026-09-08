// Decorators and `accessor` fields: parser probe with two distinct vocabularies.
import { Schema } from 'effect';

function logged<T>(value: T): T {
  return value;
}

export class Contracts {
  @logged
  static readonly Toggle = Schema.Literals(['on', 'off']);

  @logged
  static readonly Tri = Schema.Literals(['on', 'off', 'unknown']);
}
