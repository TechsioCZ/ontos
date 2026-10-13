import { Effect, Random } from 'effect';
import type { ApplyCommandPayload } from '../../../../../shared/actions/apply-command.ts';
import { executeApplyCommand } from '../../../../api/apply-command-action-client.ts';
import { executeRecords } from '../../../../api/records-client.ts';
import type { OpportunityListFilters } from '../../../../api/records-client.ts';
import type { EmployeeId, OpportunityStage } from './pipeline-model.ts';

export type PipelineCommand = ApplyCommandPayload['command'];

/**
 * Records read. Stage and owner filters go to the server so the indicators match the visible set.
 * `requestKey` is the screen's reload counter, used as the request correlation id.
 */
export const loadPipeline = Effect.fn('SalesPipeline.loadPipeline')(function* loadPipeline(
  filters: OpportunityListFilters,
  requestKey: number,
) {
  return yield* executeRecords(filters, `sales-pipeline:records:${requestKey}`);
});

/** Single command endpoint. Every call carries the revision the screen was built from. */
export const applyPipelineCommand = Effect.fn('SalesPipeline.applyCommand')(function* applyPipelineCommand(
  command: PipelineCommand,
  expectedRevision: number,
) {
  const nonce = yield* Random.nextInt;
  const idempotencyKey = `sales-pipeline:apply:${nonce}`;
  return yield* executeApplyCommand({ command, expectedRevision }, idempotencyKey, { idempotencyKey });
});

export const recordsFilters = (stage: OpportunityStage | '', owner: EmployeeId | ''): OpportunityListFilters => {
  if (stage !== '' && owner !== '') {
    return { ownerEmployeeId: owner, stage };
  }
  if (stage !== '') {
    return { stage };
  }
  if (owner !== '') {
    return { ownerEmployeeId: owner };
  }
  return {};
};
