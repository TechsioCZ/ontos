import { Effect, Schema } from 'effect';

const ActionValueSchema = Schema.Struct({ descriptor: Schema.Struct({ actionKey: Schema.String }) });
const OpaqueSchema = Schema.declare<object>(() => true);
const FakeSchema = {
  decodeUnknownEffect: (_schema: object) => (input: any) => Effect.succeed(input),
};
const forward = (input: any) => input;

export const fakeEffectDecoder = (rawAction: unknown) => FakeSchema.decodeUnknownEffect(ActionValueSchema)(rawAction);
export const shadowedEffectDecoder = (Schema: typeof FakeSchema, rawAction: unknown) =>
  Schema.decodeUnknownEffect(ActionValueSchema)(rawAction);
export const opaqueEffectSchema = (rawAction: unknown) => Schema.decodeUnknownEffect(OpaqueSchema)(rawAction);
export const forwardedRawAfterDecode = (rawAction: unknown) =>
  Schema.decodeUnknownEffect(ActionValueSchema)(rawAction).pipe(Effect.tap(() => forward(rawAction)));
export const escapedEffectClosure = (rawAction: unknown) => () => Schema.decodeUnknownEffect(ActionValueSchema)(rawAction);
export const unknownEffectSchema = (rawAction: unknown) => Schema.decodeUnknownEffect(Schema.Unknown)(rawAction);
export const promiseDecoder = (rawAction: unknown) => Schema.decodeUnknownPromise(ActionValueSchema)(rawAction);
export const unparsedEffectValue = (rawAction: unknown) => Effect.succeed(rawAction);
