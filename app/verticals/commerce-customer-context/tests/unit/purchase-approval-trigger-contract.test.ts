// @effect-diagnostics-next-line nodeBuiltinImport:off -- This contract test reads checked-in production composition evidence; expires: 2027-03-31.
import { readFileSync } from 'node:fs';

import type { OperationalScope } from '@app/core-runtime';
import { expect, it } from 'effect-rstest';
import { Schema } from 'effect';
import { getActionBusinessPermissionTargetResolver } from '../../../../packages/core-runtime/src/actions/definition.ts';
import { mapTriggerPurchaseApprovalActionProblem } from '../../api/trigger-purchase-approval-action-problems.ts';
import { TriggerPurchaseApprovalPayloadSchema } from '../../shared/actions/trigger-purchase-approval.ts';
import { PurchaseApprovalSubmissionResultSchema } from '../../shared/domain/purchase-limit-approval-trigger.ts';
import {
  triggerPurchaseApprovalAction,
  triggerPurchaseApprovalPermissionTarget,
} from '../../src/actions/trigger-purchase-approval.action.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const principalId = '20000000-0000-4000-8000-000000000001';
const legalEntityId = '30000000-0000-4000-8000-000000000001';
const storefrontId = 'storefront:akros-b2b';
const payload = Schema.decodeUnknownSync(TriggerPurchaseApprovalPayloadSchema)({
  counterpartyRef: {
    moduleId: 'party.registry',
    resourceId: '40000000-0000-4000-8000-000000000001',
    resourceType: 'party.registry.counterparty',
    tenantId,
  },
  expectedSourceRevisions: [
    { revision: 'counterparty-policy:1', source: 'counterparty-policy' },
    { revision: 'customer-commerce-policy:1', source: 'customer-commerce-policy' },
    { revision: 'principal-override:none:1', source: 'principal-override' },
    { revision: 'proposal:1', source: 'purchase-proposal' },
    { revision: '1', source: 'purchasing-profile' },
    { revision: 'storefront:1', source: 'storefront-context' },
  ],
  profileRef: {
    kind: 'COUNTERPARTY',
    moduleId: 'commerce.customer-context',
    resourceId: '50000000-0000-4000-8000-000000000001',
    resourceType: 'commerce.customer-context.counterparty-purchasing-profile',
    tenantId,
  },
  proposalRevisionRef: 'proposal:1',
  purchaseValue: {
    monetaryAmount: { amount: '101', currency: 'CZK' },
    roundingRuleRevision: 'pricing-rounding:3',
    sourceRef: 'proposal:1',
    sourceRevision: 'proposal:1',
  },
  storefrontId,
});
const scope = {
  authMethod: 'system',
  correlationId: 'purchase-approval-trigger-contract',
  legalEntityId,
  principalId,
  tenantId,
  trustedStorefrontId: storefrontId,
} satisfies OperationalScope;

it('declares the governed idempotent Purchase submission contract', () => {
  expect(triggerPurchaseApprovalAction.descriptor.actionKey).toBe(
    'commerce.customer-context.trigger-purchase-approval',
  );
  expect(triggerPurchaseApprovalAction.descriptor.auditProfile).toBe('sensitive');
  expect(triggerPurchaseApprovalAction.descriptor.idempotency).toBe('required');
  expect(triggerPurchaseApprovalAction.descriptor.legalEntityScope).toBe('required');
  expect(triggerPurchaseApprovalAction.descriptor.entrypoint.authorization).toEqual({
    kind: 'action_execution',
    provisioning: 'explicit',
  });
  expect(Object.keys(triggerPurchaseApprovalAction.descriptor.domainEvents)).toEqual([
    'commerce.customer-context.purchase-approval-request-submitted.v1',
  ]);
});

it('requires exact counterparty.purchase.submit authority bound to trusted Storefront scope', () => {
  const resolvePermission = getActionBusinessPermissionTargetResolver(triggerPurchaseApprovalAction);
  expect(resolvePermission?.(payload, scope)).toEqual({
    permission: 'counterparty.purchase.submit',
    target: {
      counterpartyId: payload.counterpartyRef.resourceId,
      kind: 'counterparty_storefront',
      legalEntityId,
      storefrontId,
      tenantId,
    },
    trustedStorefrontId: storefrontId,
  });

  const untrustedScope: OperationalScope = {
    authMethod: 'system',
    correlationId: 'purchase-approval-trigger-untrusted',
    legalEntityId,
    principalId,
    tenantId,
  };
  expect(triggerPurchaseApprovalPermissionTarget(payload, untrustedScope)).toEqual({
    permission: 'counterparty.purchase.submit',
    target: {
      counterpartyId: payload.counterpartyRef.resourceId,
      kind: 'counterparty_storefront',
      legalEntityId,
      storefrontId,
      tenantId,
    },
  });
});

it('accepts only counterparty-profile evidence in the public payload', () => {
  expect(Schema.is(TriggerPurchaseApprovalPayloadSchema)(payload)).toBe(true);
  expect(
    Schema.is(TriggerPurchaseApprovalPayloadSchema)({
      ...payload,
      profileRef: {
        ...payload.profileRef,
        kind: 'RETAIL',
        resourceType: 'commerce.customer-context.retail-customer-profile',
      },
    }),
  ).toBe(false);
  expect(
    Schema.is(TriggerPurchaseApprovalPayloadSchema)({
      ...payload,
      proposalRevisionRef: 'proposal:other',
    }),
  ).toBe(false);
});

it('composes the trigger currentness source from the live owner adapter', () => {
  const productionComposition = readFileSync(new URL('../../api/index.ts', import.meta.url), 'utf-8');
  expect(productionComposition).toContain('purchaseLimitEvaluationCurrentnessLive');
  expect(productionComposition).not.toContain('purchaseLimitEvaluationCurrentnessUnavailableLayer');
});

it('keeps #317 submission outcomes narrower than the owner trigger result', () => {
  expect(
    Schema.is(PurchaseApprovalSubmissionResultSchema)({
      _tag: 'APPROVAL_SUBMITTED',
      approvalRequestRef: 'approval:1',
    }),
  ).toBe(true);
  expect(Schema.is(PurchaseApprovalSubmissionResultSchema)({ _tag: 'DIRECT_PURCHASE_ALLOWED' })).toBe(false);
  expect(
    Schema.is(PurchaseApprovalSubmissionResultSchema)({
      _tag: 'APPROVAL_PRECONDITION_FAILED',
      reasonCode: 'not-owned-by-submission',
    }),
  ).toBe(false);
});

it('maps indeterminate proposal Currentness to a distinct retryable transport failure', () => {
  expect(
    mapTriggerPurchaseApprovalActionProblem({
      _tag: 'PurchaseApprovalCurrentnessIndeterminate',
      code: 'purchase_approval_currentness_indeterminate',
      reason: 'Current proposal cannot be established',
      retryable: true,
      source: 'PURCHASE_PROPOSAL',
    }),
  ).toMatchObject({
    code: 'purchase_approval_currentness_indeterminate',
    retryable: true,
    status: 503,
  });
});
