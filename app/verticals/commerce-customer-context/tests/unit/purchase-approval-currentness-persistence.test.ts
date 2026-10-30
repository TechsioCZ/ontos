import { TestClock } from 'effect/testing';
import type {
  ContextAccessService,
  OperationalScope,
  ScopedRoutineDefinition,
  ScopedRoutineInputValues,
  ScopedRoutineInvoker,
  ScopedRoutineParameter,
} from '@app/core-runtime';
import { CoreSearchResourceRefSchema, ScopedRoutineInvocationError } from '@app/core-runtime';
import { DateTime, Effect, Layer, Option, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  AuthBindingIdSchema,
  PrincipalIdSchema,
  TenantIdSchema,
} from '@app/core-runtime/auth/external-identity-contracts';
import { TrustedPrincipalContextSchema } from '@app/core-runtime/actions/principal-context';
import {
  PurchaseApprovalCurrentnessFactory,
  PurchaseApprovalFinalBindingAuthority,
} from '../../shared/domain/purchase-approval-currentness-port.ts';
import {
  ApprovalRouteSchema,
  ApprovalDecisionSchema,
  PurchaseApprovalRequestSchema,
  PurchaseProposalRevisionSchema,
  SubmitPurchaseApprovalRequestInputSchema,
  RevalidatePurchaseApprovalInputSchema,
  PurchaseApprovalFinalBindingEvidenceSchema,
  PurchaseApprovalFinalBindingSchema,
  PurchasingApprovalRejected,
  revalidateApproval,
} from '../../shared/domain/purchasing-approval.ts';
import {
  PurchaseLimitSourceRevisionVectorSchema,
  PurchaseLimitEvaluationContextSchema,
} from '../../shared/domain/purchase-limit-evaluation.ts';
import { PurchaseLimitEvaluationCurrentFactsSchema } from '../../shared/domain/purchase-limit-evaluation-currentness-port.ts';
import {
  PurchaseLimitPolicySnapshotSchema,
  PurchaseLimitDependencyUnavailableSchema,
} from '../../shared/domain/purchase-limit-policy.ts';
import type { PurchaseLimitEvaluationSourceService } from '../../shared/domain/purchase-limit-evaluation.ts';
import { ProfilePersistenceDependencyFailure } from '../../src/persistence/profile-persistence.ts';
import type { ProfileCounterpartyRoleEligibilityScope } from '../../src/profile-counterparty-role-eligibility.ts';
import type { PurchaseLimitEvaluationCurrentnessPortService } from '../../shared/domain/purchase-limit-evaluation-currentness-port.ts';
import type { TrustedRevalidatePurchaseApprovalInput } from '../../shared/domain/purchasing-approval.ts';
import { purchaseApprovalCurrentnessFactoryLive } from '../../src/persistence/purchase-approval-currentness-persistence.ts';
import { ProfileCounterpartyRoleEligibilityResolverFactory } from '../../src/profile-counterparty-role-eligibility.ts';
import { purchasingApprovalCommercialFixture } from './purchasing-approval-fixtures.ts';

const tenantId = Schema.decodeSync(TenantIdSchema)('10000000-0000-4000-8000-000000000001');
const buyerId = Schema.decodeSync(PrincipalIdSchema)('10000000-0000-4000-8000-000000000002');
const legalEntityId = '20000000-0000-4000-8000-000000000001';
const storefrontId = 'storefront-eu';
const atText = '2026-09-09T12:00:00.000Z';
const expiresAtText = '2026-09-09T13:00:00.000Z';
const money = (amount: string) => ({ amount, currency: 'EUR' });

const counterpartyRef = Schema.decodeUnknownSync(CoreSearchResourceRefSchema)({
  moduleId: 'party.registry',
  resourceId: 'counterparty-1',
  resourceType: 'party.registry.counterparty',
  tenantId,
});

const profileRef = Schema.decodeUnknownSync(CoreSearchResourceRefSchema)({
  moduleId: 'commerce.customer-context',
  resourceId: 'profile-1',
  resourceType: 'commerce.customer-context.counterparty-purchasing-profile',
  tenantId,
});

const principal = Schema.decodeUnknownSync(
  Schema.Struct({
    principalId: PrincipalIdSchema,
    tenantId: TenantIdSchema,
  }),
)({ principalId: buyerId, tenantId });

const proposal = Schema.decodeUnknownSync(PurchaseProposalRevisionSchema)({
  approvalEvaluation: 'APPROVAL_REQUIRED',
  approvalTrigger: {
    policyRevision: 'limit-r1',
    reasonCode: 'over_limit',
    source: 'PURCHASE_LIMIT',
  },
  canonicalHash: 'a'.repeat(64),
  canonicalizationVersion: 'purchase-proposal.v1',
  context: {
    channelId: 'portal',
    evaluatedAt: atText,
    locale: 'en-US',
    marketId: 'eu',
    sellingLegalEntityId: legalEntityId,
    storefrontId,
    tenantId,
  },
  createdAt: atText,
  currency: 'EUR',
  deliveryDestination: {
    address: { country: 'CZ' },
    kind: 'DELIVERY',
    method: 'DELIVERY_ADDRESS',
  },
  effectiveLimit: money('50'),
  expiresAt: expiresAtText,
  hierarchyInputs: {
    counterpartyRef,
    evaluatedAt: atText,
    purchaseValue: money('120'),
    storefrontId,
  },
  identity: { buyer: principal, counterpartyRef, profileRef },
  invoiceRecipient: { address: { country: 'CZ' }, kind: 'INVOICE', method: 'BILLING_ADDRESS' },
  ...purchasingApprovalCommercialFixture({ money, tenantId }),
  payment: 'NONE',
  paymentTerm: {
    code: 'NET30',
    definitionRef: {
      moduleId: 'payment-term-catalog',
      resourceId: 'net-30',
      resourceType: 'payment-term-catalog.payment-term-definition',
      tenantId,
    },
    definitionRevision: '1',
  },
  policyRefs: [],
  pricingRevision: 'pricing-r1',
  proposalRevisionRef: {
    moduleId: 'commerce.customer-context',
    resourceId: 'proposal-1',
    resourceType: 'commerce.customer-context.purchase-proposal-revision',
    tenantId,
  },
  proposalSequence: 1,
  reservation: 'NONE',
  revision: 1,
  state: 'CURRENT',
  taxRevision: 'tax-r1',
});

const sourceRevisions = Schema.decodeUnknownSync(PurchaseLimitSourceRevisionVectorSchema)([
  { revision: '1', source: 'counterparty-policy' },
  { revision: '1', source: 'customer-commerce-policy' },
  { revision: '1', source: 'principal-override' },
  { revision: '1', source: 'purchase-proposal' },
  { revision: '1', source: 'purchasing-profile' },
  { revision: '1', source: 'storefront-context' },
]);

const validScope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authBindingId: Schema.decodeSync(AuthBindingIdSchema)('30000000-0000-4000-8000-000000000001'),
    authContextRef: 'better-auth-session:purchase-approval-currentness',
    authMethod: 'session',
    legalEntityId,
    principalId: buyerId,
    tenantId,
    trustedStorefrontId: storefrontId,
  }),
  correlationId: 'purchase-approval-currentness',
  legalEntityId,
  trustedStorefrontId: storefrontId,
} satisfies OperationalScope & { readonly legalEntityId: string; readonly trustedStorefrontId: string };

// A valid tenant that differs from the owner-current proposal exercises the public target guard.
// The owner decoder runs only after this guard, so a malformed tenant cannot reach it through a
// proposal and claimed target that both satisfy their public schemas.
const mismatchedTenantId = Schema.decodeSync(TenantIdSchema)('10000000-0000-4000-8000-000000000003');
const mismatchedScope = { ...validScope, tenantId: mismatchedTenantId };

const makeRoutineInvoker = (calls: string[]): ScopedRoutineInvoker => ({
  invoke: <
    RowSchema extends Schema.ConstraintDecoder<object>,
    const Parameters extends readonly ScopedRoutineParameter[],
  >(
    routine: ScopedRoutineDefinition<RowSchema, Parameters>,
    _values: ScopedRoutineInputValues<Parameters>,
  ) => {
    calls.push(routine.routineKey);
    if (routine.routineKey !== 'purchase-approval.read-current-proposal') {
      return Effect.never;
    }
    return Schema.decodeUnknownEffect(routine.resultSchema)({
      result: {
        proposal: Schema.encodeSync(PurchaseProposalRevisionSchema)(proposal),
        sourceRevisions,
      },
    }).pipe(
      Effect.map((row) => [row]),
      Effect.mapError(
        () =>
          new ScopedRoutineInvocationError({
            code: 'scoped_routine_result_invalid',
            constraint: Option.none(),
            ownerModuleKey: routine.ownerModuleKey,
            postgresCode: Option.none(),
            reason: 'The test routine row did not satisfy its declared schema',
            routineKey: routine.routineKey,
          }),
      ),
    );
  },
});

const contextAccess: ContextAccessService = {
  businessPermissions: ({ targets }) =>
    Effect.succeed(targets.map(({ permission }) => ({ decision: 'allowed' as const, key: permission }))),
  legalEntities: () => Effect.succeed([]),
  modules: () => Effect.succeed([]),
  resources: () => Effect.succeed([]),
  tenants: () => Effect.succeed([]),
};

const purchaseLimitCurrentness: PurchaseLimitEvaluationCurrentnessPortService = {
  resolveCurrent: () => Effect.never,
};

it.effect('rejects a mismatched tenant target before invoking the Core owner access routine', () =>
  Effect.gen(function* rejectMismatchedTenantTarget() {
    const routineKeys: string[] = [];
    const factory = yield* PurchaseApprovalCurrentnessFactory;
    const service = factory.make(
      makeRoutineInvoker(routineKeys),
      mismatchedScope,
      contextAccess,
      purchaseLimitCurrentness,
      { loadCurrent: () => Effect.die('unused after mismatched tenant rejection') },
    );
    if (service.resolveSubmission === undefined) {
      return yield* Effect.die('The currentness fixture must expose submission validation');
    }
    const claimed = Schema.decodeUnknownSync(SubmitPurchaseApprovalRequestInputSchema)({
      counterpartyRef,
      idempotencyKey: 'submission-1',
      proposalRevision: proposal.revision,
      proposalRevisionRef: proposal.proposalRevisionRef,
      requestExpiresAt: expiresAtText,
      storefrontId,
    });
    const failure = yield* Effect.flip(
      service.resolveSubmission({
        claimed,
        scope: {
          legalEntityId: mismatchedScope.legalEntityId,
          principalId: mismatchedScope.principalId,
          storefrontId,
          tenantId: mismatchedScope.tenantId,
        },
      }),
    );

    expect(failure.code).toBe('PERMISSION_DENIED');
    expect(failure.reason).toBe('The claimed submission target does not match the owner-current proposal');
    expect(routineKeys.filter((routineKey) => routineKey.startsWith('counterparty-access.'))).toEqual([]);
    return yield* Effect.void;
  }).pipe(
    Effect.provide(
      purchaseApprovalCurrentnessFactoryLive.pipe(
        Layer.provide(
          Layer.succeed(ProfileCounterpartyRoleEligibilityResolverFactory, {
            make: () => () => Effect.die('Guarded currentness test must not resolve role evidence'),
          }),
        ),
      ),
    ),
  ),
);

const testFinalBinding = Schema.decodeUnknownSync(PurchaseApprovalFinalBindingSchema)({
  attemptRef: {
    moduleId: 'test.approval-final-owner',
    resourceId: 'attempt-1',
    resourceType: 'test.approval-final-owner.attempt',
    tenantId,
  },
  bundleHash: 'd'.repeat(64),
  bundleRef: {
    moduleId: 'test.approval-final-owner',
    resourceId: 'bundle-1',
    resourceType: 'test.approval-final-owner.bundle',
    tenantId,
  },
  bundleVersion: 'TEST_EXACT_APPROVAL_BUNDLE.v1',
});
const claimedRevalidation = Schema.decodeUnknownSync(RevalidatePurchaseApprovalInputSchema)({
  buyerPermission: 'ALLOWED',
  checkedAt: atText,
  commitmentCorrelationId: 'unit-currentness-attempt',
  counterpartyRef,
  decisionBundleHash: 'b'.repeat(64),
  decisionBundleVersion: 'approval-decision-bundle.v1',
  decisionRef: {
    moduleId: 'commerce.customer-context',
    resourceId: 'decision-1',
    resourceType: 'commerce.customer-context.approval-decision',
    tenantId,
  },
  expectedProposalHash: proposal.canonicalHash,
  finalBinding: testFinalBinding,
  hierarchyRef: {
    moduleId: 'commerce.customer-context',
    resourceId: 'hierarchy-1',
    resourceType: 'commerce.customer-context.approval-hierarchy',
    tenantId,
  },
  idempotencyKey: 'unit-revalidation',
  profileState: 'ACTIVE',
  proposalRevisionRef: proposal.proposalRevisionRef,
  requestRef: {
    moduleId: 'commerce.customer-context',
    resourceId: 'request-1',
    resourceType: 'commerce.customer-context.purchase-approval-request',
    tenantId,
  },
  routeCurrent: true,
  routeRef: {
    moduleId: 'commerce.customer-context',
    resourceId: 'route-1',
    resourceType: 'commerce.customer-context.approval-route',
    tenantId,
  },
  sourceRevisions,
  storefrontId,
  validUntil: expiresAtText,
});

it.effect('passes the complete typed approval request reference to its declared native snapshot reader', () =>
  Effect.gen(function* preserveFullRequestReference() {
    const calls: { readonly routineKey: string; readonly values: readonly unknown[] }[] = [];
    const invoker: ScopedRoutineInvoker = {
      invoke: (routine, values) => {
        calls.push({ routineKey: routine.routineKey, values });
        return Effect.succeed([]);
      },
    };
    const factory = yield* PurchaseApprovalCurrentnessFactory;
    const service = factory.make(invoker, validScope, contextAccess, purchaseLimitCurrentness, {
      loadCurrent: () => Effect.die('No snapshot must not reach current evaluation'),
    });
    const failure = yield* Effect.flip(
      service.resolveRevalidation({
        claimed: claimedRevalidation,
        scope: { legalEntityId, principalId: buyerId, storefrontId, tenantId },
      }),
    );
    expect(calls).toEqual([
      {
        routineKey: 'purchasing-approval.read-current-revalidation',
        values: [{ requestRef: claimedRevalidation.requestRef }],
      },
    ]);
    expect(failure.code).toBe('CURRENT_STATE_INDETERMINATE');
    expect(failure.retryable).toBe(true);
  }).pipe(
    Effect.provide(
      purchaseApprovalCurrentnessFactoryLive.pipe(
        Layer.provide(
          Layer.succeed(ProfileCounterpartyRoleEligibilityResolverFactory, {
            make: () => () => Effect.die('Guarded currentness test must not resolve role evidence'),
          }),
        ),
      ),
    ),
  ),
);

it('rejects missing, empty, scalar, wrong-module and wrong-type request references at the public boundary', () => {
  for (const requestRef of [
    undefined,
    '',
    claimedRevalidation.requestRef.resourceId,
    { ...claimedRevalidation.requestRef, resourceId: '' },
    { ...claimedRevalidation.requestRef, moduleId: 'party.registry' },
    { ...claimedRevalidation.requestRef, resourceType: 'commerce.customer-context.purchase-proposal-revision' },
  ]) {
    expect(
      Option.isNone(
        Schema.decodeUnknownOption(RevalidatePurchaseApprovalInputSchema)({
          ...Schema.encodeSync(RevalidatePurchaseApprovalInputSchema)(claimedRevalidation),
          requestRef,
        }),
      ),
    ).toBe(true);
  }
});

it.effect('keeps unavailable native snapshots typed and does not fabricate currentness evidence', () =>
  Effect.gen(function* rejectNativeSnapshotFailure() {
    const factory = yield* PurchaseApprovalCurrentnessFactory;
    for (const code of ['scoped_routine_invocation_failed', 'scoped_routine_result_invalid'] as const) {
      let invocations = 0;
      const invoker: ScopedRoutineInvoker = {
        invoke: (routine) => {
          invocations += 1;
          return Effect.fail(
            new ScopedRoutineInvocationError({
              code,
              constraint: Option.none(),
              ownerModuleKey: routine.ownerModuleKey,
              postgresCode: Option.none(),
              reason: 'Controlled unavailable owner snapshot',
              routineKey: routine.routineKey,
            }),
          );
        },
      };
      const service = factory.make(invoker, validScope, contextAccess, purchaseLimitCurrentness, {
        loadCurrent: () => Effect.die('Unavailable snapshots must not reach current evaluation'),
      });
      const failure = yield* Effect.flip(
        service.resolveRevalidation({
          claimed: claimedRevalidation,
          scope: { legalEntityId, principalId: buyerId, storefrontId, tenantId },
        }),
      );
      expect(failure.code).toBe('CURRENT_STATE_INDETERMINATE');
      expect(failure.retryable).toBe(true);
      expect(invocations).toBe(1);
    }
  }).pipe(
    Effect.provide(
      purchaseApprovalCurrentnessFactoryLive.pipe(
        Layer.provide(
          Layer.succeed(ProfileCounterpartyRoleEligibilityResolverFactory, {
            make: () => () => Effect.die('Guarded currentness test must not resolve role evidence'),
          }),
        ),
      ),
    ),
  ),
);

const currentRoute = Schema.decodeUnknownSync(ApprovalRouteSchema)({
  capturedAt: atText,
  currentLevelOrder: 1,
  hierarchyRef: claimedRevalidation.hierarchyRef,
  hierarchyRevision: 1,
  levels: [
    {
      candidates: [principal],
      completedAt: atText,
      completedBy: principal,
      completionRule: 'ONE_APPROVER',
      levelId: 'one',
      order: 1,
    },
  ],
  proposalRevisionRef: proposal.proposalRevisionRef,
  requestRef: claimedRevalidation.requestRef,
  rerouteReason: null,
  routeRef: claimedRevalidation.routeRef,
  status: 'APPROVED',
});
const currentDecision = Schema.decodeUnknownSync(ApprovalDecisionSchema)({
  actor: principal,
  decisionBundleHash: claimedRevalidation.decisionBundleHash,
  decisionBundleVersion: claimedRevalidation.decisionBundleVersion,
  decisionRef: claimedRevalidation.decisionRef,
  hierarchyRef: claimedRevalidation.hierarchyRef,
  hierarchyRevision: 1,
  idempotencyKey: 'decision-1',
  kind: 'APPROVE',
  levelOrder: 1,
  proposalRevisionRef: proposal.proposalRevisionRef,
  reason: null,
  recordedAt: atText,
  requestRef: claimedRevalidation.requestRef,
  requestRevision: 2,
  routeRef: currentRoute.routeRef,
});
const currentRequest = Schema.decodeUnknownSync(PurchaseApprovalRequestSchema)({
  committedOrderRef: null,
  consumedAt: null,
  consumptionCommitmentId: null,
  decisionBundleHash: claimedRevalidation.decisionBundleHash,
  decisionBundleVersion: claimedRevalidation.decisionBundleVersion,
  expiresAt: expiresAtText,
  idempotencyKey: 'request-1',
  lastDecisionRef: currentDecision.decisionRef,
  proposal: Schema.encodeSync(PurchaseProposalRevisionSchema)(proposal),
  requestRef: claimedRevalidation.requestRef,
  requestRevision: 2,
  route: Schema.encodeSync(ApprovalRouteSchema)(currentRoute),
  status: 'APPROVED',
  submittedAt: atText,
});
const claimedSubmission = Schema.decodeUnknownSync(SubmitPurchaseApprovalRequestInputSchema)({
  counterpartyRef,
  idempotencyKey: 'submit-current-role',
  proposalRevision: proposal.revision,
  proposalRevisionRef: proposal.proposalRevisionRef,
  requestExpiresAt: expiresAtText,
  storefrontId,
});

const RoleModeSchema = Schema.Literals(['ELIGIBLE', 'INELIGIBLE', 'INDETERMINATE', 'UNAVAILABLE', 'FOREIGN_LE']);
type RoleMode = typeof RoleModeSchema.Type;
const currentProfileFixture = (
  options: {
    readonly core?: 'allowed' | 'denied' | 'unavailable';
    readonly finalAuthority?:
      | 'MISSING'
      | 'DENIED'
      | 'UNKNOWN'
      | 'FOREIGN'
      | 'CHANGED'
      | 'FUTURE'
      | 'EXPIRED'
      | 'AT_EXPIRY'
      | 'BEFORE_EXPIRY';
    readonly observedAt?: DateTime.Utc;
    readonly owner?: 'ACTIVE' | 'REVOKED' | 'RECONCILIATION_REQUIRED';
    readonly profileId?: string;
    readonly profileLegalEntityId?: string;
    readonly profileOutcome?: 'PROFILE_FOUND' | 'PROFILE_NOT_FOUND' | 'PROFILE_RECONCILIATION_REQUIRED';
    readonly profileState?: 'ACTIVE' | 'SUSPENDED';
    readonly role?: RoleMode;
    readonly staleExternal?: boolean;
    readonly unavailableExternal?: boolean;
  } = {},
) => {
  const calls: { readonly routineKey: string; readonly values: readonly unknown[] }[] = [];
  const resolverScopes: ProfileCounterpartyRoleEligibilityScope[] = [];
  const roleRequests: { readonly counterpartyResourceId: string; readonly tenantId: string }[] = [];
  const transaction: ScopedRoutineInvoker = {
    invoke: (routine, values) => {
      calls.push({ routineKey: routine.routineKey, values });
      const rowsByRoutine = new Map<string, readonly unknown[]>(
        Object.entries({
          'counterparty-access.lock-grant-authority': [
            {
              counterparty_resource_id: counterpartyRef.resourceId,
              grant_id: 'grant-1',
              granted_at: atText,
              granted_by: buyerId,
              permission_code: 'counterparty.purchase.submit',
              principal_id: buyerId,
              reason: null,
              revision: 1,
              revoked_at: null,
              revoked_by: null,
              state: options.owner ?? 'ACTIVE',
              storefront_resource_id: storefrontId,
            },
          ],
          'profile.read-trading-gate': [
            {
              outcome: options.profileOutcome ?? 'PROFILE_FOUND',
              payload: {
                createdAt: atText,
                profileId: options.profileId ?? profileRef.resourceId,
                profileKind: 'COUNTERPARTY',
                revision: 1,
                scopeLegalEntityId: options.profileLegalEntityId ?? legalEntityId,
                state: options.profileState ?? 'ACTIVE',
                subject: {
                  counterpartyResourceId: counterpartyRef.resourceId,
                  counterpartyResourceRevision: '1',
                  customerRoleResourceId: 'role-1',
                  customerRoleResourceRevision: atText,
                  kind: 'COUNTERPARTY',
                },
                updatedAt: atText,
              },
            },
          ],
          'purchase-approval.read-current-proposal': [
            { result: { proposal: Schema.encodeSync(PurchaseProposalRevisionSchema)(proposal), sourceRevisions } },
          ],
          'purchase-limit.read-current-policies': [
            {
              amount: '50',
              currency_code: 'EUR',
              outcome: 'PRESENT',
              policy_id: 'policy-1',
              policy_kind: 'MONETARY_LIMIT',
              recorded_at: atText,
              revision: 1,
              source: 'COUNTERPARTY_DEFAULT',
              source_revision: '1',
            },
            {
              amount: null,
              currency_code: null,
              outcome: 'PRESENT',
              policy_id: 'override-1',
              policy_kind: 'CLEARED',
              recorded_at: atText,
              revision: 1,
              source: 'PRINCIPAL_OVERRIDE',
              source_revision: '1',
            },
          ],
          'purchasing-approval.read-current-revalidation': [
            {
              result: {
                decision: Schema.encodeSync(ApprovalDecisionSchema)(currentDecision),
                proposal: Schema.encodeSync(PurchaseProposalRevisionSchema)(proposal),
                request: Schema.encodeSync(PurchaseApprovalRequestSchema)(currentRequest),
                route: Schema.encodeSync(ApprovalRouteSchema)(currentRoute),
                sourceRevisions,
              },
            },
          ],
        }),
      );
      const rows = rowsByRoutine.get(routine.routineKey);
      if (rows === undefined) {
        return Effect.die(`Unexpected Currentness unit routine: ${routine.routineKey}`);
      }
      // Honest Core invoker seam validates native rows against Type, never applies wire transforms.
      return Effect.forEach((row) => Schema.decodeUnknownEffect(Schema.toType(routine.resultSchema))(row))(rows).pipe(
        Effect.mapError(
          () =>
            new ScopedRoutineInvocationError({
              code: 'scoped_routine_result_invalid',
              constraint: Option.none(),
              ownerModuleKey: routine.ownerModuleKey,
              postgresCode: Option.none(),
              reason: 'Unit native row violated its Type schema',
              routineKey: routine.routineKey,
            }),
        ),
      );
    },
  };
  const roleLayer = Layer.succeed(ProfileCounterpartyRoleEligibilityResolverFactory, {
    make: (scope) => {
      resolverScopes.push(scope);
      return (request) => {
        roleRequests.push(request);
        if (options.role === 'UNAVAILABLE') {
          return Effect.fail(new ProfilePersistenceDependencyFailure({ reason: 'Unit role owner unavailable' }));
        }
        if (options.role === 'INELIGIBLE' || options.role === 'INDETERMINATE') {
          return Effect.succeed({ outcome: options.role });
        }
        return Effect.succeed({
          managedLegalEntityId: options.role === 'FOREIGN_LE' ? 'foreign-legal-entity' : legalEntityId,
          outcome: 'ELIGIBLE' as const,
          roleResourceId: 'role-1',
          roleResourceRevision: atText,
        });
      };
    },
  });
  const access: ContextAccessService = {
    ...contextAccess,
    businessPermissions: ({ targets }) =>
      Effect.succeed(targets.map(({ permission }) => ({ decision: options.core ?? 'allowed', key: permission }))),
  };
  const currentness: PurchaseLimitEvaluationCurrentnessPortService = {
    resolveCurrent: () =>
      options.unavailableExternal === true
        ? Effect.fail(
            Schema.decodeUnknownSync(PurchaseLimitDependencyUnavailableSchema)({
              _tag: 'PurchaseLimitDependencyUnavailable',
              code: 'purchase_limit_dependency_unavailable',
              dependency: 'unit-external-current',
              reason: 'External Current evidence unavailable',
            }),
          )
        : Schema.decodeUnknownEffect(PurchaseLimitEvaluationCurrentFactsSchema)({
            channelId: 'portal',
            contextRevision: '1',
            currentSourceRevisions: sourceRevisions
              .filter(({ source }) => source !== 'counterparty-policy' && source !== 'principal-override')
              .map((source) =>
                options.staleExternal === true && source.source === 'purchasing-profile'
                  ? { ...source, revision: '2' }
                  : source,
              ),
            marketId: 'eu',
            purchaseValue: proposal.purchaseValue,
          }).pipe(Effect.orDie),
  };
  const evaluationContext = Schema.decodeUnknownSync(PurchaseLimitEvaluationContextSchema)({
    counterpartyRef,
    principalId: buyerId,
    sellingLegalEntityId: legalEntityId,
    storefrontId,
  });
  const policy = Schema.decodeUnknownSync(PurchaseLimitPolicySnapshotSchema)({
    changedAt: atText,
    policy: { _tag: 'MONETARY_LIMIT', limit: money('50') },
    policyRef: {
      moduleId: 'commerce.customer-context',
      resourceId: 'policy-1',
      resourceType: 'commerce.customer-context.purchase-limit-policy',
      tenantId,
    },
    revision: 1,
    subject: { _tag: 'COUNTERPARTY_DEFAULT', counterpartyRef },
  });
  const evaluation: PurchaseLimitEvaluationSourceService = {
    loadCurrent: () =>
      Effect.succeed({
        ...evaluationContext,
        counterpartyPolicies: [policy],
        currentSourceRevisions: sourceRevisions,
        decidedAt: proposal.createdAt,
        expectedSourceRevisions: sourceRevisions,
        principalOverrides: [],
        purchaseValue: proposal.purchaseValue,
      }),
  };
  const run = (path: 'SUBMIT' | 'REVALIDATE', inspect?: (frame: TrustedRevalidatePurchaseApprovalInput) => void) =>
    Effect.gen(function* exerciseRealCurrentProfileGate() {
      if (options.observedAt !== undefined) {
        yield* TestClock.setTime(DateTime.toEpochMillis(options.observedAt));
      }
      const factory = yield* PurchaseApprovalCurrentnessFactory;
      const service = factory.make(transaction, validScope, access, currentness, evaluation);
      const scope = { legalEntityId, principalId: buyerId, storefrontId, tenantId };
      if (path === 'REVALIDATE') {
        return yield* service.resolveRevalidation({ claimed: claimedRevalidation, scope }).pipe(
          Effect.map((result) => {
            inspect?.(result);
            return { buyer: result.buyerPermission, profile: result.profileState, routeCurrent: result.routeCurrent };
          }),
        );
      }
      if (service.resolveSubmission === undefined) {
        return yield* Effect.die('Submission validator missing');
      }
      return yield* service
        .resolveSubmission({ claimed: claimedSubmission, scope })
        .pipe(Effect.as({ buyer: 'ALLOWED', profile: 'ACTIVE', routeCurrent: true }));
    }).pipe(
      Effect.provide(purchaseApprovalCurrentnessFactoryLive.pipe(Layer.provide(roleLayer))),
      Effect.provide(TestClock.layer()),
      options.finalAuthority === 'MISSING'
        ? (effect) => effect
        : Effect.provideService(PurchaseApprovalFinalBindingAuthority, {
            verifyConsumption: () => Effect.die('Unit revalidation never proves an Order commit'),
            verifyRevalidation: ({ binding, request, scope }) => {
              expect(request.requestRef).toEqual(currentRequest.requestRef);
              expect(scope).toEqual({ legalEntityId, principalId: buyerId, storefrontId, tenantId });
              if (options.finalAuthority === 'DENIED' || options.finalAuthority === 'UNKNOWN') {
                return Effect.fail(
                  new PurchasingApprovalRejected({
                    code: 'CURRENT_STATE_INDETERMINATE',
                    reason: 'TEST authority refuses unknown or ineligible final Attempt',
                    retryable: true,
                  }),
                );
              }
              return Effect.gen(function* testOnlyFinalObservation() {
                const now = yield* DateTime.now;
                const observedAt =
                  options.finalAuthority === 'AT_EXPIRY' || options.finalAuthority === 'BEFORE_EXPIRY'
                    ? DateTime.subtract(now, { seconds: 1 })
                    : now;
                const validUntil =
                  options.finalAuthority === 'BEFORE_EXPIRY'
                    ? DateTime.add(now, { milliseconds: 1 })
                    : DateTime.add(now, { minutes: 1 });
                return yield* Schema.decodeUnknownEffect(PurchaseApprovalFinalBindingEvidenceSchema)({
                  binding: {
                    ...binding,
                    attemptRef:
                      options.finalAuthority === 'FOREIGN'
                        ? { ...binding.attemptRef, tenantId: '10000000-0000-4000-8000-000000000099' }
                        : binding.attemptRef,
                    bundleHash: options.finalAuthority === 'CHANGED' ? 'e'.repeat(64) : binding.bundleHash,
                  },
                  observedAt: DateTime.formatIso(
                    options.finalAuthority === 'FUTURE' ? DateTime.add(now, { minutes: 1 }) : observedAt,
                  ),
                  provenance: 'TEST_ONLY_FIXED_EXACT_FINAL_AUTHORITY',
                  validUntil: DateTime.formatIso(
                    options.finalAuthority === 'EXPIRED' || options.finalAuthority === 'AT_EXPIRY' ? now : validUntil,
                  ),
                }).pipe(Effect.orDie);
              });
            },
          }),
    );
  return { calls, resolverScopes, roleRequests, run };
};

it.effect('supplies exact scoped Party role evidence to the real profile gate for Submit and Revalidation', () =>
  Effect.gen(function* actualRoleDependency() {
    for (const path of ['SUBMIT', 'REVALIDATE'] as const) {
      const fixture = currentProfileFixture();
      const outcome = yield* fixture.run(path);
      expect(outcome).toEqual({ buyer: 'ALLOWED', profile: 'ACTIVE', routeCurrent: true });
      expect(fixture.resolverScopes).toEqual([
        { legalEntityId, requestCorrelation: validScope.correlationId, tenantId },
      ]);
      expect(fixture.roleRequests).toEqual([{ counterpartyResourceId: counterpartyRef.resourceId, tenantId }]);
      expect(fixture.calls.some(({ routineKey }) => routineKey === 'profile.read-trading-gate')).toBe(true);
      expect(fixture.calls.some(({ routineKey }) => routineKey === 'counterparty-access.lock-grant-authority')).toBe(
        true,
      );
    }
  }),
);

it.effect('keeps missing, revoked, foreign and unavailable role evidence fail closed on both currentness paths', () =>
  Effect.gen(function* currentRoleNegatives() {
    for (const path of ['SUBMIT', 'REVALIDATE'] as const) {
      for (const role of ['INELIGIBLE', 'INDETERMINATE', 'FOREIGN_LE', 'UNAVAILABLE'] as const) {
        const fixture = currentProfileFixture({ role });
        const result = yield* Effect.result(fixture.run(path));
        if (path === 'REVALIDATE' && role !== 'UNAVAILABLE') {
          expect(Result.isSuccess(result)).toBe(true);
          if (Result.isSuccess(result)) {
            expect(result.success.profile).toBe('INACTIVE');
          }
        } else {
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(result.failure.code).toBe(
              role === 'UNAVAILABLE' ? 'CURRENT_STATE_INDETERMINATE' : 'PROFILE_INACTIVE',
            );
          }
        }
        expect(fixture.roleRequests).toHaveLength(1);
      }
    }
  }),
);

it.effect('retains real profile identity, state, source vector and Core/owner authorization guards', () =>
  Effect.gen(function* otherCurrentnessGuards() {
    for (const path of ['SUBMIT', 'REVALIDATE'] as const) {
      for (const options of [
        { profileId: 'foreign-profile' },
        { profileOutcome: 'PROFILE_NOT_FOUND' },
        { profileLegalEntityId: 'foreign-legal-entity' },
        { staleExternal: true },
      ] as const) {
        const result = yield* Effect.result(currentProfileFixture(options).run(path));
        expect(Result.isFailure(result)).toBe(true);
      }
      for (const options of [
        { profileState: 'SUSPENDED' },
        { profileOutcome: 'PROFILE_RECONCILIATION_REQUIRED' },
        { core: 'denied' },
        { owner: 'REVOKED' },
      ] as const) {
        const result = yield* Effect.result(currentProfileFixture(options).run(path));
        if (path === 'SUBMIT') {
          expect(Result.isFailure(result)).toBe(true);
        } else {
          expect(Result.isSuccess(result)).toBe(true);
          if (Result.isSuccess(result)) {
            expect(result.success.profile === 'INACTIVE' || result.success.buyer === 'DENIED').toBe(true);
          }
        }
      }
      for (const options of [
        { core: 'unavailable' },
        { owner: 'RECONCILIATION_REQUIRED' },
        { unavailableExternal: true },
      ] as const) {
        const result = yield* Effect.result(currentProfileFixture(options).run(path));
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure.code).toBe('CURRENT_STATE_INDETERMINATE');
        }
      }
    }
  }),
);

it.effect('fails closed when the real revalidation factory has no final Bundle/Attempt authority', () =>
  Effect.gen(function* missingFinalBindingAuthority() {
    const result = yield* currentProfileFixture({ finalAuthority: 'MISSING' }).run('REVALIDATE').pipe(Effect.result);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.code).toBe('CURRENT_STATE_INDETERMINATE');
      expect(result.failure.retryable).toBe(true);
    }
  }),
);

it.effect('refuses denied, unknown, foreign, changed, future and expired final-owner observations', () =>
  Effect.gen(function* rejectUnverifiedFinalBindings() {
    for (const finalAuthority of ['DENIED', 'UNKNOWN', 'FOREIGN', 'CHANGED', 'FUTURE', 'EXPIRED'] as const) {
      const failure = yield* Effect.flip(currentProfileFixture({ finalAuthority }).run('REVALIDATE'));
      expect(failure.code).toBe('CURRENT_STATE_INDETERMINATE');
      expect(failure.retryable).toBe(true);
    }
  }),
);

it.effect('treats exact owner-proof expiry as exclusive after a nonempty observation interval', () =>
  Effect.gen(function* exactOwnerProofExpiry() {
    // Both observations began one second earlier. Only the exclusive validUntil
    // boundary differs, so a zero-length observation cannot mask the equality check.
    const before = yield* currentProfileFixture({ finalAuthority: 'BEFORE_EXPIRY' }).run('REVALIDATE');
    expect(before).toEqual({ buyer: 'ALLOWED', profile: 'ACTIVE', routeCurrent: true });
    const expired = yield* Effect.flip(currentProfileFixture({ finalAuthority: 'AT_EXPIRY' }).run('REVALIDATE'));
    expect(expired.code).toBe('CURRENT_STATE_INDETERMINATE');
    expect(expired.reason).toBe('The final Bundle/Attempt authority did not verify the exact current binding');
    expect(expired.retryable).toBe(true);
  }),
);

it.effect('clamps a still-live owner observation to request E and preserves exclusive expiry at E', () =>
  Effect.gen(function* requestExpiryBoundary() {
    const request = currentRequest;
    for (const [observedAt, expected] of [
      [DateTime.subtract(request.expiresAt, { milliseconds: 1 }), 'APPROVAL_VALID'],
      [request.expiresAt, 'REQUEST_EXPIRED'],
      [DateTime.add(request.expiresAt, { milliseconds: 1 }), 'REQUEST_EXPIRED'],
    ] as const) {
      const fixture = currentProfileFixture({ observedAt });
      yield* fixture.run('REVALIDATE', (frame) => {
        expect(frame.checkedAt).toEqual(observedAt);
        expect(DateTime.isGreaterThan(frame.finalBindingEvidence.validUntil, request.expiresAt)).toBe(true);
        expect(frame.validUntil).toEqual(request.expiresAt);
        const decision = revalidateApproval({
          buyerPermission: frame.buyerPermission,
          checkedAt: frame.checkedAt,
          exactProposalHashMatches: true,
          profileState: frame.profileState,
          request,
          routeCurrent: frame.routeCurrent,
          validUntil: frame.validUntil,
        });
        expect(Schema.is(Schema.TaggedStruct(expected, {}))(decision)).toBe(true);
      });
    }
  }),
);
