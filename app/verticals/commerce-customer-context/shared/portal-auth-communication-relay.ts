import { CommunicationRequestSchema } from '@app/communications-contracts/communication-request';
import { Schema } from 'effect';

/**
 * What the Portal Auth relay hands to this module's own source worker (#1406 D1): ONE committed, secret-free Communication
 * Request in the published Communications contract's encoded (JSON) form. It carries references and closed keys only; the
 * source worker decodes it through the same contract before it submits it, and Communications judges it again.
 */
export const RelayPortalAuthCommunicationRequestPayloadSchema = Schema.Struct({
  request: Schema.toEncoded(CommunicationRequestSchema),
});
export type RelayPortalAuthCommunicationRequestPayload = typeof RelayPortalAuthCommunicationRequestPayloadSchema.Type;

/** The request is queued for the source worker; whether a message leaves is decided by Communications, never here. */
export const RelayPortalAuthCommunicationRequestResultSchema = Schema.Struct({
  outcome: Schema.Literal('RELAYED'),
});
export type RelayPortalAuthCommunicationRequestResult = typeof RelayPortalAuthCommunicationRequestResultSchema.Type;
