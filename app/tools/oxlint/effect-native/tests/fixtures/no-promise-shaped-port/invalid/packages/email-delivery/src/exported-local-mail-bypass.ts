// expect-count: 1
import { Effect, Predicate, Schema } from 'effect';

// A local service does not become a native SDK contract because it has the same fields.
export interface LocalMailService {
  readonly send: (message: {
    readonly from: string;
    readonly html?: string;
    readonly subject: string;
    readonly text: string;
    readonly to: string;
  }) => Promise<{ readonly messageId: string }>;
}
export const localSchema = Schema.Struct({
  send: Schema.declare<LocalMailService['send']>((value): value is LocalMailService['send'] =>
    Predicate.isFunction(value),
  ),
});
const message = { from: 'sender@example.invalid', subject: 'Notice', text: 'Hello', to: 'recipient@example.invalid' };
export const converted = (binding: LocalMailService) => Effect.tryPromise({
  catch: String,
  try: binding.send.bind(binding, message),
});
// One converted call must not erase the Promise port used by another exported caller.
export const unconverted = (binding: LocalMailService) => binding.send(message);
