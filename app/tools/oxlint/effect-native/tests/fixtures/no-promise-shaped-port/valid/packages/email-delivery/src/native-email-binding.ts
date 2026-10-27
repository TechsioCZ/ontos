import { Effect, Predicate, Schema } from 'effect';

// A different type name and filename still describe the foreign Workers SDK.
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

// The SDK method keeps its receiver and argument, then crosses exactly one bridge.
export const delivery = (binding: NativeMailBinding | undefined) => {
  if (binding === undefined) return Effect.fail('unconfigured');
  const submission = { from: 'sender@example.invalid', subject: 'Notice', text: 'Hello', to: 'recipient@example.invalid' };
  return Effect.tryPromise({
    catch: String,
    try: binding.send.bind(binding, submission),
  });
};
