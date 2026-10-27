// expect-count: 2
import { Effect, Predicate, Schema } from 'effect';

// The foreign member alone is recognized. This sibling first-party port still fails.
export interface CloudflareEmailBinding {
  readonly send: (message: {
    readonly from: string;
    readonly html?: string;
    readonly subject: string;
    readonly text: string;
    readonly to: string;
  }) => Promise<{ readonly messageId: string }>;
  readonly loadCustomer: (id: string) => Promise<string>;
}

export const bindingSchema = Schema.Struct({
  send: Schema.declare<CloudflareEmailBinding['send']>(
    (value): value is CloudflareEmailBinding['send'] => Predicate.isFunction(value),
  ),
});
export const delivery = (binding: CloudflareEmailBinding) => Effect.tryPromise({
  catch: String,
  try: binding.send.bind(binding, { from: 'a', subject: 'Notice', text: 'Hello', to: 'b' }),
});

// A familiar filename/type name does not exempt an owned Promise implementation.
export const send = async (customerId: string) => customerId;
