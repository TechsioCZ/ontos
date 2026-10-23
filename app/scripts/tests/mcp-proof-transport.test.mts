import { Effect, Exit } from 'effect';
import { expect, it } from 'effect-rstest';

import { proofToolCall } from '../demo/mcp-oauth-e2e/tool-call.mts';

const transportFailure = () =>
  new TypeError('fetch failed', { cause: { code: 'ECONNRESET', privateValue: 'must-not-be-reported' } });
const command = { id: 'work.tasks/command/CreateTask', idempotencyKey: 'same-operation' };

it.live('retries an identified transient write once with the same operation and accepts only its real result', () =>
  Effect.gen(function* retryStableWrite() {
    let attempts = 0;
    const result = yield* proofToolCall('ontos_execute', command, () => {
      attempts += 1;
      return attempts === 1 ? Promise.reject(transportFailure()) : Promise.resolve({ status: 'executed' });
    });
    expect(result.status).toBe('executed');
    expect(attempts).toBe(2);
  }),
);

it.live('fails after two transport attempts and never exposes request or cause contents', () =>
  Effect.gen(function* exhaustRetry() {
    let attempts = 0;
    const result = yield* proofToolCall('ontos_execute', command, () => {
      attempts += 1;
      return Promise.reject(transportFailure());
    }).pipe(Effect.flip);
    expect(attempts).toBe(2);
    expect(result.message).toContain('CreateTask');
    expect(result.message).toContain('ECONNRESET');
    expect(result.message).toContain('outcome unknown');
    expect(result.message).not.toContain('must-not-be-reported');
  }),
);

it.live('never retries missing keys, other methods, unknown failures or returned module errors', () =>
  Effect.gen(function* neverReplayUnsafeWrites() {
    for (const [name, args, error] of [
      ['ontos_execute', { id: command.id }, transportFailure()],
      ['ontos_execute', { ...command, idempotencyKey: '' }, transportFailure()],
      ['ontos_read', command, transportFailure()],
      ['ontos_execute', command, new TypeError('fetch failed')],
      ['ontos_execute', command, new Error('application failure')],
    ] as const) {
      let attempts = 0;
      const exit = yield* proofToolCall(name, args, () => {
        attempts += 1;
        return Promise.reject(error);
      }).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(attempts).toBe(1);
    }
    let attempts = 0;
    const moduleError = yield* proofToolCall('ontos_execute', command, () => {
      attempts += 1;
      return Promise.resolve({ isError: true });
    });
    expect(moduleError.isError).toBe(true);
    expect(attempts).toBe(1);
  }),
);
