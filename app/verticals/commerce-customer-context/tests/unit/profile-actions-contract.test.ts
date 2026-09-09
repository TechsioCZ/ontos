import { describe, expect, it } from 'effect-rstest';
import { Effect, Schema } from 'effect';
import { createActionCollector } from '../../../../packages/core-runtime/src/actions/collector.ts';
import { getActionHandler } from '../../../../packages/core-runtime/src/actions/definition.ts';
import { archiveCustomerProfileAction } from '../../src/actions/archive-customer-profile.action.ts';
import { attributeGuestRetailCustomerAction } from '../../src/actions/attribute-guest-retail-customer.action.ts';
import { bindRetailPortalProfileAction } from '../../src/actions/bind-retail-portal-profile.action.ts';
import { createCounterpartyPurchasingProfileAction } from '../../src/actions/create-counterparty-purchasing-profile.action.ts';
import {
  ensureRetailCustomerProfileAction,
  EnsureRetailCustomerProfilePayloadSchema,
  EnsureRetailCustomerProfileRejected,
} from '../../src/actions/ensure-retail-customer-profile.action.ts';
import {
  OpenProfileReconciliationPayloadSchema,
  openProfileReconciliationAction,
} from '../../src/actions/open-profile-reconciliation.action.ts';
import { reactivateCustomerProfileAction } from '../../src/actions/reactivate-customer-profile.action.ts';
import { recoverRetailPortalProfileBindingAction } from '../../src/actions/recover-retail-portal-profile-binding.action.ts';
import { resolveProfileReconciliationAction } from '../../src/actions/resolve-profile-reconciliation.action.ts';
import { revokeRetailPortalProfileBindingAction } from '../../src/actions/revoke-retail-portal-profile-binding.action.ts';
import { suspendCustomerProfileAction } from '../../src/actions/suspend-customer-profile.action.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const actionRegistrations = [
  ensureRetailCustomerProfileAction,
  createCounterpartyPurchasingProfileAction,
  suspendCustomerProfileAction,
  reactivateCustomerProfileAction,
  archiveCustomerProfileAction,
  bindRetailPortalProfileAction,
  recoverRetailPortalProfileBindingAction,
  revokeRetailPortalProfileBindingAction,
  openProfileReconciliationAction,
  resolveProfileReconciliationAction,
  attributeGuestRetailCustomerAction,
] as const;

describe('customer profile Actions', () => {
  it('retains generated registration identity and fail-closed execution metadata', () => {
    expect(actionRegistrations.map(({ descriptor }) => descriptor.actionKey)).toHaveLength(11);
    for (const { descriptor } of actionRegistrations) {
      expect(descriptor.actionKey.startsWith('commerce.customer-context.')).toBe(true);
      expect(descriptor.idempotency).toBe('required');
      expect(descriptor.legalEntityScope).toBe('required');
      expect(descriptor.entrypoint.authorization).toEqual({
        kind: 'action_execution',
        provisioning: 'explicit',
      });
    }
  });

  it('accepts only an explicit tenant-consistent retail subject and create trigger', () => {
    const payload = Schema.decodeUnknownSync(EnsureRetailCustomerProfilePayloadSchema)({
      effectiveAt: '2026-09-09T10:00:00.000Z',
      subject: {
        kind: 'RETAIL',
        partyRef: {
          moduleId: 'party.registry',
          resourceId: 'party-1',
          resourceType: 'party.registry.party',
          tenantId,
        },
        sellingLegalEntityRef: {
          moduleId: 'core.identity',
          resourceId: 'seller-1',
          resourceType: 'core.identity.legal-entity',
          tenantId,
        },
      },
      trigger: 'ENSURE_BEFORE_ORDER_ACCEPTANCE',
    });
    expect(payload.subject.kind).toBe('RETAIL');
    expect(payload.trigger).toBe('ENSURE_BEFORE_ORDER_ACCEPTANCE');
  });

  it('exposes retryability explicitly on unavailable and indeterminate failures', () => {
    const failure = new EnsureRetailCustomerProfileRejected({
      code: 'PERSISTENCE_UNAVAILABLE',
      reason: 'owner store unavailable',
      retryable: true,
    });
    expect(Schema.is(EnsureRetailCustomerProfileRejected)(failure)).toBe(true);
    expect(failure.retryable).toBe(true);
  });

  it('requires explicit canonicalization authority and never derives a target from member order', () => {
    const profileRef = (resourceId: string) => ({
      kind: 'COUNTERPARTY' as const,
      moduleId: 'commerce.customer-context' as const,
      resourceId,
      resourceType: 'commerce.customer-context.counterparty-purchasing-profile' as const,
      tenantId,
    });
    const base = {
      canonicalizationEvidence: {
        decisionRef: 'operator-decision-1',
        evidenceKind: 'AUTHORIZED_OPERATOR_DECISION' as const,
        observedAt: '2026-09-09T09:59:00.000Z',
        policyVersion: 'profile-reconciliation-operator-v1',
      },
      detectedAt: '2026-09-09T10:00:00.000Z',
      evidenceRef: 'collision-evidence-1',
      profileRefs: [profileRef('profile-1'), profileRef('profile-2')],
      reason: 'Authorized import collision decision',
      targetSubject: {
        counterpartyRef: {
          moduleId: 'party.registry' as const,
          resourceId: 'counterparty-canonical',
          resourceType: 'party.registry.counterparty' as const,
          tenantId,
        },
        kind: 'COUNTERPARTY' as const,
      },
      trigger: 'IMPORT_CORRELATION' as const,
    };

    expect(Schema.is(OpenProfileReconciliationPayloadSchema)(base)).toBe(true);
    expect(
      Schema.is(OpenProfileReconciliationPayloadSchema)({ ...base, trigger: 'COUNTERPARTY_ALIAS' }),
    ).toBe(false);
  });

  it.effect('rejects a payload legal entity that differs from the trusted operational scope', () =>
    Effect.gen(function* rejectsMismatchedLegalEntity() {
      const payload = Schema.decodeUnknownSync(
        attributeGuestRetailCustomerAction.descriptor.payloadSchema,
      )({
        correlationRoot: 'checkout-1',
        guestEvidenceRef: 'guest-evidence-1',
        requestedAt: '2026-09-09T10:00:00.000Z',
        sellingLegalEntityRef: {
          moduleId: 'core.identity',
          resourceId: '20000000-0000-4000-8000-000000000002',
          resourceType: 'core.identity.legal-entity',
          tenantId,
        },
      });
      const collector = createActionCollector(
        attributeGuestRetailCustomerAction.descriptor.domainEvents,
        'commerce.customer-context',
        attributeGuestRetailCustomerAction.descriptor.accessEvidencePolicy,
        attributeGuestRetailCustomerAction.descriptor.auditEvidenceSchema,
      );
      let dependencyCalled = false;
      const failure = yield* getActionHandler(attributeGuestRetailCustomerAction)(payload, {
        actionInvocationId: '30000000-0000-4000-8000-000000000003',
        addDomainEvent: collector.addDomainEvent,
        addOutboxMessage: collector.addOutboxMessage,
        recordAuditEvidence: collector.recordAuditEvidence,
        recordDataAccess: collector.recordDataAccess,
        scope: {
          authMethod: 'system',
          correlationId: 'profile-action-scope-test',
          legalEntityId: '20000000-0000-4000-8000-000000000001',
          principalId: '30000000-0000-4000-8000-000000000003',
          tenantId,
        },
        services: {
          attribute: () => {
            dependencyCalled = true;
            return Effect.succeed({ outcome: 'PARTY_UNRESOLVED' as const });
          },
        },
      }).pipe(Effect.flip);

      expect(failure.code).toBe('CURRENT_STATE_CONFLICT');
      expect(dependencyCalled).toBe(false);
      expect(collector.snapshot().domainEvents).toHaveLength(0);
      expect(collector.snapshot().outboxMessages).toHaveLength(0);
    }),
  );

  it.effect('records exact Party and profile access before publishing guest attribution', () =>
    Effect.gen(function* recordsGuestAttributionEvidence() {
      const legalEntityId = '20000000-0000-4000-8000-000000000001';
      const payload = Schema.decodeUnknownSync(
        attributeGuestRetailCustomerAction.descriptor.payloadSchema,
      )({
        correlationRoot: 'checkout-2',
        guestEvidenceRef: 'guest-evidence-2',
        requestedAt: '2026-09-09T10:00:00.000Z',
        sellingLegalEntityRef: {
          moduleId: 'core.identity',
          resourceId: legalEntityId,
          resourceType: 'core.identity.legal-entity',
          tenantId,
        },
      });
      const collector = createActionCollector(
        attributeGuestRetailCustomerAction.descriptor.domainEvents,
        'commerce.customer-context',
        attributeGuestRetailCustomerAction.descriptor.accessEvidencePolicy,
        attributeGuestRetailCustomerAction.descriptor.auditEvidenceSchema,
      );
      yield* getActionHandler(attributeGuestRetailCustomerAction)(payload, {
        actionInvocationId: '30000000-0000-4000-8000-000000000004',
        addDomainEvent: collector.addDomainEvent,
        addOutboxMessage: collector.addOutboxMessage,
        recordAuditEvidence: collector.recordAuditEvidence,
        recordDataAccess: collector.recordDataAccess,
        scope: {
          authMethod: 'system',
          correlationId: 'profile-action-evidence-test',
          legalEntityId,
          principalId: '30000000-0000-4000-8000-000000000004',
          tenantId,
        },
        services: {
          attribute: () =>
            Effect.succeed({
              outcome: 'ATTRIBUTED' as const,
              partyRef: {
                moduleId: 'party.registry' as const,
                resourceId: 'party-2',
                resourceType: 'party.registry.party' as const,
                tenantId,
              },
              profileRef: {
                moduleId: 'commerce.customer-context' as const,
                resourceId: 'retail-profile-2',
                resourceType: 'commerce.customer-context.retail-customer-profile' as const,
                tenantId,
              },
            }),
        },
      });

      const snapshot = collector.snapshot();
      expect(snapshot.dataAccessEvents).toHaveLength(2);
      expect(snapshot.dataAccessEvents.map(({ targetResourceType }) => targetResourceType)).toEqual(
        ['party.registry.party', 'commerce.customer-context.retail-customer-profile'],
      );
      expect(snapshot.domainEvents).toHaveLength(1);
      expect(snapshot.outboxMessages).toHaveLength(1);
    }),
  );
});
