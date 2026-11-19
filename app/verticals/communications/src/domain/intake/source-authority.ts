import { Context, Effect, Layer } from 'effect';

import type { CommunicationDecisionRequest, SourceOccurrenceFacts } from '../catalog/decision-request.ts';
import { SourceOccurrenceUnavailable } from './source-authority-errors.ts';

/**
 * The source owner's CURRENT facts about the occurrence a request names (state and latest revision). Only the owner
 * can say them, so Communications asks again at the decision and at the last stoppable handoff and never infers them
 * from the request. The facts echo the occurrence and Tenant they were read for; the decision refuses facts read for
 * another request (`CommunicationContextMismatch`).
 */
export interface SourceOccurrenceAuthorityService {
  readonly read: (
    request: CommunicationDecisionRequest,
  ) => Effect.Effect<SourceOccurrenceFacts, SourceOccurrenceUnavailable>;
}

export class SourceOccurrenceAuthority extends Context.Service<
  SourceOccurrenceAuthority,
  SourceOccurrenceAuthorityService
>()('@app/communications/domain/intake/source-authority/SourceOccurrenceAuthority') {}

/**
 * The only production composition today: no source owner publishes a current-occurrence read yet (a per-owner input
 * gate of the plan), so every read fails closed and no request is decided on a guess. It is explicit so nothing is
 * decided by default or by a missing adapter.
 */
export const unavailableSourceOccurrenceAuthorityLayer = Layer.succeed(SourceOccurrenceAuthority, {
  read: () => Effect.fail(new SourceOccurrenceUnavailable({ reason: 'OWNER_UNAVAILABLE' })),
});
