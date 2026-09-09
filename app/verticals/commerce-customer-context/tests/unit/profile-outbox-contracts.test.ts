import { expect, it } from 'effect-rstest';
import { Schema } from 'effect';
import { OutboxPayloadSchema as archivedSchema } from '../../shared/outbox/commerce-customer-context-customer-profile-archived-v1.ts';
import { OutboxPayloadSchema as counterpartyCreatedSchema } from '../../shared/outbox/commerce-customer-context-counterparty-purchasing-profile-created-v1.ts';
import { OutboxPayloadSchema as guestAttributedSchema } from '../../shared/outbox/commerce-customer-context-guest-retail-customer-attributed-v1.ts';
import { OutboxPayloadSchema as reactivatedSchema } from '../../shared/outbox/commerce-customer-context-customer-profile-reactivated-v1.ts';
import { OutboxPayloadSchema as reconciliationCompletedSchema } from '../../shared/outbox/commerce-customer-context-profile-reconciliation-completed-v1.ts';
import { OutboxPayloadSchema as reconciliationOpenedSchema } from '../../shared/outbox/commerce-customer-context-profile-reconciliation-opened-v1.ts';
import { OutboxPayloadSchema as retailCreatedSchema } from '../../shared/outbox/commerce-customer-context-retail-customer-profile-created-v1.ts';
import { OutboxPayloadSchema as bindingActivatedSchema } from '../../shared/outbox/commerce-customer-context-retail-portal-profile-binding-activated-v1.ts';
import { OutboxPayloadSchema as bindingRecoveredSchema } from '../../shared/outbox/commerce-customer-context-retail-portal-profile-binding-recovered-v1.ts';
import { OutboxPayloadSchema as bindingRevokedSchema } from '../../shared/outbox/commerce-customer-context-retail-portal-profile-binding-revoked-v1.ts';
import { OutboxPayloadSchema as suspendedSchema } from '../../shared/outbox/commerce-customer-context-customer-profile-suspended-v1.ts';
import { ProfileReconciliationCaseRefSchema } from '../../shared/resources/profile-reconciliation-case.ts';
import { createArchiveCustomerProfileCommerceCustomerContextCustomerProfileArchivedV1OutboxMessage } from '../../src/actions/archive-customer-profile.commerce-customer-context-customer-profile-archived-v1.outbox-message.ts';
import { createAttributeGuestRetailCustomerCommerceCustomerContextGuestRetailCustomerAttributedV1OutboxMessage } from '../../src/actions/attribute-guest-retail-customer.commerce-customer-context-guest-retail-customer-attributed-v1.outbox-message.ts';
import { createBindRetailPortalProfileCommerceCustomerContextRetailPortalProfileBindingActivatedV1OutboxMessage } from '../../src/actions/bind-retail-portal-profile.commerce-customer-context-retail-portal-profile-binding-activated-v1.outbox-message.ts';
import { createCreateCounterpartyPurchasingProfileCommerceCustomerContextCounterpartyPurchasingProfileCreatedV1OutboxMessage } from '../../src/actions/create-counterparty-purchasing-profile.commerce-customer-context-counterparty-purchasing-profile-created-v1.outbox-message.ts';
import { createEnsureRetailCustomerProfileCommerceCustomerContextRetailCustomerProfileCreatedV1OutboxMessage } from '../../src/actions/ensure-retail-customer-profile.commerce-customer-context-retail-customer-profile-created-v1.outbox-message.ts';
import { createOpenProfileReconciliationCommerceCustomerContextProfileReconciliationOpenedV1OutboxMessage } from '../../src/actions/open-profile-reconciliation.commerce-customer-context-profile-reconciliation-opened-v1.outbox-message.ts';
import { createReactivateCustomerProfileCommerceCustomerContextCustomerProfileReactivatedV1OutboxMessage } from '../../src/actions/reactivate-customer-profile.commerce-customer-context-customer-profile-reactivated-v1.outbox-message.ts';
import { createRecoverRetailPortalProfileBindingCommerceCustomerContextRetailPortalProfileBindingRecoveredV1OutboxMessage } from '../../src/actions/recover-retail-portal-profile-binding.commerce-customer-context-retail-portal-profile-binding-recovered-v1.outbox-message.ts';
import { createResolveProfileReconciliationCommerceCustomerContextProfileReconciliationCompletedV1OutboxMessage } from '../../src/actions/resolve-profile-reconciliation.commerce-customer-context-profile-reconciliation-completed-v1.outbox-message.ts';
import { createRevokeRetailPortalProfileBindingCommerceCustomerContextRetailPortalProfileBindingRevokedV1OutboxMessage } from '../../src/actions/revoke-retail-portal-profile-binding.commerce-customer-context-retail-portal-profile-binding-revoked-v1.outbox-message.ts';
import { createSuspendCustomerProfileCommerceCustomerContextCustomerProfileSuspendedV1OutboxMessage } from '../../src/actions/suspend-customer-profile.commerce-customer-context-customer-profile-suspended-v1.outbox-message.ts';

const JsonObjectSchema = Schema.Record(Schema.String, Schema.Json);
const tenantId = '10000000-0000-4000-8000-000000000001';
const effectiveAt = '2026-09-09T10:00:00.000Z';
const partyRef = {
  moduleId: 'party.registry',
  resourceId: 'party-1',
  resourceType: 'party.registry.party',
  tenantId,
} as const;
const counterpartyRef = {
  moduleId: 'party.registry',
  resourceId: 'counterparty-1',
  resourceType: 'party.registry.counterparty',
  tenantId,
} as const;
const sellingLegalEntityRef = {
  moduleId: 'core.identity',
  resourceId: 'seller-1',
  resourceType: 'core.identity.legal-entity',
  tenantId,
} as const;
const retailProfileRef = {
  moduleId: 'commerce.customer-context',
  resourceId: 'retail-profile-1',
  resourceType: 'commerce.customer-context.retail-customer-profile',
  tenantId,
} as const;
const counterpartyProfileRef = {
  moduleId: 'commerce.customer-context',
  resourceId: 'counterparty-profile-1',
  resourceType: 'commerce.customer-context.counterparty-purchasing-profile',
  tenantId,
} as const;
const bindingRef = {
  moduleId: 'commerce.customer-context',
  resourceId: 'binding-1',
  resourceType: 'commerce.customer-context.retail-portal-profile-binding',
  tenantId,
} as const;
const principalRef = {
  moduleId: 'core.identity',
  resourceId: 'principal-1',
  resourceType: 'core.identity.principal',
  tenantId,
} as const;
const caseRef = Schema.decodeUnknownSync(ProfileReconciliationCaseRefSchema)({
  moduleId: 'commerce.customer-context',
  resourceId: 'case-1',
  resourceType: 'commerce.customer-context.profile-reconciliation-case',
  tenantId,
});
const taggedRetailProfileRef = { ...retailProfileRef, kind: 'RETAIL' as const };
const taggedCounterpartyProfileRef = { ...counterpartyProfileRef, kind: 'COUNTERPARTY' as const };
const retailCreated = {
  effectiveAt,
  profileRef: retailProfileRef,
  revision: 1,
  state: 'ACTIVE',
  subject: { kind: 'RETAIL', partyRef, sellingLegalEntityRef },
  trigger: 'ENSURE_BEFORE_ORDER_ACCEPTANCE',
} as const;
const counterpartyCreated = {
  effectiveAt,
  profileRef: counterpartyProfileRef,
  revision: 1,
  state: 'ACTIVE',
  subject: { counterpartyRef, kind: 'COUNTERPARTY' },
  trigger: 'AUTHORIZED_ONBOARDING',
} as const;
const suspended = {
  effectiveAt,
  previousState: 'ACTIVE',
  profileRef: taggedRetailProfileRef,
  revision: 2,
  state: 'SUSPENDED',
} as const;
const reactivated = {
  effectiveAt,
  previousState: 'SUSPENDED',
  profileRef: taggedRetailProfileRef,
  revision: 3,
  state: 'ACTIVE',
} as const;
const archived = {
  effectiveAt,
  previousState: 'ACTIVE',
  profileRef: taggedCounterpartyProfileRef,
  revision: 2,
  state: 'ARCHIVED',
} as const;
const bindingBase = {
  bindingRef,
  effectiveAt,
  principalRef,
  profileRef: retailProfileRef,
  revision: 1,
  sellingLegalEntityRef,
} as const;
const bindingActivated = { ...bindingBase, state: 'ACTIVE' as const };
const bindingRecovered = { ...bindingBase, revision: 3, state: 'ACTIVE' as const };
const bindingRevoked = { ...bindingBase, revision: 2, state: 'REVOKED' as const };
const reconciliationOpened = {
  canonicalizationEvidence: {
    evidenceKind: 'PARTY_OWNER_OBSERVATION',
    observedAt: effectiveAt,
    policyVersion: 'party-canonicalization-v1',
    sourceDomainEventId: 'party-event-1',
    sourceEventVersion: '1',
    sourceMessageId: 'party-message-1',
    sourceOwnerModuleId: 'party.registry',
  },
  caseRef,
  detectedAt: effectiveAt,
  profileRefs: [
    taggedRetailProfileRef,
    { ...taggedRetailProfileRef, resourceId: 'retail-profile-2' },
  ],
  revision: 1,
  state: 'OPEN',
  targetSubject: { kind: 'RETAIL', partyRef, sellingLegalEntityRef },
  trigger: 'PARTY_ALIAS',
} as const;
const reconciliationCompleted = {
  caseRef,
  effectiveAt,
  resultingState: 'ACTIVE',
  revision: 2,
  state: 'COMPLETED',
  survivorProfileRef: taggedRetailProfileRef,
} as const;
const guestAttributed = {
  attributedAt: effectiveAt,
  correlationRoot: 'checkout-1',
  partyRef,
  profileRef: retailProfileRef,
  sellingLegalEntityRef,
} as const;

it('uses exact safe schemas for every profile owner message', () => {
  const cases = [
    [retailCreatedSchema, retailCreated],
    [counterpartyCreatedSchema, counterpartyCreated],
    [suspendedSchema, suspended],
    [reactivatedSchema, reactivated],
    [archivedSchema, archived],
    [bindingActivatedSchema, bindingActivated],
    [bindingRecoveredSchema, bindingRecovered],
    [bindingRevokedSchema, bindingRevoked],
    [reconciliationOpenedSchema, reconciliationOpened],
    [reconciliationCompletedSchema, reconciliationCompleted],
    [guestAttributedSchema, guestAttributed],
  ] as const;
  for (const [schema, payload] of cases) {
    expect(Schema.is(schema)(payload)).toBe(true);
    expect(Schema.is(schema)({ data: payload })).toBe(false);
  }
});

it('builds eleven distinct owner messages without generic data envelopes', () => {
  const messages = [
    createEnsureRetailCustomerProfileCommerceCustomerContextRetailCustomerProfileCreatedV1OutboxMessage(
      retailCreated,
    ),
    createCreateCounterpartyPurchasingProfileCommerceCustomerContextCounterpartyPurchasingProfileCreatedV1OutboxMessage(
      counterpartyCreated,
    ),
    createSuspendCustomerProfileCommerceCustomerContextCustomerProfileSuspendedV1OutboxMessage(
      suspended,
    ),
    createReactivateCustomerProfileCommerceCustomerContextCustomerProfileReactivatedV1OutboxMessage(
      reactivated,
    ),
    createArchiveCustomerProfileCommerceCustomerContextCustomerProfileArchivedV1OutboxMessage(
      archived,
    ),
    createBindRetailPortalProfileCommerceCustomerContextRetailPortalProfileBindingActivatedV1OutboxMessage(
      bindingActivated,
    ),
    createRecoverRetailPortalProfileBindingCommerceCustomerContextRetailPortalProfileBindingRecoveredV1OutboxMessage(
      bindingRecovered,
    ),
    createRevokeRetailPortalProfileBindingCommerceCustomerContextRetailPortalProfileBindingRevokedV1OutboxMessage(
      bindingRevoked,
    ),
    createOpenProfileReconciliationCommerceCustomerContextProfileReconciliationOpenedV1OutboxMessage(
      reconciliationOpened,
    ),
    createResolveProfileReconciliationCommerceCustomerContextProfileReconciliationCompletedV1OutboxMessage(
      reconciliationCompleted,
    ),
    createAttributeGuestRetailCustomerCommerceCustomerContextGuestRetailCustomerAttributedV1OutboxMessage(
      guestAttributed,
    ),
  ];
  expect(new Set(messages.map(({ topic }) => topic)).size).toBe(11);
  for (const message of messages) {
    expect(message.producerModuleKey).toBe('commerce.customer-context');
    const payloadObject = Schema.decodeUnknownSync(JsonObjectSchema)(message.payloadJson);
    expect('data' in payloadObject).toBe(false);
  }
});
