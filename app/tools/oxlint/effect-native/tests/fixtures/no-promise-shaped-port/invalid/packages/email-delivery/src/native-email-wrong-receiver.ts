// expect-count: 1
import { Effect, Predicate, Schema } from 'effect';

export interface NativeMailBinding {
  readonly send: (message: {
    readonly from: string;
    readonly html?: string;
    readonly subject: string;
    readonly text: string;
    readonly to: string;
  }) => Promise<{ readonly messageId: string }>;
}
export const bindingSchema = Schema.Struct({
  send: Schema.declare<NativeMailBinding['send']>(
    (value): value is NativeMailBinding['send'] => Predicate.isFunction(value),
  ),
});

// Type spelling alone cannot supply the required native receiver identity.
export const delivery = (binding: NativeMailBinding, other: NativeMailBinding) => Effect.tryPromise({
  catch: String,
  try: binding.send.bind(other, { from: 'a', subject: 'Notice', text: 'Hello', to: 'b' }),
});
