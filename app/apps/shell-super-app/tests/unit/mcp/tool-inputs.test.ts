// @rstest-environment node
import { Effect, Result, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  CallerIntentKeySchema,
  CapabilitiesInput,
  decodeToolInput,
  EmptyInput,
  ExecuteInput,
  InvalidToolArguments,
  ProposeInput,
  ReadInput,
  toolInputSchema,
} from '../../../api/mcp/tool-inputs.ts';

const astral = '\u{1F680}';
const combining = 'é';

describe('MCP tool inputs', () => {
  it('accepts only nonempty printable ASCII caller keys of at most 200 characters', () => {
    const decode = Schema.decodeUnknownResult(CallerIntentKeySchema);
    for (const key of ['!', '~', 'caller:key-1', 'x'.repeat(200)]) {
      expect(Result.getOrThrow(decode(key))).toBe(key);
    }
    for (const key of ['', ' ', 'a b', '\n', '\u007F', 'klíč', astral, 'x'.repeat(201)]) {
      expect(Result.isFailure(decode(key))).toBe(true);
    }
  });

  it.effect('counts astral code points once and combining marks separately at read text bounds', () =>
    Effect.gen(function* readUnicodeBounds() {
      const astralId = astral.repeat(300);
      expect(yield* decodeToolInput(ReadInput, { id: astralId, path: astralId })).toEqual({
        id: astralId,
        path: astralId,
      });
      const combiningId = combining.repeat(150);
      expect(yield* decodeToolInput(ReadInput, { id: combiningId, path: '' })).toEqual({
        id: combiningId,
        path: '',
      });
      for (const input of [
        { id: '', path: '' },
        { id: astral.repeat(301), path: '' },
        { id: `${combiningId}e`, path: '' },
        { id: 'read', path: astral.repeat(301) },
        { id: 'read', path: `${combiningId}e` },
      ]) {
        const error = yield* decodeToolInput(ReadInput, input).pipe(Effect.flip);
        expect(error).toBeInstanceOf(InvalidToolArguments);
      }
    }),
  );

  it.effect('uses Unicode bounds for capability filters and mutation metadata too', () =>
    Effect.gen(function* metadataUnicodeBounds() {
      const filters = { id: astral.repeat(300), moduleId: astral.repeat(120), query: astral.repeat(200) };
      expect(yield* decodeToolInput(CapabilitiesInput, filters)).toEqual(filters);
      for (const input of [
        { ...filters, moduleId: astral.repeat(121) },
        { ...filters, query: `${combining.repeat(100)}e` },
      ]) {
        const error = yield* decodeToolInput(CapabilitiesInput, input).pipe(Effect.flip);
        expect(error).toBeInstanceOf(InvalidToolArguments);
      }
      const execution = {
        id: 'command',
        idempotencyKey: 'caller-key',
        reason: astral.repeat(2000),
        runId: astral.repeat(300),
      };
      expect(yield* decodeToolInput(ExecuteInput, execution)).toEqual(execution);
      for (const input of [
        { ...execution, reason: astral.repeat(2001) },
        { ...execution, runId: `${combining.repeat(150)}e` },
        { ...execution, runId: '' },
      ]) {
        const error = yield* decodeToolInput(ExecuteInput, input).pipe(Effect.flip);
        expect(error).toBeInstanceOf(InvalidToolArguments);
      }
    }),
  );

  it.effect('bounds proposal instructions and change reasons without normalizing combining marks', () =>
    Effect.gen(function* proposalUnicodeBounds() {
      const proposal = {
        changes: [{ id: 'command', reason: combining.repeat(1000) }],
        idempotencyKey: 'proposal-key',
        instruction: astral.repeat(4000),
      };
      expect(yield* decodeToolInput(ProposeInput, proposal)).toEqual(proposal);
      for (const instruction of ['', astral.repeat(4001)]) {
        const error = yield* decodeToolInput(ProposeInput, { ...proposal, instruction }).pipe(Effect.flip);
        expect(error).toBeInstanceOf(InvalidToolArguments);
      }
      for (const reason of ['', `${combining.repeat(1000)}e`]) {
        const error = yield* decodeToolInput(ProposeInput, {
          ...proposal,
          changes: [{ id: 'command', reason }],
        }).pipe(Effect.flip);
        expect(error).toBeInstanceOf(InvalidToolArguments);
      }
    }),
  );

  it('requires an actual empty object for empty tool inputs', () => {
    const decode = Schema.decodeUnknownResult(EmptyInput, { onExcessProperty: 'error' });
    expect(Result.getOrThrow(decode({}))).toEqual({});
    for (const input of [
      null,
      undefined,
      [],
      [{}],
      '',
      'text',
      0,
      1,
      true,
      false,
      1n,
      Symbol('input'),
      { unexpected: true },
      Object.fromEntries([['unexpected', undefined]]),
      { '': null },
      { 0: false },
    ]) {
      expect(Result.isFailure(decode(input))).toBe(true);
    }
  });

  it.effect('rejects excess properties at the tool and nested contract boundaries', () =>
    Effect.gen(function* rejectExtraProperties() {
      const readError = yield* decodeToolInput(ReadInput, { id: 'read', unexpected: true }).pipe(Effect.flip);
      expect(readError).toBeInstanceOf(InvalidToolArguments);
      expect(readError.message).toContain('Neplatné argumenty nástroje:');
      expect(readError.message).toContain('unexpected');
      expect(readError.cause).toBeInstanceOf(Error);

      expect(yield* decodeToolInput(EmptyInput, {})).toEqual({});
      const emptyError = yield* decodeToolInput(EmptyInput, { unexpected: true }).pipe(Effect.flip);
      expect(emptyError).toBeInstanceOf(InvalidToolArguments);
      expect(emptyError.message).toContain('Neplatné argumenty nástroje:');
      expect(emptyError.message).toContain('unexpected');
      expect(emptyError.cause).toBeInstanceOf(Error);
      const changeError = yield* decodeToolInput(ProposeInput, {
        changes: [{ id: 'command', reason: 'Requested', unexpected: true }],
        idempotencyKey: 'proposal-key',
        instruction: 'Requested change',
      }).pipe(Effect.flip);
      expect(changeError).toBeInstanceOf(InvalidToolArguments);
      expect(changeError.message).toContain('unexpected');
      expect(yield* decodeToolInput(ReadInput, { id: 'read', input: { actionOwnedField: true } })).toEqual({
        id: 'read',
        input: { actionOwnedField: true },
      });
    }),
  );

  it('publishes the same Unicode bounds and closed object contracts in JSON Schema', () => {
    expect(toolInputSchema(ReadInput)).toMatchObject({
      additionalProperties: false,
      properties: {
        id: { maxLength: 300, minLength: 1 },
        limit: { maximum: 500, minimum: 1, type: 'integer' },
        offset: { minimum: 0, type: 'integer' },
        path: { maxLength: 300, minLength: 0 },
      },
      required: ['id'],
    });
    expect(toolInputSchema(ExecuteInput)).toMatchObject({
      additionalProperties: false,
      properties: {
        idempotencyKey: { maxLength: 200, minLength: 1, pattern: '^[!-~]+$' },
        reason: { maxLength: 2000, minLength: 0 },
        runId: { maxLength: 300, minLength: 1 },
      },
    });
    expect(toolInputSchema(EmptyInput)).toEqual({
      $defs: {},
      additionalProperties: false,
      type: 'object',
    });
  });
});
