import { Context, Effect, Layer } from 'effect';

import { approvedMessageTypes } from './approved-registry.ts';
import { decideCommunication } from './decision.ts';
import type { CommunicationContextMismatch, CommunicationDecision } from './decision.ts';
import type { CommunicationDecisionContext, CommunicationDecisionRequest } from './decision-request.ts';
import type { TransactionalMessageType } from './message-type.ts';
import { buildMessageTypeRegistry } from './registry.ts';
import type { MessageTypeRegistry } from './registry.ts';

export interface CommunicationDecisionEvaluator {
  /** Facts gathered for another occurrence or tenant fail with CommunicationContextMismatch; all else is a value. */
  readonly decide: (
    request: CommunicationDecisionRequest,
    context: CommunicationDecisionContext,
  ) => Effect.Effect<CommunicationDecision, CommunicationContextMismatch>;
}

/** Owner-local Communication Decision evaluator over one explicit approved registry. */
export class CommunicationDecisionService extends Context.Service<
  CommunicationDecisionService,
  CommunicationDecisionEvaluator
>()('@app/communications/domain/catalog/decision-service/CommunicationDecisionService') {}

const evaluatorOver = (registry: MessageTypeRegistry): CommunicationDecisionEvaluator => ({
  decide: Effect.fn('Communications.decideCommunication')(
    (request: CommunicationDecisionRequest, context: CommunicationDecisionContext) =>
      Effect.fromResult(decideCommunication(registry, request, context)),
  ),
});

export const communicationDecisionLayer = (registry: MessageTypeRegistry) =>
  Layer.succeed(CommunicationDecisionService, evaluatorOver(registry));

/** Composition from an approved type list: an invalid list fails the layer with MessageTypeRegistryInvalid. */
export const approvedTypesDecisionLayer = (types: readonly TransactionalMessageType[]) =>
  Layer.effect(
    CommunicationDecisionService,
    Effect.fromResult(buildMessageTypeRegistry(types)).pipe(Effect.map(evaluatorOver)),
  );

/** The production composition: the explicit approved registry, which currently approves no type. */
export const approvedCommunicationDecisionLayer = approvedTypesDecisionLayer(approvedMessageTypes);
