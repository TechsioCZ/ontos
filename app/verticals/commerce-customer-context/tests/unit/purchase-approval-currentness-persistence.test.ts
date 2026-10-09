import type {
  ContextAccessService,
  OperationalScope,
  ScopedRoutineDefinition,
  ScopedRoutineInputValues,
  ScopedRoutineInvoker,
  ScopedRoutineParameter,
} from '@app/core-runtime';
import { CoreSearchResourceRefSchema, ScopedRoutineInvocationError } from '@app/core-runtime';
import { Effect, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  AuthBindingIdSchema,
  PrincipalIdSchema,
  TenantIdSchema,
} from '@app/core-runtime/auth/external-identity-contracts';
import { TrustedPrincipalContextSchema } from '@app/core-runtime/actions/principal-context';
import { PurchaseApprovalCurrentnessFactory } from '../../shared/domain/purchase-approval-currentness-port.ts';
import {
  PurchaseProposalRevisionSchema,
  SubmitPurchaseApprovalRequestInputSchema,
} from '../../shared/domain/purchasing-approval.ts';
import { PurchaseLimitSourceRevisionVectorSchema } from '../../shared/domain/purchase-limit-evaluation.ts';
import type { PurchaseLimitEvaluationCurrentnessPortService } from '../../shared/domain/purchase-limit-evaluation-currentness-port.ts';
import { purchaseApprovalCurrentnessFactoryLive } from '../../src/persistence/purchase-approval-currentness-persistence.ts';
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
  }).pipe(Effect.provide(purchaseApprovalCurrentnessFactoryLive)),
);
