import assert from 'node:assert/strict';
import { Effect, Schema } from 'effect';
import { expect } from 'effect-rstest';

const CommandSchema = Schema.Struct({ _tag: Schema.Literal('AgendaEventUpdate'), title: Schema.String });

Effect.gen(function* schemaWireRoundTrips() {
  const command = { _tag: 'AgendaEventUpdate', title: 'Updated' } as const;
  const decoded = yield* Schema.decodeUnknownEffect(CommandSchema)(command);
  expect(yield* Schema.encodeEffect(CommandSchema)(decoded)).toEqual(command);

  const base = { _tag: 'AgendaEventUpdate', title: 'Omitted references' } as const;
  const decode = Schema.decodeEffect(CommandSchema);
  const encode = Schema.encodeEffect(CommandSchema);
  const omitted = yield* decode(base);
  const encoded = yield* encode(omitted);
  const expected = base;
  expect(encoded).toStrictEqual(expected);

  const synchronous = Schema.decodeUnknownSync(CommandSchema)(command);
  assert.deepStrictEqual(Schema.encodeSync(CommandSchema)(synchronous), command);
});

const promiseWire = { _tag: 'AgendaEventUpdate', title: 'Promise codec' } as const;
const promiseDecoded = await Schema.decodeUnknownPromise(CommandSchema)(promiseWire);
expect(await Schema.encodePromise(CommandSchema)(promiseDecoded)).toEqual(promiseWire);
