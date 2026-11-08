import { Schema } from 'effect';

/** Private state of an original Core-prepared continuation. Object copies have no private state. */
export class PreparedActionStepV2<Value> {
  readonly #value: Value;

  constructor(value: Value) {
    this.#value = value;
    Object.freeze(this);
  }

  static read<Value>(step: PreparedActionStepV2<Value>): Value | undefined {
    return Schema.is(Schema.instanceOf(PreparedActionStepV2))(step) && #value in step ? step.#value : undefined;
  }
}
