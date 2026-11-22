import { defineScopedRoutine } from '@app/core-runtime';
import type { OperationalScope, ReadServiceFactory, ScopedRoutineInvocationError } from '@app/core-runtime';
import { Effect, Option, Schema } from 'effect';

import { PricingInstantSchema } from '@app/pricing-contracts/current-supported-currencies';

import {
  ExternalPriceSourcePolicyIdSchema,
  ExternalPriceSourcePolicySchema,
} from '../../shared/domain/external-price-source-policy.ts';
import type {
  ExternalPriceSourcePolicyEndRecord,
  ExternalPriceSourcePolicyRecord,
} from '../../shared/domain/external-price-source-policy.ts';
import {
  ExternalPriceSourceAuthorityGrantInputSchema,
  ExternalPriceSourceAuthorityGrantSchema,
  priceAuthorityKeyInTenant,
} from '../services/external-price-input-boundary.service.ts';
import type {
  ExternalPriceSourceAuthorityAssessment,
  ExternalPriceSourceAuthorityAssessmentRequest,
  ExternalPriceSourceAuthorityGrant,
  ExternalPriceSourceAuthorityPort,
} from '../services/external-price-input-boundary.service.ts';

const ownerModuleKey = 'commerce.pricing';
const schema = 'pricing';
const scopeParameters = [
  { source: 'tenantId', type: 'uuid' },
  { source: 'legalEntityId', type: 'uuid' },
] as const;
const AuthorityRoutineRowSchema = Schema.Struct({ payload: Schema.Unknown });

export const assessExternalPriceSourceAuthorityRoutine = defineScopedRoutine({
  name: 'assess_external_price_source_authority_v1',
  ownerModuleKey,
  parameters: [...scopeParameters, { source: 'input', type: 'jsonb' }],
  resultSchema: AuthorityRoutineRowSchema,
  routineKey: 'pricing.assess-external-price-source-authority-v1',
  schema,
});

export const storeExternalPriceSourceAuthorityGrantRoutine = defineScopedRoutine({
  name: 'store_external_price_source_authority_grant_v1',
  ownerModuleKey,
  parameters: [...scopeParameters, { source: 'input', type: 'jsonb' }],
  resultSchema: AuthorityRoutineRowSchema,
  routineKey: 'pricing.store-external-price-source-authority-grant-v1',
  schema,
});

export const storeExternalPriceSourcePolicyRoutine = defineScopedRoutine({
  name: 'store_external_price_source_policy_v1',
  ownerModuleKey,
  parameters: [...scopeParameters, { source: 'input', type: 'jsonb' }],
  resultSchema: AuthorityRoutineRowSchema,
  routineKey: 'pricing.store-external-price-source-policy-v1',
  schema,
});

export const endExternalPriceSourcePolicyRoutine = defineScopedRoutine({
  name: 'end_external_price_source_policy_v1',
  ownerModuleKey,
  parameters: [...scopeParameters, { source: 'input', type: 'jsonb' }],
  resultSchema: AuthorityRoutineRowSchema,
  routineKey: 'pricing.end-external-price-source-policy-v1',
  schema,
});

const ExternalPriceSourceAuthorityRejectionReasonSchema = Schema.Literals(['AUTHORITY', 'MAPPING']);
const ExternalPriceSourceAuthorityAssessmentSchema = Schema.Union([
  Schema.Struct({ grant: ExternalPriceSourceAuthorityGrantSchema, outcome: Schema.Literal('AUTHORITY_GRANTED') }),
  Schema.Struct({ outcome: Schema.Literal('AUTHORITY_COVERED_BY_POLICY'), policy: ExternalPriceSourcePolicySchema }),
  Schema.Struct({
    outcome: Schema.Literal('AUTHORITY_REJECTED'),
    reason: ExternalPriceSourceAuthorityRejectionReasonSchema,
  }),
  Schema.Struct({
    outcome: Schema.Literal('AUTHORITY_UNRESOLVED'),
    reason: ExternalPriceSourceAuthorityRejectionReasonSchema,
  }),
  Schema.Struct({
    dependency: Schema.Literals(['MAPPING_REGISTRY', 'SOURCE_AUTHORITY']),
    outcome: Schema.Literal('AUTHORITY_UNAVAILABLE'),
  }),
]);
const StoredOrReusedSchema = Schema.Literals(['STORED', 'REUSED']);
const ExternalPriceSourceAuthorityStoreOutcomeSchema = Schema.Union([
  Schema.Struct({ outcome: StoredOrReusedSchema }),
  Schema.Struct({ outcome: Schema.Literal('CONFLICT'), reason: Schema.Literal('GRANT_IDENTITY_ALREADY_BOUND') }),
]);
export type ExternalPriceSourceAuthorityStoreOutcome = typeof ExternalPriceSourceAuthorityStoreOutcomeSchema.Type;

const ExternalPriceSourcePolicyStoreOutcomeSchema = Schema.Union([
  Schema.Struct({
    outcome: StoredOrReusedSchema,
    policyId: ExternalPriceSourcePolicyIdSchema,
    verifiedAt: PricingInstantSchema,
  }),
  Schema.Struct({ outcome: Schema.Literal('CONFLICT'), reason: Schema.Literal('POLICY_OVERLAP') }),
]);
export type ExternalPriceSourcePolicyStoreOutcome = typeof ExternalPriceSourcePolicyStoreOutcomeSchema.Type;

const ExternalPriceSourcePolicyEndOutcomeSchema = Schema.Union([
  Schema.Struct({ effectiveTo: PricingInstantSchema, outcome: Schema.Literals(['ENDED', 'REUSED']) }),
  Schema.Struct({ outcome: Schema.Literal('CONFLICT'), reason: Schema.Literal('POLICY_ALREADY_ENDED') }),
  Schema.Struct({ outcome: Schema.Literal('NOT_FOUND') }),
  Schema.Struct({ outcome: Schema.Literal('REJECTED'), reason: Schema.Literal('END_OUTSIDE_PERIOD') }),
]);
export type ExternalPriceSourcePolicyEndOutcome = typeof ExternalPriceSourcePolicyEndOutcomeSchema.Type;

export class ExternalPriceSourceAuthorityPersistenceUnavailable extends Schema.TaggedError<ExternalPriceSourceAuthorityPersistenceUnavailable>()(
  'ExternalPriceSourceAuthorityPersistenceUnavailable',
  { reason: Schema.String },
) {}

export interface ExternalPriceSourceAuthorityPersistence extends ExternalPriceSourceAuthorityPort {
  readonly endPolicy: (
    end: ExternalPriceSourcePolicyEndRecord,
  ) => Effect.Effect<ExternalPriceSourcePolicyEndOutcome, ExternalPriceSourceAuthorityPersistenceUnavailable>;
  readonly store: (
    grant: ExternalPriceSourceAuthorityGrant,
  ) => Effect.Effect<ExternalPriceSourceAuthorityStoreOutcome, ExternalPriceSourceAuthorityPersistenceUnavailable>;
  readonly storePolicy: (
    policy: ExternalPriceSourcePolicyRecord,
  ) => Effect.Effect<ExternalPriceSourcePolicyStoreOutcome, ExternalPriceSourceAuthorityPersistenceUnavailable>;
}

const unavailable = (cause: unknown) => {
  const failure = new ExternalPriceSourceAuthorityPersistenceUnavailable({
    reason: 'Pricing external Price Source Authority storage could not be verified',
  });
  Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  return failure;
};

const onePayload = (rows: readonly (typeof AuthorityRoutineRowSchema.Type)[]): Option.Option<unknown> =>
  rows.length === 1 && rows[0] !== undefined ? Option.some(rows[0].payload) : Option.none();

export const decodeExternalPriceSourceAuthorityAssessment = (
  rows: readonly (typeof AuthorityRoutineRowSchema.Type)[],
): Effect.Effect<ExternalPriceSourceAuthorityAssessment, ExternalPriceSourceAuthorityPersistenceUnavailable> => {
  const decoded = Option.flatMap(
    onePayload(rows),
    Schema.decodeUnknownOption(ExternalPriceSourceAuthorityAssessmentSchema),
  );
  return Effect.fromOption(decoded, () =>
    unavailable('Pricing external Price Source Authority routine returned an invalid outcome'),
  );
};

const decodeOne =
  <Outcome>(outcomeSchema: Schema.Decoder<Outcome>, reason: string) =>
  (
    rows: readonly (typeof AuthorityRoutineRowSchema.Type)[],
  ): Effect.Effect<Outcome, ExternalPriceSourceAuthorityPersistenceUnavailable> =>
    Effect.fromOption(Option.flatMap(onePayload(rows), Schema.decodeUnknownOption(outcomeSchema)), () =>
      unavailable(reason),
    );

const decodeStoreOutcome = decodeOne(
  ExternalPriceSourceAuthorityStoreOutcomeSchema,
  'Pricing external Price Source Authority store returned an invalid outcome',
);
const decodePolicyStoreOutcome = decodeOne(
  ExternalPriceSourcePolicyStoreOutcomeSchema,
  'Pricing external Price source policy store returned an invalid outcome',
);
const decodePolicyEndOutcome = decodeOne(
  ExternalPriceSourcePolicyEndOutcomeSchema,
  'Pricing external Price source policy end returned an invalid outcome',
);

const identityMatchesScope = (
  identity: ExternalPriceSourceAuthorityAssessmentRequest['exactIdentityKey'],
  scope: OperationalScope,
) =>
  priceAuthorityKeyInTenant(identity, scope.tenantId) &&
  identity.commercialScope.sellingLegalEntityId === scope.legalEntityId;

const requestMatchesScope = (request: ExternalPriceSourceAuthorityAssessmentRequest, scope: OperationalScope) =>
  request.tenantId === scope.tenantId && identityMatchesScope(request.exactIdentityKey, scope);

const policyMatchesScope = (policy: ExternalPriceSourcePolicyRecord, scope: OperationalScope) =>
  policy.unitBasis.unitRef.tenantId === scope.tenantId &&
  policy.commercialScope.sellingLegalEntityId === scope.legalEntityId &&
  (policy.priceGroupCoverage.kind !== 'PRICE_GROUP' ||
    policy.priceGroupCoverage.priceGroupRef.tenantId === scope.tenantId);

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];

export const externalPriceSourceAuthorityForScope = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
): Effect.Effect<ExternalPriceSourceAuthorityPersistence> =>
  Effect.succeed({
    assess: (request) => {
      if (!requestMatchesScope(request, scope)) {
        return Effect.succeed({ outcome: 'AUTHORITY_REJECTED' as const, reason: 'MAPPING' as const });
      }
      return transaction.invoke(assessExternalPriceSourceAuthorityRoutine, [request]).pipe(
        Effect.mapError((cause: ScopedRoutineInvocationError) => unavailable(cause)),
        Effect.flatMap(decodeExternalPriceSourceAuthorityAssessment),
        Effect.orElseSucceed(() => ({
          dependency: 'SOURCE_AUTHORITY' as const,
          outcome: 'AUTHORITY_UNAVAILABLE' as const,
        })),
      );
    },
    endPolicy: (end) =>
      scope.legalEntityId === undefined
        ? Effect.fail(unavailable('Pricing external Price source policy end has no trusted Legal Entity'))
        : transaction.invoke(endExternalPriceSourcePolicyRoutine, [end]).pipe(
            Effect.mapError((cause: ScopedRoutineInvocationError) => unavailable(cause)),
            Effect.flatMap(decodePolicyEndOutcome),
          ),
    store: Effect.fn('ExternalPriceSourceAuthority.store')(function* store(input) {
      const grant = yield* Schema.decodeUnknownEffect(ExternalPriceSourceAuthorityGrantInputSchema)(input).pipe(
        Effect.mapError(unavailable),
      );
      if (
        grant.exactIdentityKey.catalogSelection.productRef.tenantId !== scope.tenantId ||
        grant.exactIdentityKey.commercialScope.sellingLegalEntityId !== scope.legalEntityId
      ) {
        return yield* unavailable('Pricing external Price Source Authority grant is outside the trusted scope');
      }
      return yield* transaction.invoke(storeExternalPriceSourceAuthorityGrantRoutine, [grant]).pipe(
        Effect.mapError((cause: ScopedRoutineInvocationError) => unavailable(cause)),
        Effect.flatMap(decodeStoreOutcome),
      );
    }),
    storePolicy: (policy) =>
      policyMatchesScope(policy, scope)
        ? transaction.invoke(storeExternalPriceSourcePolicyRoutine, [policy]).pipe(
            Effect.mapError((cause: ScopedRoutineInvocationError) => unavailable(cause)),
            Effect.flatMap(decodePolicyStoreOutcome),
          )
        : Effect.fail(unavailable('Pricing external Price source policy is outside the trusted scope')),
  });
