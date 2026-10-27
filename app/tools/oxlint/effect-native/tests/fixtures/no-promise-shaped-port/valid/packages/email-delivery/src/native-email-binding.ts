import type { SendEmail } from '@cloudflare/workers-types';
import { Effect, Predicate, Schema } from 'effect';

// The Promise protocol is owned by the imported Workers SDK.
export type NativeMailBinding = Pick<SendEmail, 'send'>;

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
