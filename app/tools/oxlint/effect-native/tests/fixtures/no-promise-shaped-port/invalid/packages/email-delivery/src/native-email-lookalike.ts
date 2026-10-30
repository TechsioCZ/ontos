// expect-count: 1
import { Effect, Predicate, Schema } from 'effect';

// A first-party customer operation is not the Workers envelope/receipt protocol.
export interface CloudflareEmailBinding {
  readonly send: (message: { readonly customerId: string }) => Promise<{ readonly id: string }>;
}
export const bindingSchema = Schema.Struct({
  send: Schema.declare<CloudflareEmailBinding['send']>(
    (value): value is CloudflareEmailBinding['send'] => Predicate.isFunction(value),
  ),
});
export const delivery = (binding: CloudflareEmailBinding) => Effect.tryPromise({
  catch: String,
  try: binding.send.bind(binding, { customerId: 'customer' }),
});
