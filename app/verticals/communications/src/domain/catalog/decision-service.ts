import { Context, Effect, Layer } from 'effect';

import { approvedMessageTypeRegistry } from './approved-registry.ts';
import { decideCommunication } from './decision.ts';
import type { CommunicationDecision } from './decision.ts';
import type { CommunicationDecisionContext, CommunicationDecisionRequest } from './decision-request.ts';
import type { MessageTypeRegistry } from './registry.ts';

export interface CommunicationDecisionEvaluator {
  /** Every expected result is a value of the decision; the only failure channel left is a defect. */
  readonly decide: (
    request: CommunicationDecisionRequest,
    context: CommunicationDecisionContext,
  ) => Effect.Effect<CommunicationDecision>;
}

/** Owner-local Communication Decision evaluator over one explicit approved registry. */
export class CommunicationDecisionService extends Context.Service<
  CommunicationDecisionService,
  CommunicationDecisionEvaluator
>()('@app/communications/domain/catalog/decision-service/CommunicationDecisionService') {}

export const communicationDecisionLayer = (registry: MessageTypeRegistry) =>
  Layer.succeed(CommunicationDecisionService, {
    decide: Effect.fn('Communications.decideCommunication')(
      (request: CommunicationDecisionRequest, context: CommunicationDecisionContext) =>
        Effect.succeed(decideCommunication(registry, request, context)),
    ),
  });

/** The production composition: the explicit approved registry, which currently approves no type. */
export const approvedCommunicationDecisionLayer = communicationDecisionLayer(approvedMessageTypeRegistry);
