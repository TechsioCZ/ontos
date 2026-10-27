import { randomUUID } from 'node:crypto';

import type { TrustedPrincipalContext } from '@app/core-runtime';
import type { AgentCommand, AgentQueueBatch, AgentQueueRequest } from '@app/shared-contracts/agent-proposals';
import { Effect, Result } from 'effect';

import { applyModuleCommand, callModuleAs, recordsReadOf } from './module-call.ts';
import { normalizeLegacySlice, sliceFromRecords } from './legacy-normalize.ts';
import type { LegacyEngineModule } from './legacy-normalize.ts';

export type LegacyBatchesResult =
  | { readonly state: 'absent' }
  | { readonly state: 'unavailable' }
  | { readonly batches: AgentQueueBatch[]; readonly state: 'ok' };

const ABSENT: LegacyBatchesResult = { state: 'absent' };
const UNAVAILABLE: LegacyBatchesResult = { state: 'unavailable' };

const readLegacyOnce = Effect.fn('AgentPlatform.readLegacyOnce')(function* readLegacyOnceEffect(
  principal: TrustedPrincipalContext,
  module: LegacyEngineModule,
  options: {
    readonly canDecide: boolean;
    readonly names: ReadonlyMap<string, string>;
    readonly request: AgentQueueRequest;
  },
) {
  const result = yield* recordsReadOf(module.appId).pipe(
    Effect.flatMap((read) =>
      callModuleAs(principal, module.appId, read.path, {
        ...read.query,
        agentHistory: { ...options.request, mode: 'queue' },
      }),
    ),
    Effect.result,
  );
  if (Result.isFailure(result)) {
    return result.failure.stage === 'assertion' ? ABSENT : UNAVAILABLE;
  }
  const response = result.success;
  if (response.status === 403 || response.status === 404) {
    return ABSENT;
  }
  if (response.status !== 200) {
    return UNAVAILABLE;
  }
  const ok: LegacyBatchesResult = {
    batches: normalizeLegacySlice(module, sliceFromRecords(response.body), options),
    state: 'ok',
  };
  return ok;
});

/**
 * Reads one legacy module's `aiChanges` queue. A module that is not installed or not visible counts as absent. A
 * module that just restarted can refuse the first call (401/5xx), so an unavailable read is retried once.
 */
export const readLegacyBatches = Effect.fn('AgentPlatform.readLegacyBatches')(function* readLegacyBatches(
  principal: TrustedPrincipalContext,
  module: LegacyEngineModule,
  options: {
    readonly canDecide: boolean;
    readonly names: ReadonlyMap<string, string>;
    readonly request: AgentQueueRequest;
  },
) {
  const first = yield* readLegacyOnce(principal, module, options);
  if (first.state !== 'unavailable') {
    return first;
  }
  yield* Effect.sleep('600 millis');
  return yield* readLegacyOnce(principal, module, options);
});

export const decideLegacy = (
  principal: TrustedPrincipalContext,
  appId: string,
  changeIds: readonly string[],
  decision: 'approve' | 'reject',
  note?: string,
) => {
  let command: AgentCommand = {
    _tag: 'AiDecideChanges',
    changeIds: [...changeIds],
    decision,
  };
  if (note !== undefined && note.trim() !== '') {
    command = { ...command, note: note.trim() };
  }
  return applyModuleCommand(principal, appId, command, { idempotencyKey: randomUUID() });
};

export const revertLegacy = (principal: TrustedPrincipalContext, appId: string, batchId: string, note?: string) => {
  let command: AgentCommand = { _tag: 'AiRevertBatch', batchId };
  if (note !== undefined && note.trim().length >= 3) {
    command = { ...command, note: note.trim() };
  }
  return applyModuleCommand(principal, appId, command, { idempotencyKey: randomUUID() });
};
