import { Option } from 'effect';

import type { AnyActionRegistration } from './definition.ts';

/** Private runtime plumbing. Only the testing entrypoint constructs a probe. */
export const actionPreparationObservation: unique symbol = Symbol('action-preparation-observation');
/** A test service substitution retains the exact original preparation result for observation. */
export const originalActionPreparationFactory: unique symbol = Symbol('original-action-preparation-factory');

/**
 * Pull-only observation of one successful preparation. This grants no authority and does not
 * evaluate or consume the factory. Publication happens only after Core accounts for every Policy.
 */
export class ActionPreparationObservation<Value> {
  readonly #registration: AnyActionRegistration;
  #value: Option.Option<Value> = Option.none();

  constructor(registration: AnyActionRegistration) {
    this.#registration = registration;
  }

  publish(input: { readonly registration: AnyActionRegistration; readonly value: Value }): void {
    if (input.registration === this.#registration && Option.isNone(this.#value)) {
      this.#value = Option.some(input.value);
    }
  }

  snapshot(): Option.Option<Value> {
    return this.#value;
  }
}
