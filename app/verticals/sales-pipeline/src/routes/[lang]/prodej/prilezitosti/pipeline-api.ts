import { Effect, Predicate, Random } from 'effect';
import { opportunityRelatedData } from './pipeline-related.ts';
import type { ApplyCommandPayload } from '../../../../../shared/actions/apply-command.ts';
import type { Opportunity } from '../../../../../shared/model/opportunity.ts';
import type { PartyIdSchema } from '../../../../../shared/outbox/sales-pipeline-opportunity-stage-changed-v1.ts';
import { executeApplyCommand } from '../../../../api/apply-command-action-client.ts';
import type { RecordsRequest } from '../../../../../shared/apis/records.ts';
import { executeRecords } from '../../../../api/records-client.ts';
import type { EmployeeId, OpportunityStage } from './pipeline-model.ts';

export type PipelineCommand = ApplyCommandPayload['command'];

/**
 * Records read. Stage, owner and customer filters go to the server so the indicators match the visible set.
 * `correlation` is the request correlation id; each caller passes a fresh one.
 */
export const loadPipeline = Effect.fn('SalesPipeline.loadPipeline')(function* loadPipeline(
  filters: RecordsRequest,
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
  return yield* executeApplyCommand({ command, expectedRevision }, idempotencyKey, { idempotencyKey }).pipe(
    Effect.flatMap((result) =>
      Predicate.isTagged(result, 'ActionProposalAccepted') ? Effect.fail(result) : Effect.succeed(result),
    ),
    Effect.ensuring(Effect.sync(() => opportunityRelatedData.invalidate())),
  );
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

/**
 * An edit against the revision its draft builds on. A revision conflict is resent once against a fresh read only while
 * `unchanged` holds for the opportunities read then: a change elsewhere in the pipeline does not block the edit, a
 * change of the edited opportunity reaches the caller as the conflict.
 */
export const applyPipelineCommandIfUnchanged = (
  command: PipelineCommand,
  expectedRevision: number,
  unchanged: (items: readonly Opportunity[]) => boolean,
) =>
  sendPipelineCommand(command, expectedRevision).pipe(
    Effect.catchTag('ApplyCommandActionConflictProblem', (conflict) =>
      conflict.code === 'sales_pipeline_revision_conflict'
        ? Random.nextInt.pipe(
            Effect.flatMap((nonce) => executeRecords({}, `sales-pipeline:revision:${nonce}`)),
            Effect.flatMap(({ items, revision }) =>
              unchanged(items) ? sendPipelineCommand(command, revision) : Effect.fail(conflict),
            ),
          )
        : Effect.fail(conflict),
    ),
  );

export interface PipelineFilterValues {
  readonly customer: typeof PartyIdSchema.Type | '';
  readonly owner: EmployeeId | '';
  readonly stage: OpportunityStage | '';
}

type MutableRecordsFilters = { -readonly [Key in keyof RecordsRequest]?: RecordsRequest[Key] };

/** Only the filters that are set are sent; an unset filter matches the whole visible set. */
export const recordsFilters = ({ customer, owner, stage }: PipelineFilterValues): RecordsRequest => {
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
