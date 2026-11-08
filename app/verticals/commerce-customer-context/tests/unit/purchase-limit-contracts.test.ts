import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import { expect, it } from 'effect-rstest';
import { Predicate, Schema } from 'effect';
import { getActionOwnerFactsResolver } from '../../../../packages/core-runtime/src/actions/definition.ts';
import { getReadOwnerFactsResolver } from '../../../../packages/core-runtime/src/reads/definition.ts';
import { PurchaseLimitEvaluationRequestSchema } from '../../shared/apis/purchase-limit-evaluation.ts';
import { PurchaseLimitPolicyReadRequestSchema } from '../../shared/apis/purchase-limit-policy-read.ts';
import { OutboxPayloadSchema as CounterpartyPurchaseLimitChangedOutboxPayloadSchema } from '../../shared/outbox/commerce-customer-context-counterparty-purchase-limit-changed-v1.ts';
import { OutboxPayloadSchema as PrincipalPurchaseLimitOverrideChangedOutboxPayloadSchema } from '../../shared/outbox/commerce-customer-context-principal-purchase-limit-override-changed-v1.ts';
import { createChangeCounterpartyPurchaseLimitCommerceCustomerContextCounterpartyPurchaseLimitChangedV1OutboxMessage } from '../../src/actions/change-counterparty-purchase-limit.commerce-customer-context-counterparty-purchase-limit-changed-v1.outbox-message.ts';
import { changeCounterpartyPurchaseLimitAction } from '../../src/actions/change-counterparty-purchase-limit.action.ts';
import { ChangeCounterpartyPurchaseLimitPayloadSchema } from '../../shared/actions/change-counterparty-purchase-limit.ts';
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
  const overridePayload = Schema.decodeUnknownSync(ChangePrincipalPurchaseLimitOverridePayloadSchema)({
    ...defaultPayload,
    change: { _tag: 'SET', policy: { _tag: 'UNLIMITED' } },
    principalRef,
  });
  const defaultFacts = getActionOwnerFactsResolver(changeCounterpartyPurchaseLimitAction)?.(defaultPayload, scope);
  const overrideFacts = getActionOwnerFactsResolver(changePrincipalPurchaseLimitOverrideAction)?.(
    overridePayload,
    scope,
  );

  // The v2 declaration gates the capability; the owner facts name the counterparty whose own
  // purchase-limit grant the overlay then checks (O67-Q1, O70).
  for (const facts of [defaultFacts, overrideFacts]) {
    expect(facts).toEqual({ counterpartyId: counterpartyRef.resourceId });
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
    storefrontId: 'storefront:tenant-a-b2b',
  });
  // The legacy permission-target resolvers are gone (O62.4): each Read carries a v2 declaration and
  // the owner facts that name the counterparty (and its Storefront) whose own grant the overlay
  // checks (O67-Q1, O70). The Storefront is the request's own; the trusted-scope check that it came
  // from the caller's scope is the Read's, not a resolver's.
  expect(purchaseLimitPolicyReadRead.descriptor.accessDeclaration?.key).toBe(
    'commerce.customer-context.purchase-limit-policy.read',
  );
  expect(purchaseLimitPolicyReadRead.descriptor.accessOwnerFacts).toBeDefined();
  expect(purchaseLimitEvaluationRead.descriptor.accessDeclaration?.key).toBe(
    'commerce.customer-context.purchase-limit.evaluate',
  );
  expect(purchaseLimitEvaluationRead.descriptor.accessOwnerFacts).toBeDefined();
  const resolvePolicyFacts = getReadOwnerFactsResolver(purchaseLimitPolicyReadRead);
  if (!Predicate.isFunction(resolvePolicyFacts)) {
    throw new TypeError('Purchase Limit policy Read must declare owner facts');
  }
  expect(resolvePolicyFacts(policyInput, scope)).toEqual({ counterpartyId: counterpartyRef.resourceId });
  const resolveEvaluationFacts = getReadOwnerFactsResolver(purchaseLimitEvaluationRead);
  if (!Predicate.isFunction(resolveEvaluationFacts)) {
    throw new TypeError('Purchase Limit evaluation Read must declare owner facts');
  }
  expect(resolveEvaluationFacts(evaluationInput, scope)).toEqual({
    counterpartyId: counterpartyRef.resourceId,
    storefrontId: 'storefront:tenant-a-b2b',
  });
});

it('wire contracts reject implicit unlimited, invalid amounts, and unscoped principals', () => {
  const base = {
    counterpartyRef,
    expectedRevision: null,
    reason: 'Policy update',
  };
  expect(Schema.is(ChangeCounterpartyPurchaseLimitPayloadSchema)({ ...base, change: { _tag: 'SET' } })).toBe(false);
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
  const decodedDefaultPayload = Schema.decodeUnknownSync(CounterpartyPurchaseLimitChangedOutboxPayloadSchema)(
    defaultPayload,
  );
  const decodedOverridePayload = Schema.decodeUnknownSync(PrincipalPurchaseLimitOverrideChangedOutboxPayloadSchema)(
    overridePayload,
  );
  expect(Schema.is(CounterpartyPurchaseLimitChangedOutboxPayloadSchema)(defaultPayload)).toBe(true);
  expect(Schema.is(CounterpartyPurchaseLimitChangedOutboxPayloadSchema)({ data: defaultPayload })).toBe(false);
  expect(Schema.is(PrincipalPurchaseLimitOverrideChangedOutboxPayloadSchema)(overridePayload)).toBe(true);
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
