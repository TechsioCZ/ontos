import type { ModuleCommandOutcome } from '../../../api/agent-platform/module-call.ts';
import { requireModuleCommandResult } from '../../../api/agent-platform/service-decide.ts';
import { Effect, Predicate, Result } from 'effect';
import { expect, it } from 'effect-rstest';

it.effect('preserves the actual module result, including IDs needed by the native apply/undo payload', () =>
  Effect.gen(function* retainedModuleResult() {
    const body = { changed: true, created: { id: 'genuine-module-id' }, revision: 17 };
    const result = yield* requireModuleCommandResult({ body, ok: true });
    expect(result).toBe(body);
    expect(yield* requireModuleCommandResult({ body: null, ok: true })).toBeNull();
  }),
);

const unresolved: readonly Extract<ModuleCommandOutcome, { readonly ok: false }>[] = [
  { code: 'action_already_committed', message: 'Already committed without retained result', ok: false, status: 409 },
  { code: 'action_request_hash_conflict', message: 'Original request differs', ok: false, status: 409 },
  { code: 'action_invocation_state_invalid', message: 'Original execution unresolved', ok: false, status: 409 },
  { message: 'Timed out after dispatch', ok: false, status: 503 },
  { message: 'Gateway lost the response', ok: false, status: 502 },
  { message: 'Request timeout', ok: false, status: 408 },
  // A later refusal says nothing about an earlier delivery of the same reserved proposal.
  { code: 'action_permission_denied', message: 'Current rights denied', ok: false, status: 403 },
  { message: 'Record no longer visible', ok: false, status: 404 },
  { message: 'Current payload refused', ok: false, status: 422 },
];

for (const outcome of unresolved) {
  it.effect(`does not invent applyResult or release/failure authority from ${outcome.code ?? outcome.status}`, () =>
    Effect.gen(function* unresolvedModuleExecution() {
      const result = yield* requireModuleCommandResult(outcome).pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(Predicate.isTagged(result.failure, 'AgentStoreUnavailable')).toBe(true);
        expect(result.failure.cause).toEqual({ code: outcome.code, message: outcome.message, status: outcome.status });
      }
    }),
  );
}
