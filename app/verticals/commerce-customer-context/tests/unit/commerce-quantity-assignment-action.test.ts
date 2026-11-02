import { expect, it } from 'effect-rstest';
import { Effect, Schema } from 'effect';
import { createActionCollector } from '../../../../packages/core-runtime/src/actions/collector.ts';
import { getActionHandler } from '../../../../packages/core-runtime/src/actions/definition.ts';
import { assignCommerceQuantityRuleAction } from '../../src/actions/assign-commerce-quantity-rule.action.ts';
import type { CustomerCommercePolicyAdministrationService } from '../../src/services/customer-commerce-policy-administration.service.ts';
import {
  CommerceQuantityAssignmentPayloadSchema,
  CustomerCommercePolicyAdministrationRejected,
  toTrustedCommerceQuantityAssignmentCommand,
} from '../../shared/domain/customer-commerce-policy-administration.ts';
import type { CommerceQuantityAssignmentCommand } from '../../shared/domain/customer-commerce-policy-administration.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const foreignTenantId = '22222222-2222-4222-8222-222222222222';
const actionInvocationId = '33333333-3333-4333-8333-333333333333';
const principalId = '44444444-4444-4444-8444-444444444444';
const legalEntityId = '55555555-5555-4555-8555-555555555555';
const observedAt = '2026-10-20T10:00:00.000Z';
const assignmentPayload = (kind: 'RETAIL' | 'COUNTERPARTY', profileTenantId = tenantId, ruleTenantId = tenantId) =>
  Schema.decodeUnknownSync(CommerceQuantityAssignmentPayloadSchema)({
    _tag: 'ASSIGN',
    assignment: {
      assignmentId: '66666666-6666-4666-8666-666666666666',
      effectiveFrom: observedAt,
      effectiveTo: null,
      idempotencyKey: 'assignment-scope-regression',
      lifecycle: 'ACTIVE',
      profile: {
        kind,
        profileRef: {
          moduleId: 'commerce.customer-context',
          resourceId: '77777777-7777-4777-8777-777777777777',
          resourceType:
            kind === 'RETAIL'
              ? 'commerce.customer-context.retail-customer-profile'
              : 'commerce.customer-context.counterparty-purchasing-profile',
          tenantId: profileTenantId,
        },
      },
      reason: 'Verify trusted assignment scope',
      ruleRevisionRef: {
        moduleId: 'commerce.customer-context',
        resourceId: '88888888-8888-4888-8888-888888888888',
        resourceType: 'commerce.customer-context.commerce-quantity-rule',
        tenantId: ruleTenantId,
      },
    },
    expectedGeneration: 0,
  });

const unreachable = () => Effect.die('Unexpected unrelated policy service call');

const actionContext = (assign: CustomerCommercePolicyAdministrationService['assignCommerceQuantityRule']) => {
  const action = assignCommerceQuantityRuleAction;
  const collector = createActionCollector(
    action.descriptor.domainEvents,
    'commerce.customer-context',
    action.descriptor.accessEvidencePolicy,
    action.descriptor.auditEvidenceSchema,
  );
  const services: CustomerCommercePolicyAdministrationService = {
    administerCommerceQuantityRule: unreachable,
    administerMarketBootstrapPolicy: unreachable,
    administerPaymentTermPolicy: unreachable,
    administerPurchaseCurrencyPolicy: unreachable,
    assignCommerceQuantityRule: assign,
    readCurrentCommerceQuantityAssignments: unreachable,
    readCurrentCommerceQuantityPolicy: unreachable,
    readCurrentCommerceQuantityRules: unreachable,
    readCurrentMarketBootstrapPolicy: unreachable,
    readCurrentMarketBootstrapPolicyCandidates: unreachable,
    readCurrentPaymentTermPolicy: unreachable,
    readCurrentPurchaseCurrencyPolicy: unreachable,
  };
  return {
    collector,
    context: {
      actionInvocationId,
      addDomainEvent: collector.addDomainEvent,
      addOutboxMessage: collector.addOutboxMessage,
      compositionRevision: 'a'.repeat(64),
      recordAuditEvidence: collector.recordAuditEvidence,
      recordDataAccess: collector.recordDataAccess,
      scope: {
        authMethod: 'system' as const,
        correlationId: 'assignment-scope-regression',
        legalEntityId,
        principalId,
        tenantId,
      },
      services,
    },
  };
};

it.effect(
  'rejects every foreign assignment reference before strict command construction or owner service execution',
  () =>
    Effect.gen(function* rejectForeignAssignmentReferences() {
      for (const kind of ['RETAIL', 'COUNTERPARTY'] as const) {
        for (const tenants of [
          { profile: foreignTenantId, rule: tenantId },
          { profile: tenantId, rule: foreignTenantId },
          { profile: foreignTenantId, rule: foreignTenantId },
        ]) {
          const { collector, context } = actionContext(() => Effect.die('Foreign scope reached owner service'));
          const before = collector.snapshot();
          const payload = assignmentPayload(kind, tenants.profile, tenants.rule);
          const failure = yield* getActionHandler(assignCommerceQuantityRuleAction)(payload, context).pipe(Effect.flip);
          expect(Schema.is(CustomerCommercePolicyAdministrationRejected)(failure)).toBe(true);
          expect(failure).toMatchObject({
            code: 'SCOPE_MISMATCH',
            reason: 'Assignment references do not match the trusted scope',
            retryable: false,
          });
          expect(collector.snapshot()).toEqual(before);
        }
      }
    }),
);

it.effect('keeps same-Tenant assignment and UNASSIGN delegation on the original trusted command path', () =>
  Effect.gen(function* delegateTrustedQuantityCommands() {
    const serviceFailure = new CustomerCommercePolicyAdministrationRejected({
      code: 'GENERATION_CONFLICT',
      reason: 'Owner service reached with the trusted command',
      retryable: false,
    });
    const unassign = Schema.decodeUnknownSync(CommerceQuantityAssignmentPayloadSchema)({
      _tag: 'UNASSIGN',
      assignmentId: '66666666-6666-4666-8666-666666666666',
      effectiveAt: observedAt,
      expectedGeneration: 0,
      idempotencyKey: 'unassignment-scope-regression',
      reason: 'Keep the original unassignment path',
    });
    for (const payload of [assignmentPayload('RETAIL'), assignmentPayload('COUNTERPARTY'), unassign]) {
      const received: CommerceQuantityAssignmentCommand[] = [];
      const { context } = actionContext((command) => {
        received.push(command);
        return Effect.fail(serviceFailure);
      });
      const failure = yield* getActionHandler(assignCommerceQuantityRuleAction)(payload, context).pipe(Effect.flip);
      expect(failure).toBe(serviceFailure);
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        actionInvocationId,
        actorPrincipalId: principalId,
        sellingLegalEntityId: legalEntityId,
        tenantId,
      });
      expect(received[0]).toMatchObject(payload);
    }
  }),
);

it('retains the strict trusted-command cross-reference Tenant invariant', () => {
  expect(() =>
    toTrustedCommerceQuantityAssignmentCommand(
      assignmentPayload('RETAIL', foreignTenantId),
      { actionInvocationId, actorPrincipalId: principalId, sellingLegalEntityId: legalEntityId, tenantId },
      observedAt,
    ),
  ).toThrow('Profile and Quantity Rule Revision must share one Tenant');
});
