// expect-count: 8
import { Effect, Schema, Schema as NativeSchema } from 'effect';
import { expect } from 'effect-rstest';

const CommandSchema = Schema.Struct({ _tag: Schema.Literal('AgendaEventUpdate'), title: Schema.String });
const OtherSchema = Schema.Struct({ _tag: Schema.Literal('AgendaEventUpdate'), title: Schema.String });
const command = { _tag: 'AgendaEventUpdate', title: 'Updated' } as const;

Effect.gen(function* directTagControls() {
  const decoded = yield* Schema.decodeUnknownEffect(CommandSchema)(command);
  const encoded = yield* Schema.encodeEffect(CommandSchema)(decoded);
  expect(encoded._tag === command._tag).toBe(true);
  expect(encoded._tag).toBe('AgendaEventUpdate');
  expect(encoded).toMatchObject({ _tag: 'AgendaEventUpdate' });
  expect(encoded).toEqual({ _tag: 'AgendaEventUpdate' });

  const other = { _tag: 'AgendaEventUpdate', title: 'Not the decoded wire value' } as const;
  expect(encoded).toEqual(other);
  expect(yield* Schema.encodeEffect(OtherSchema)(decoded)).toEqual(command);
});

function shadowedSchema(Schema: typeof NativeSchema) {
  return Effect.gen(function* lookalikeCodec() {
    const decoded = yield* Schema.decodeUnknownEffect(CommandSchema)(command);
    expect(yield* Schema.encodeEffect(CommandSchema)(decoded)).toEqual(command);
  });
}

function* plainYieldDoesNotProveCodecResult() {
  const decoded = yield Schema.decodeUnknownEffect(CommandSchema)(command);
  expect(yield Schema.encodeEffect(CommandSchema)(decoded)).toEqual(command);
}
