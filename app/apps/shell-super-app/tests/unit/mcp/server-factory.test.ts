// @rstest-environment node
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { PASS_THROUGH_VALIDATOR } from '../../../api/mcp/server-factory.ts';

it.effect('preserves open SDK tool objects and leaves nested DTO validation to the tool', () =>
  Effect.gen(function* openSdkToolObject() {
    const value = {
      futureProtocolExtension: { values: [null, true, 3, 'value', { anotherExtension: [] }] },
      invalidBusinessField: { intentionallyNotTheExpectedDto: true },
    };
    const result = yield* Effect.promise(() => Promise.resolve(PASS_THROUGH_VALIDATOR['~standard'].validate(value)));
    expect(result).toHaveProperty('value');
    if ('value' in result) {
      expect(result.value).toBe(value);
    }
  }),
);

it.effect('preserves SDK-parsed numeric overflow until the existing handler performs recursive validation', () =>
  Effect.gen(function* sdkParsedNumericOverflow() {
    const value = { extension: Number.POSITIVE_INFINITY };
    const result = yield* Effect.promise(() => Promise.resolve(PASS_THROUGH_VALIDATOR['~standard'].validate(value)));
    expect(result).toHaveProperty('value');
    if ('value' in result) {
      expect(result.value).toBe(value);
    }
    expect(Schema.isSchemaError(yield* Effect.flip(Schema.decodeUnknownEffect(Schema.JsonObject)(value)))).toBe(true);
  }),
);

it.effect('preserves null, scalar, array and open object JSON roots at the SDK pass-through boundary', () =>
  Effect.gen(function* sdkJsonRootsAreNotNarrowed() {
    for (const value of [
      null,
      false,
      3,
      Number.POSITIVE_INFINITY,
      'value',
      [],
      {},
      { futureExtension: [true, null, { key: 'value' }] },
    ]) {
      const result = yield* Effect.promise(() => Promise.resolve(PASS_THROUGH_VALIDATOR['~standard'].validate(value)));
      expect(result).toHaveProperty('value');
      if ('value' in result) {
        expect(result.value).toBe(value);
      }
    }
  }),
);
