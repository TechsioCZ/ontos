import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import { expect, it } from 'effect-rstest';
import { Predicate, Schema } from 'effect';
import { readFileSync } from 'node:fs';
import { getActionBusinessPermissionTargetResolver } from '../../../../packages/core-runtime/src/actions/definition.ts';
import { getReadPermissionTargetResolver } from '../../../../packages/core-runtime/src/reads/definition.ts';
import { PurchaseLimitEvaluationRequestSchema } from '../../shared/apis/purchase-limit-evaluation.ts';
import { PurchaseLimitPolicyReadRequestSchema } from '../../shared/apis/purchase-limit-policy-read.ts';
import { OutboxPayloadSchema as CounterpartyPurchaseLimitChangedOutboxPayloadSchema } from '../../shared/outbox/commerce-customer-context-counterparty-purchase-limit-changed-v1.ts';
import { OutboxPayloadSchema as PrincipalPurchaseLimitOverrideChangedOutboxPayloadSchema } from '../../shared/outbox/commerce-customer-context-principal-purchase-limit-override-changed-v1.ts';
import { createChangeCounterpartyPurchaseLimitCommerceCustomerContextCounterpartyPurchaseLimitChangedV1OutboxMessage } from '../../src/actions/change-counterparty-purchase-limit.commerce-customer-context-counterparty-purchase-limit-changed-v1.outbox-message.ts';
import {
  ChangeCounterpartyPurchaseLimitPayloadSchema,
  changeCounterpartyPurchaseLimitAction,
} from '../../src/actions/change-counterparty-purchase-limit.action.ts';
import { createChangePrincipalPurchaseLimitOverrideCommerceCustomerContextPrincipalPurchaseLimitOverrideChangedV1OutboxMessage } from '../../src/actions/change-principal-purchase-limit-override.commerce-customer-context-principal-purchase-limit-override-changed-v1.outbox-message.ts';
import {
  ChangePrincipalPurchaseLimitOverridePayloadSchema,
  changePrincipalPurchaseLimitOverrideAction,
} from '../../src/actions/change-principal-purchase-limit-override.action.ts';
import { purchaseLimitEvaluationRead } from '../../src/api/purchase-limit-evaluation.read.ts';
import { purchaseLimitPolicyReadRead } from '../../src/api/purchase-limit-policy-read.read.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const principalId = '20000000-0000-4000-8000-000000000001';
const legalEntityId = '30000000-0000-4000-8000-000000000001';
const counterpartyRef = {
  moduleId: 'party.registry',
  resourceId: '40000000-0000-4000-8000-000000000001',
  resourceType: 'party.registry.counterparty',
  tenantId,
} as const;
const principalRef = { principalId, tenantId } as const;
const principal = Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
  authBindingId: '50000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:purchase-limit-contract-test',
  authMethod: 'session',
  legalEntityId,
  principalId,
  tenantId,
});
const scope = {
  ...principal,
  correlationId: 'purchase-limit-contract-test',
} satisfies OperationalScope;

it('limit mutations require exact counterparty Purchase Limit management permission', () => {
  const defaultPayload = Schema.decodeUnknownSync(ChangeCounterpartyPurchaseLimitPayloadSchema)({
    change: {
      _tag: 'SET',
      policy: { _tag: 'MONETARY_LIMIT', limit: { amount: '100', currency: 'CZK' } },
    },
    counterpartyRef,
    expectedRevision: null,
    reason: 'Signed purchasing authority update',
  });
  const overridePayload = Schema.decodeUnknownSync(
    ChangePrincipalPurchaseLimitOverridePayloadSchema,
  )({
    ...defaultPayload,
    change: { _tag: 'SET', policy: { _tag: 'UNLIMITED' } },
    principalRef,
  });
  const defaultTarget = getActionBusinessPermissionTargetResolver(
    changeCounterpartyPurchaseLimitAction,
  )?.(defaultPayload, scope);
  const overrideTarget = getActionBusinessPermissionTargetResolver(
    changePrincipalPurchaseLimitOverrideAction,
  )?.(overridePayload, scope);

  for (const target of [defaultTarget, overrideTarget]) {
    expect(target).toEqual({
      permission: 'counterparty.purchase_limit.manage',
      target: {
        counterpartyId: counterpartyRef.resourceId,
        kind: 'counterparty',
        legalEntityId,
        tenantId,
      },
    });
  }
  expect(changeCounterpartyPurchaseLimitAction.descriptor.auditProfile).toBe('sensitive');
  expect(changeCounterpartyPurchaseLimitAction.descriptor.idempotency).toBe('required');
  expect(Object.keys(changeCounterpartyPurchaseLimitAction.descriptor.domainEvents)).toEqual([
    'commerce.customer-context.counterparty-purchase-limit-changed.v1',
  ]);
  expect(Object.keys(changePrincipalPurchaseLimitOverrideAction.descriptor.domainEvents)).toEqual([
    'commerce.customer-context.principal-purchase-limit-override-changed.v1',
  ]);
});

it('uses submit authority only when Storefront identity comes from trusted scope', () => {
  const policyInput = Schema.decodeUnknownSync(PurchaseLimitPolicyReadRequestSchema)({
    counterpartyRef,
    principalRef,
  });
  const evaluationInput = Schema.decodeUnknownSync(PurchaseLimitEvaluationRequestSchema)({
    counterpartyRef,
    expectedSourceRevisions: [
      { revision: 'counterparty-policy:1', source: 'counterparty-policy' },
      { revision: 'customer-commerce-policy:1', source: 'customer-commerce-policy' },
      { revision: 'principal-override:none:1', source: 'principal-override' },
      { revision: 'proposal:1', source: 'purchase-proposal' },
      { revision: '1', source: 'purchasing-profile' },
      { revision: 'storefront:1', source: 'storefront-context' },
    ],
    purchaseValue: {
      monetaryAmount: { amount: '100', currency: 'CZK' },
      roundingRuleRevision: 'pricing-rounding:3',
      sourceRef: 'proposal:1',
      sourceRevision: 'proposal:1',
    },
    storefrontId: 'storefront:akros-b2b',
  });
  const resolvePolicyTarget = getReadPermissionTargetResolver(purchaseLimitPolicyReadRead);
  if (!Predicate.isFunction(resolvePolicyTarget)) {
    throw new TypeError('Purchase Limit policy Read must declare a permission target');
  }
  expect(resolvePolicyTarget(policyInput, scope)).toEqual({
    businessPermission: {
      permission: 'counterparty.purchase_limit.manage',
      target: {
        counterpartyId: counterpartyRef.resourceId,
        kind: 'counterparty',
        legalEntityId,
        tenantId,
      },
    },
    kind: 'business_permission',
  });
  const resolveEvaluationTarget = getReadPermissionTargetResolver(purchaseLimitEvaluationRead);
  if (!Predicate.isFunction(resolveEvaluationTarget)) {
    throw new TypeError('Purchase Limit evaluation Read must declare a permission target');
  }
  expect(resolveEvaluationTarget(evaluationInput, scope)).toEqual({
    businessPermission: {
      permission: 'counterparty.purchase.submit',
      target: {
        counterpartyId: counterpartyRef.resourceId,
        kind: 'counterparty_storefront',
        legalEntityId,
        storefrontId: 'storefront:akros-b2b',
        tenantId,
      },
    },
    kind: 'business_permission',
  });
  expect(
    resolveEvaluationTarget(evaluationInput, {
      ...scope,
      trustedStorefrontId: 'storefront:akros-b2b',
    }),
  ).toEqual({
    businessPermission: {
      permission: 'counterparty.purchase.submit',
      target: {
        counterpartyId: counterpartyRef.resourceId,
        kind: 'counterparty_storefront',
        legalEntityId,
        storefrontId: 'storefront:akros-b2b',
        tenantId,
      },
    },
    kind: 'business_permission',
    trustedStorefrontId: 'storefront:akros-b2b',
  });
});

it('wire contracts reject implicit unlimited, invalid amounts, and unscoped principals', () => {
  const base = {
    counterpartyRef,
    expectedRevision: null,
    reason: 'Policy update',
  };
  expect(
    Schema.is(ChangeCounterpartyPurchaseLimitPayloadSchema)({ ...base, change: { _tag: 'SET' } }),
  ).toBe(false);
  expect(
    Schema.is(ChangeCounterpartyPurchaseLimitPayloadSchema)({
      ...base,
      change: {
        _tag: 'SET',
        policy: { _tag: 'MONETARY_LIMIT', limit: { amount: '-1', currency: 'CZK' } },
      },
    }),
  ).toBe(false);
  expect(
    Schema.is(ChangePrincipalPurchaseLimitOverridePayloadSchema)({
      ...base,
      change: { _tag: 'SET', policy: { _tag: 'UNLIMITED' } },
      principalRef: { principalId },
    }),
  ).toBe(false);
});

it('publishes only exact safe Purchase Limit invalidation facts', () => {
  const policyRef = {
    moduleId: 'commerce.customer-context',
    resourceId: '60000000-0000-4000-8000-000000000001',
    resourceType: 'commerce.customer-context.purchase-limit-policy',
    tenantId,
  } as const;
  const defaultPayload = {
    changeKind: 'SET',
    counterpartyRef,
    currentPolicyRef: policyRef,
    currentRevision: 1,
    currentState: 'EXPLICIT_DEFAULT_CURRENT',
    previousPolicyRef: null,
    previousRevision: null,
  } as const;
  const overridePayload = {
    ...defaultPayload,
    currentState: 'EXPLICIT_OVERRIDE_CURRENT',
    principalRef,
  } as const;
  const decodedDefaultPayload = Schema.decodeUnknownSync(
    CounterpartyPurchaseLimitChangedOutboxPayloadSchema,
  )(defaultPayload);
  const decodedOverridePayload = Schema.decodeUnknownSync(
    PrincipalPurchaseLimitOverrideChangedOutboxPayloadSchema,
  )(overridePayload);
  expect(Schema.is(CounterpartyPurchaseLimitChangedOutboxPayloadSchema)(defaultPayload)).toBe(true);
  expect(
    Schema.is(CounterpartyPurchaseLimitChangedOutboxPayloadSchema)({ data: defaultPayload }),
  ).toBe(false);
  expect(Schema.is(PrincipalPurchaseLimitOverrideChangedOutboxPayloadSchema)(overridePayload)).toBe(
    true,
  );
  const messages = [
    createChangeCounterpartyPurchaseLimitCommerceCustomerContextCounterpartyPurchaseLimitChangedV1OutboxMessage(
      decodedDefaultPayload,
    ),
    createChangePrincipalPurchaseLimitOverrideCommerceCustomerContextPrincipalPurchaseLimitOverrideChangedV1OutboxMessage(
      decodedOverridePayload,
    ),
  ];
  expect(messages.map(({ topic }) => topic)).toEqual([
    'commerce.customer-context.counterparty-purchase-limit-changed.v1',
    'commerce.customer-context.principal-purchase-limit-override-changed.v1',
  ]);
  expect(messages[0]?.payloadJson).toEqual(decodedDefaultPayload);
  expect(messages[1]?.payloadJson).toEqual(decodedOverridePayload);
  for (const message of messages) {
    expect(message.producerModuleKey).toBe('commerce.customer-context');
  }
});

it('forwards trusted invocation evidence and attaches each message only inside material change', () => {
  const actionSources = [
    'change-counterparty-purchase-limit.action.ts',
    'change-principal-purchase-limit-override.action.ts',
  ].map((file) =>
    readFileSync(new URL(`../../src/actions/${file}`, import.meta.url), { encoding: 'utf-8' }),
  );
  for (const source of actionSources) {
    expect(source).toContain("if (result.status === 'CHANGED') {");
    expect(source).toContain('actionInvocationId: context.actionInvocationId');
    expect(source).toContain('actorPrincipalId: context.scope.principalId');
    expect(source).toContain('const event = yield* context.addDomainEvent({');
    expect(source).toContain('yield* context.addOutboxMessage(');
    expect(source).toContain('event,');
    expect(source.match(/context\.addOutboxMessage\(/gu)).toHaveLength(1);
  }
});
