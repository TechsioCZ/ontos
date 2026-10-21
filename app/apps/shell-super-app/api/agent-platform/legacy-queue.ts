import { randomUUID } from 'node:crypto';

import type { TrustedPrincipalContext } from '@app/core-runtime';
import type { AgentApprovalModule, AgentQueueBatch } from '@app/shared-contracts/agent-proposals';
import { Effect } from 'effect';

import { applyModuleCommand, callModuleAs, recordsQueryFor } from './module-call.ts';
import { normalizeLegacySlice, sliceFromRecords } from './legacy-normalize.ts';

export type LegacyBatchesResult =
  | { readonly state: 'absent' }
  | { readonly state: 'unavailable' }
  | { readonly batches: AgentQueueBatch[]; readonly state: 'ok' };

const ABSENT: LegacyBatchesResult = { state: 'absent' };
const UNAVAILABLE: LegacyBatchesResult = { state: 'unavailable' };

const readLegacyOnce = (
  principal: TrustedPrincipalContext,
  module: AgentApprovalModule,
  options: { readonly canDecide: boolean; readonly names: ReadonlyMap<string, string> },
) =>
  Effect.gen(function* readLegacyOnce() {
    const result = yield* callModuleAs(principal, module.appId, '/reads/records', recordsQueryFor(module.appId)).pipe(
      Effect.result,
    );
    if (result._tag === 'Failure') {
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
  module: AgentApprovalModule,
  options: { readonly canDecide: boolean; readonly names: ReadonlyMap<string, string> },
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
) =>
  applyModuleCommand(
    principal,
    appId,
    {
      _tag: 'AiDecideChanges',
      changeIds: [...changeIds],
      decision,
      ...(note === undefined || note.trim() === '' ? {} : { note: note.trim() }),
    },
    { idempotencyKey: randomUUID() },
  );

export const revertLegacy = (principal: TrustedPrincipalContext, appId: string, batchId: string, note?: string) =>
  applyModuleCommand(
    principal,
    appId,
    {
      _tag: 'AiRevertBatch',
      batchId,
      ...(note === undefined || note.trim().length < 3 ? {} : { note: note.trim() }),
    },
    { idempotencyKey: randomUUID() },
  );
