import { LegalEntityRefSchema } from '@app/core-runtime/resources/legal-entity';
import { Schema } from 'effect';

import {
  CommunicationResourceRefSchema,
  CommunicationTenantIdSchema,
  RecipientRoleSchema,
  resourceRefKey,
  RevisionSchema,
} from '../catalog/vocabulary.ts';
import type { CommunicationResourceRef } from '../catalog/vocabulary.ts';

/**
 * Original Recipient binding (#1395, PO 1B): the Message Recipient and the contact that were valid at the source
 * event, exactly as the source owner evidenced them. These schemas mirror the public Communication Request
 * contract (`@app/communications-contracts`) field for field, so the intake Action decodes the contract payload
 * straight onto them. A Message Recipient is neither a Privacy Recipient, a Party, a Principal, a Customer Profile
 * nor an e-mail address; nothing here is an address, and no Current contact can ever stand in for a missing one.
 */

/** How the owner evidences the original contact; each kind names a reference or revision, never an address. */
export const OriginalContactEvidenceSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('HISTORICAL_SNAPSHOT'), snapshotRef: CommunicationResourceRefSchema }),
  Schema.Struct({ contactRevision: RevisionSchema, kind: Schema.Literal('VERSIONED_SNAPSHOT') }),
  Schema.Struct({ kind: Schema.Literal('AUTHORITATIVE_REFERENCE') }),
]);
export type OriginalContactEvidence = typeof OriginalContactEvidenceSchema.Type;

export const OriginalContactBindingSchema = Schema.Struct({
  contactRef: CommunicationResourceRefSchema,
  evidence: OriginalContactEvidenceSchema,
});
export type OriginalContactBinding = typeof OriginalContactBindingSchema.Type;

/**
 * Trusted scope a request operated in, or a binding was evidenced in. Tenant is required; the other dimensions are
 * present only when the source fact has them. Two scopes are the same only when every dimension is.
 */
export const RecipientScopeSchema = Schema.Struct({
  counterpartyRef: Schema.optionalKey(CommunicationResourceRefSchema),
  legalEntityId: Schema.optionalKey(LegalEntityRefSchema.fields.resourceId),
  profileRef: Schema.optionalKey(CommunicationResourceRefSchema),
  storefrontRef: Schema.optionalKey(CommunicationResourceRefSchema),
  tenantId: CommunicationTenantIdSchema,
});
export type RecipientScope = typeof RecipientScopeSchema.Type;

/** One recipient as the source event fixed it. `originalContact` is absent when the source cannot evidence it. */
export const OriginalRecipientBindingSchema = Schema.Struct({
  originalContact: Schema.optionalKey(OriginalContactBindingSchema),
  recipientRef: CommunicationResourceRefSchema,
  role: RecipientRoleSchema,
  scope: RecipientScopeSchema,
  validAt: Schema.DateTimeUtcFromString,
});
export type OriginalRecipientBinding = typeof OriginalRecipientBindingSchema.Type;

const optionalRefKey = (ref: CommunicationResourceRef | undefined) => (ref === undefined ? '' : resourceRefKey(ref));

export const sameScope = (a: RecipientScope, b: RecipientScope) =>
  a.tenantId === b.tenantId &&
  a.legalEntityId === b.legalEntityId &&
  optionalRefKey(a.profileRef) === optionalRefKey(b.profileRef) &&
  optionalRefKey(a.counterpartyRef) === optionalRefKey(b.counterpartyRef) &&
  optionalRefKey(a.storefrontRef) === optionalRefKey(b.storefrontRef);

const evidenceDetail = (evidence: OriginalContactEvidence) => {
  if (evidence.kind === 'HISTORICAL_SNAPSHOT') {
    return resourceRefKey(evidence.snapshotRef);
  }
  return evidence.kind === 'VERSIONED_SNAPSHOT' ? String(evidence.contactRevision) : '';
};

/** Stable text identity of an original contact binding; it carries the reference and evidence, never an address. */
export const contactBindingKey = (contact: OriginalContactBinding | undefined) =>
  contact === undefined
    ? ''
    : `${resourceRefKey(contact.contactRef)}#${contact.evidence.kind}#${evidenceDetail(contact.evidence)}`;

/** Channel of an endpoint, for example `email`. A message never changes channel from the original one. */
export const EndpointChannelSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(40),
  Schema.isPattern(/^[a-z][a-z0-9-]*$/u),
);

/**
 * The original endpoint as its owner hands it over for the last stoppable handoff. The usable value is
 * `Redacted`: it prints as `<redacted>`, is never part of evidence, history or a log, and only the handoff adapter
 * unwraps it. `contactRef` and `contactRevision` echo which contact the owner resolved, so a gate that answered for
 * another contact is caught. `mask` is the only form that may be stored.
 */
export const ProtectedEndpointSchema = Schema.Struct({
  channel: EndpointChannelSchema,
  contactRef: CommunicationResourceRefSchema,
  contactRevision: Schema.optionalKey(RevisionSchema),
  mask: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80)),
  value: Schema.Redacted(Schema.String),
});
export type ProtectedEndpoint = typeof ProtectedEndpointSchema.Type;
