import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import { expect, it } from 'effect-rstest';
import { Effect, Schema } from 'effect';
import {
  getActionBusinessPermissionTargetResolver,
  getActionHandler,
} from '../../../../packages/core-runtime/src/actions/definition.ts';
import {
  TriggerPurchaseApprovalPayloadSchema,
  TriggerPurchaseApprovalResultSchema,
} from '../../shared/actions/trigger-purchase-approval.ts';
import {
  PurchaseApprovalProfileEvidenceSchema,
  PurchaseApprovalProposalEvidenceSchema,
  PurchaseApprovalSubmission,
} from '../../shared/domain/purchase-limit-approval-trigger.ts';
import {
  PurchaseLimitEvaluationContextSchema,
  PurchaseLimitEvaluationSourceFactory,
  PurchaseLimitUtcTimestampSchema,
} from '../../shared/domain/purchase-limit-evaluation.ts';
import type { PurchaseLimitEvaluationInput } from '../../shared/domain/purchase-limit-evaluation.ts';
import { PurchaseLimitPolicySnapshotSchema } from '../../shared/domain/purchase-limit-policy.ts';
import {
  PurchaseApprovalTriggerEvidenceSourceFactory,
  triggerPurchaseApprovalAction,
} from '../../src/actions/trigger-purchase-approval.action.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const principalId = '20000000-0000-4000-8000-000000000001';
const legalEntityId = '30000000-0000-4000-8000-000000000001';
const storefrontId = 'storefront:akros-b2b';
const counterpartyRef = {
  moduleId: 'party.registry',
  resourceId: '40000000-0000-4000-8000-000000000001',
  resourceType: 'party.registry.counterparty',
  tenantId,
} as const;
const profileRef = {
  kind: 'COUNTERPARTY',
  moduleId: 'commerce.customer-context',
  resourceId: '50000000-0000-4000-8000-000000000001',
  resourceType: 'commerce.customer-context.counterparty-purchasing-profile',
  tenantId,
} as const;
const purchaseValue = {
  monetaryAmount: { amount: '101', currency: 'CZK' },
  roundingRuleRevision: 'pricing-rounding:3',
  sourceRef: 'purchase-proposal:60000000-0000-4000-8000-000000000001',
  sourceRevision: 'proposal:1',
} as const;
const sourceRevisions = [
  { revision: 'counterparty-policy:1', source: 'counterparty-policy' },
  { revision: 'customer-commerce-policy:1', source: 'customer-commerce-policy' },
  { revision: 'principal-override:none:1', source: 'principal-override' },
  { revision: 'proposal:1', source: 'purchase-proposal' },
  { revision: '1', source: 'purchasing-profile' },
  { revision: 'storefront:1', source: 'storefront-context' },
] as const;
const payload = Schema.decodeUnknownSync(TriggerPurchaseApprovalPayloadSchema)({
  counterpartyRef,
  expectedSourceRevisions: sourceRevisions,
  profileRef,
  proposalRevisionRef: purchaseValue.sourceRef,
  purchaseValue,
  storefrontId,
});
const trustedPrincipal = Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
  authBindingId: '70000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:purchase-approval-trigger-test',
  authMethod: 'session',
  legalEntityId,
  principalId,
  tenantId,
  trustedStorefrontId: storefrontId,
});
const scope = {
  ...trustedPrincipal,
  correlationId: 'purchase-approval-trigger-test',
} satisfies OperationalScope;
const principalWithoutTrustedStorefront = Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
  authBindingId: '70000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:purchase-approval-trigger-test',
  authMethod: 'session',
  legalEntityId,
  principalId,
  tenantId,
});
const scopeWithoutTrustedStorefront = {
  ...principalWithoutTrustedStorefront,
  correlationId: 'purchase-approval-trigger-test',
} satisfies OperationalScope;
const evaluationContext = Schema.decodeUnknownSync(PurchaseLimitEvaluationContextSchema)({
  counterpartyRef,
  principalId,
  sellingLegalEntityId: legalEntityId,
  storefrontId,
});
const counterpartyPolicy = Schema.decodeUnknownSync(PurchaseLimitPolicySnapshotSchema)({
  changedAt: '2026-09-09T09:00:00.000Z',
  policy: { _tag: 'MONETARY_LIMIT', limit: { amount: '100', currency: 'CZK' } },
  policyRef: {
    moduleId: 'commerce.customer-context',
    resourceId: '80000000-0000-4000-8000-000000000001',
    resourceType: 'commerce.customer-context.purchase-limit-policy',
    tenantId,
  },
  revision: 1,
  subject: { _tag: 'COUNTERPARTY_DEFAULT', counterpartyRef },
});
const evaluationInput = {
  counterpartyPolicies: [counterpartyPolicy],
  counterpartyRef: payload.counterpartyRef,
  currentSourceRevisions: payload.expectedSourceRevisions,
  decidedAt: Schema.decodeUnknownSync(PurchaseLimitUtcTimestampSchema)('2026-09-09T10:00:00.000Z'),
  expectedSourceRevisions: payload.expectedSourceRevisions,
  principalId: scope.principalId,
  principalOverrides: [],
  purchaseValue: payload.purchaseValue,
  sellingLegalEntityId: evaluationContext.sellingLegalEntityId,
  storefrontId: evaluationContext.storefrontId,
} satisfies PurchaseLimitEvaluationInput;
const profileEvidence = Schema.decodeUnknownSync(PurchaseApprovalProfileEvidenceSchema)({
  counterpartyRef,
  evaluatedAt: '2026-09-09T10:00:00.000Z',
  evaluationContext,
  gate: { canAcceptNewOrder: true, outcome: 'ACTIVE' },
  profileRef,
  revision: 1,
  sourceRevision: '1',
});
const proposalEvidence = Schema.decodeUnknownSync(PurchaseApprovalProposalEvidenceSchema)({
  evaluatedAt: '2026-09-09T10:00:00.000Z',
  evaluationContext,
  proposalRevisionRef: purchaseValue.sourceRef,
  purchaseValue,
  revision: purchaseValue.sourceRevision,
  state: 'CURRENT',
});

it('declares exact submit authorization without promoting an untrusted Storefront', () => {
  const resolver = getActionBusinessPermissionTargetResolver(triggerPurchaseApprovalAction);
  if (resolver === undefined) {
    throw new Error('Trigger Purchase Approval must declare business authorization');
  }
  expect(resolver(payload, scopeWithoutTrustedStorefront)).toEqual({
    permission: 'counterparty.purchase.submit',
    target: {
      counterpartyId: counterpartyRef.resourceId,
      kind: 'counterparty_storefront',
      legalEntityId,
      storefrontId,
      tenantId,
    },
  });
  expect(resolver(payload, { ...scope, trustedStorefrontId: 'storefront:other' })).toMatchObject({
    target: { storefrontId },
    trustedStorefrontId: 'storefront:other',
  });
  expect(resolver(payload, scope)).toMatchObject({
    target: { storefrontId },
    trustedStorefrontId: storefrontId,
  });
});

it.effect('collects audit/read evidence and publishes the owner-returned approval request ref', () =>
  Effect.gen(function* collectsApprovalEvidence() {
    let auditRecords = 0;
    let dataAccessRecords = 0;
    let submissionCalls = 0;
    let boundInvocationId: string | undefined;
    let publishedRequestRef: string | undefined;
    const handler = getActionHandler(triggerPurchaseApprovalAction);
    const boundSubmission = {
      submit: ({ idempotencyKey }: { readonly idempotencyKey: string }) =>
        Effect.sync(() => {
          expect(idempotencyKey).toBe('purchase-approval-trigger:1');
          submissionCalls += 1;
          return { _tag: 'APPROVAL_SUBMITTED' as const, approvalRequestRef: 'approval:1' };
        }),
    };
    const submission = {
      ...boundSubmission,
      forActionInvocation: (actionInvocationId: string) => {
        boundInvocationId = actionInvocationId;
        return boundSubmission;
      },
    };
    const result = yield* handler(payload, {
      actionInvocationId: 'purchase-approval-trigger:1',
      addDomainEvent: ({ payloadJson, subjectResourceId }) =>
        Effect.sync(() => {
          publishedRequestRef = subjectResourceId;
          expect(payloadJson).toEqual({ outcome: 'SUBMITTED', requestRef: 'approval:1' });
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: The handler only forwards this placeholder to addOutboxMessage, whose test stub ignores the event argument.
          return { eventId: 'event:1' } as never;
        }),
      addOutboxMessage: (_event, message) =>
        Effect.sync(() => {
          expect(message.payloadJson).toEqual({
            data: { outcome: 'SUBMITTED', requestRef: 'approval:1' },
          });
        }),
      recordAuditEvidence: () =>
        Effect.sync(() => {
          auditRecords += 1;
        }),
      recordDataAccess: () =>
        Effect.sync(() => {
          dataAccessRecords += 1;
        }),
      scope,
      services: {
        evaluationSource: { loadCurrent: () => Effect.succeed(evaluationInput) },
        evidence: {
          loadCurrent: () =>
            Effect.succeed({
              currentSourceRevisions: sourceRevisions,
              profileEvidence,
              proposalEvidence,
            }),
        },
        submission,
      },
    }).pipe(
      Effect.provideService(PurchaseApprovalSubmission, submission),
      Effect.provideService(PurchaseApprovalTriggerEvidenceSourceFactory, {
        make: () => Effect.die('Factory requirements are not used by the extracted handler'),
      }),
      Effect.provideService(PurchaseLimitEvaluationSourceFactory, {
        make: () => Effect.die('Factory requirements are not used by the extracted handler'),
      }),
    );

    expect(Schema.is(TriggerPurchaseApprovalResultSchema)(result)).toBe(true);
    expect(auditRecords).toBe(1);
    expect(dataAccessRecords).toBe(3);
    expect(submissionCalls).toBe(1);
    expect(boundInvocationId).toBe('purchase-approval-trigger:1');
    expect(publishedRequestRef).toBe('approval:1');
    expect(Object.keys(triggerPurchaseApprovalAction.descriptor.domainEvents)).toEqual([
      'commerce.customer-context.purchase-approval-request-submitted.v1',
    ]);
  }),
);

it.effect('fails closed when a source changes between evaluation and final evidence load', () =>
  Effect.gen(function* rejectsCurrentnessRace() {
    let submissionCalls = 0;
    const handler = getActionHandler(triggerPurchaseApprovalAction);
    const submission = {
      submit: () =>
        Effect.sync(() => {
          submissionCalls += 1;
          return { _tag: 'APPROVAL_SUBMITTED' as const, approvalRequestRef: 'approval:race' };
        }),
    };
    const result = yield* handler(payload, {
      actionInvocationId: 'purchase-approval-trigger:race',
      addDomainEvent: () => Effect.die('No event should be emitted after a failed currentness check'),
      addOutboxMessage: () => Effect.die('No outbox message should be emitted after a failed currentness check'),
      recordAuditEvidence: () => Effect.void,
      recordDataAccess: () => Effect.void,
      scope,
      services: {
        evaluationSource: { loadCurrent: () => Effect.succeed(evaluationInput) },
        evidence: {
          loadCurrent: () =>
            Effect.succeed({
              currentSourceRevisions: sourceRevisions.map((candidate) =>
                candidate.source === 'storefront-context' ? { ...candidate, revision: 'storefront:2' } : candidate,
              ),
              profileEvidence,
              proposalEvidence,
            }),
        },
        submission,
      },
    }).pipe(
      Effect.provideService(PurchaseApprovalSubmission, submission),
      Effect.provideService(PurchaseApprovalTriggerEvidenceSourceFactory, {
        make: () => Effect.die('Factory requirements are not used by the extracted handler'),
      }),
      Effect.provideService(PurchaseLimitEvaluationSourceFactory, {
        make: () => Effect.die('Factory requirements are not used by the extracted handler'),
      }),
    );

    expect(Schema.is(Schema.Struct({ _tag: Schema.Literal('APPROVAL_PRECONDITION_FAILED') }))(result)).toBe(true);
    expect(submissionCalls).toBe(0);
  }),
);
