import { Effect, Random } from 'effect';
import type { ApplyCommandPayload } from '../../../../../shared/actions/apply-command.ts';
import type { PartyIdSchema } from '../../../../../shared/outbox/sales-pipeline-opportunity-stage-changed-v1.ts';
import { executeApplyCommand } from '../../../../api/apply-command-action-client.ts';
import { executeRecords } from '../../../../api/records-client.ts';
import type { OpportunityListFilters } from '../../../../api/records-client.ts';
import type { EmployeeId, OpportunityStage } from './pipeline-model.ts';

export type PipelineCommand = ApplyCommandPayload['command'];

/**
 * Records read. Stage, owner and customer filters go to the server so the indicators match the visible set.
 * `correlation` is the request correlation id; each caller passes a fresh one.
 */
export const loadPipeline = Effect.fn('SalesPipeline.loadPipeline')(function* loadPipeline(
  filters: OpportunityListFilters,
  correlation: string,
) {
  return yield* executeRecords(filters, correlation);
});

const sendPipelineCommand = Effect.fn('SalesPipeline.sendCommand')(function* sendPipelineCommand(
  command: PipelineCommand,
  expectedRevision: number,
) {
  // A retry is a new invocation, so every send gets its own idempotency key.
  const nonce = yield* Random.nextInt;
  const idempotencyKey = `sales-pipeline:apply:${nonce}`;
  return yield* executeApplyCommand({ command, expectedRevision }, idempotencyKey, { idempotencyKey });
});

/**
 * Single command endpoint. The first call carries the revision the screen was built from. The revision covers the
 * whole pipeline, so an unrelated edit elsewhere also bumps it: on `sales_pipeline_revision_conflict` the command is
 * sent once more against a freshly read revision. A second conflict reaches the caller.
 */
export const applyPipelineCommand = (command: PipelineCommand, expectedRevision: number) =>
  sendPipelineCommand(command, expectedRevision).pipe(
    Effect.catchTag('ApplyCommandActionConflictProblem', (conflict) =>
      conflict.code === 'sales_pipeline_revision_conflict'
        ? Random.nextInt.pipe(
            Effect.flatMap((nonce) => executeRecords({}, `sales-pipeline:revision:${nonce}`)),
            Effect.flatMap(({ revision }) => sendPipelineCommand(command, revision)),
          )
        : Effect.fail(conflict),
    ),
  );

export interface PipelineFilterValues {
  readonly customer: typeof PartyIdSchema.Type | '';
  readonly owner: EmployeeId | '';
  readonly stage: OpportunityStage | '';
}

type MutableRecordsFilters = { -readonly [Key in keyof OpportunityListFilters]?: OpportunityListFilters[Key] };

/** Only the filters that are set are sent; an unset filter matches the whole visible set. */
export const recordsFilters = ({ customer, owner, stage }: PipelineFilterValues): OpportunityListFilters => {
  const filters: MutableRecordsFilters = {};
  if (stage !== '') {
    filters.stage = stage;
  }
  if (owner !== '') {
    filters.ownerEmployeeId = owner;
  }
  if (customer !== '') {
    filters.partyId = customer;
  }
  return filters;
};
