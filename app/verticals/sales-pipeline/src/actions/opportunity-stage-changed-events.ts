import type { ActionHandlerContext } from '@app/core-runtime';
import { DateTime, Effect, Option, Schema } from 'effect';

import type { OpportunityLine } from '../../shared/model/opportunity.ts';
import {
  OpportunityIdSchema,
  OpportunityStageSchema,
  outboxTopic,
} from '../../shared/outbox/sales-pipeline-opportunity-stage-changed-v1.ts';
import type {
  OpportunityStageChangedLine,
  OutboxPayload,
} from '../../shared/outbox/sales-pipeline-opportunity-stage-changed-v1.ts';
import type { StageChange } from '../services/persistence.service.ts';
import { createApplyCommandSalesPipelineOpportunityStageChangedV1OutboxMessage } from './apply-command-sales-pipeline-opportunity-stage-changed-v1.outbox-message.ts';

/** Domain Event linked to every published stage-change Outbox Message; same name as the topic. */
export const opportunityStageChangedDomainEvents = {
  [outboxTopic]: Schema.Struct({
    fromStage: Schema.optionalKey(OpportunityStageSchema),
    opportunityId: OpportunityIdSchema,
    revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    toStage: OpportunityStageSchema,
  }),
} as const;
export type OpportunityStageChangedDomainEvents = typeof opportunityStageChangedDomainEvents;
type OpportunityStageChangedEvent = (typeof opportunityStageChangedDomainEvents)[typeof outboxTopic]['Type'];

/**
 * Snapshot line. The frozen contract requires a catalog `productId`, so free-text lines are left out of the
 * snapshot; `amountMinor` still reports the full opportunity amount.
 */
const snapshotLine = (line: OpportunityLine): readonly OpportunityStageChangedLine[] =>
  line.productId === undefined
    ? []
    : [
        {
          productId: line.productId,
          productName: line.productName,
          quantity: line.quantity,
          unitPriceMinor: line.unitPriceMinor,
          vatRate: line.vatRate,
        },
      ];

/** Every real transition is published; a creation only when the opportunity is created directly as WON. */
const isPublished = (change: StageChange): boolean =>
  Option.isSome(change.fromStage) || change.opportunity.stage === 'WON';

const stageChangedPayload = (change: StageChange, revision: number, changedAt: string): OutboxPayload => {
  const { opportunity } = change;
  const payload: OutboxPayload = {
    amountMinor: opportunity.amountMinor,
    changedAt,
    currency: opportunity.currency,
    lines: opportunity.lines.flatMap(snapshotLine),
    opportunityId: opportunity.id,
    partyId: opportunity.partyId,
    revision,
    toStage: opportunity.stage,
  };
  const withFrom = Option.match(change.fromStage, {
    onNone: () => payload,
    onSome: (fromStage) => ({ ...payload, fromStage }),
  });
  return opportunity.ownerEmployeeId === undefined
    ? withFrom
    : { ...withFrom, ownerEmployeeId: opportunity.ownerEmployeeId };
};

/** One payload per published stage change, in command order (bulk updates yield one per changed opportunity). */
export const opportunityStageChangedPayloads = (input: {
  readonly changedAt: DateTime.Utc;
  readonly revision: number;
  readonly stageChanges: readonly StageChange[];
}): readonly OutboxPayload[] => {
  const changedAt = DateTime.formatIso(input.changedAt);
  return input.stageChanges.flatMap((change) =>
    isPublished(change) ? [stageChangedPayload(change, input.revision, changedAt)] : [],
  );
};

type PublishingContext = Pick<
  ActionHandlerContext<OpportunityStageChangedDomainEvents, unknown>,
  'addDomainEvent' | 'addOutboxMessage'
>;

/** Records the Domain Event and its Outbox Message inside the Action transaction. */
export const publishOpportunityStageChanged = Effect.fn('SalesPipeline.publishOpportunityStageChanged')(
  function* publishOpportunityStageChanged(context: PublishingContext, payload: OutboxPayload) {
    const transition: OpportunityStageChangedEvent = {
      opportunityId: payload.opportunityId,
      revision: payload.revision,
      toStage: payload.toStage,
    };
    const event = yield* context.addDomainEvent({
      eventType: outboxTopic,
      payloadJson: payload.fromStage === undefined ? transition : { ...transition, fromStage: payload.fromStage },
      producerModuleKey: 'demo.sales-pipeline',
      subjectModuleKey: 'demo.sales-pipeline',
      subjectResourceId: payload.opportunityId,
      subjectResourceType: 'demo.sales-pipeline.opportunity',
    });
    yield* context.addOutboxMessage(
      event,
      createApplyCommandSalesPipelineOpportunityStageChangedV1OutboxMessage(payload),
    );
  },
);
