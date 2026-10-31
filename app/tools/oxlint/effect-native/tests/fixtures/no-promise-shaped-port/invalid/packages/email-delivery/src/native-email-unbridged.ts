// expect-count: 1
import { Predicate, Schema } from 'effect';

// A structurally matching declaration without the typed SDK receiver bridge is insufficient.
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
