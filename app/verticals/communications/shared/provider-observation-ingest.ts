import { ProviderObservationInputSchema } from '@app/communications-contracts/message-handoff';
import { Schema } from 'effect';

/**
 * The public contract of the provider observation ingest (#1402, #1403): the Messaging Adapter (step 22) hands Communications
 * ONE piece of evidence about ONE attempt, the published `ProviderObservationInput`, and learns what became of it. The Tenant
 * inside it is a CLAIM checked against the Core-verified scope, never used to choose where anything is stored.
 *
 * The answer is data, never a refusal that leaks a row: the same `UNBOUND` is given for another Tenant's intent, an unknown
 * intent and an attempt of another intent.
 * - RECORDED: appended as a new observation;  DUPLICATE: the very same observation again, nothing changes;
 * - CONFLICT: the same identity (attempt, provider, key AND evidence kind) with another content: the first stays untouched and
 *   the disagreement is kept as a trace, so the history says the evidence is contradictory until a reconciliation settles it;
 * - UNBOUND: Tenant, intent and attempt do not belong together;
 * - NOT_SUBMITTED: the attempt provably submitted nothing (no adapter, no request made, or a message proven malformed);
 * - PROVIDER_MISMATCH: another provider identity than the one the attempt is bound to.
 * Nothing here says delivered: delivery exists only as a provider event the adapter proved (`DELIVERY_PROVEN`).
 */
export const IngestProviderObservationPayloadSchema = ProviderObservationInputSchema;
export type IngestProviderObservationPayload = typeof IngestProviderObservationPayloadSchema.Type;

export const IngestOutcomeSchema = Schema.Literals([
  'CONFLICT',
  'DUPLICATE',
  'NOT_SUBMITTED',
  'PROVIDER_MISMATCH',
  'RECORDED',
  'UNBOUND',
]);
export type IngestOutcome = typeof IngestOutcomeSchema.Type;

export const IngestProviderObservationResultSchema = Schema.Struct({ outcome: IngestOutcomeSchema });
export type IngestProviderObservationResult = typeof IngestProviderObservationResultSchema.Type;
