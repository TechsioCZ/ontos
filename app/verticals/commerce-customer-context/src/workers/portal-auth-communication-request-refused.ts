import { Schema } from 'effect';

/**
 * Communications refused one Portal Auth request for good (#1406 D5): its public Action answered that the request itself can
 * never be admitted, so the same request delivered again would be refused again. The closed codes are Communications' own:
 * - communication_request_invalid: the request does not match the published contract;
 * - communication_request_scope_mismatch / communication_request_source_mismatch: the claimed scope or source is not the
 *   trusted scope or the verified calling module;
 * - action_request_hash_conflict: the same idempotency key already carried another request;
 * - action_policy_denied: the Action's policy refused it.
 * The worker ends such a delivery itself; it is never retried until it dead-letters.
 */
export const PortalAuthCommunicationRefusalCodeSchema = Schema.Literals([
  'action_policy_denied',
  'action_request_hash_conflict',
  'communication_request_invalid',
  'communication_request_scope_mismatch',
  'communication_request_source_mismatch',
]);
export type PortalAuthCommunicationRefusalCode = typeof PortalAuthCommunicationRefusalCodeSchema.Type;

export class PortalAuthCommunicationRequestRefused extends Schema.TaggedError<PortalAuthCommunicationRequestRefused>()(
  'PortalAuthCommunicationRequestRefused',
  { code: PortalAuthCommunicationRefusalCodeSchema },
) {}
