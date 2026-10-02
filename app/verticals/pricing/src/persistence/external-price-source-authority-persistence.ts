import { defineScopedRoutine } from '@app/core-runtime';
import type { OperationalScope, ReadServiceFactory, ScopedRoutineInvocationError } from '@app/core-runtime';
import { Effect, Option, Schema } from 'effect';

import { ExternalPriceSourceAuthorityGrantSchema } from '../services/external-price-input-boundary.service.ts';
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

const ExternalPriceSourceAuthorityRejectionReasonSchema = Schema.Literals(['AUTHORITY', 'MAPPING']);
const ExternalPriceSourceAuthorityAssessmentSchema = Schema.Union([
  Schema.Struct({ grant: ExternalPriceSourceAuthorityGrantSchema, outcome: Schema.Literal('AUTHORITY_GRANTED') }),
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
const ExternalPriceSourceAuthorityStoreOutcomeSchema = Schema.Union([
  Schema.Struct({ outcome: Schema.Literals(['STORED', 'REUSED']) }),
  Schema.Struct({ outcome: Schema.Literal('CONFLICT'), reason: Schema.Literal('GRANT_IDENTITY_ALREADY_BOUND') }),
]);
export type ExternalPriceSourceAuthorityStoreOutcome = typeof ExternalPriceSourceAuthorityStoreOutcomeSchema.Type;

export class ExternalPriceSourceAuthorityPersistenceUnavailable extends Schema.TaggedError<ExternalPriceSourceAuthorityPersistenceUnavailable>()(
  'ExternalPriceSourceAuthorityPersistenceUnavailable',
  { reason: Schema.String },
) {}

export interface ExternalPriceSourceAuthorityPersistence extends ExternalPriceSourceAuthorityPort {
  readonly store: (
    grant: ExternalPriceSourceAuthorityGrant,
  ) => Effect.Effect<ExternalPriceSourceAuthorityStoreOutcome, ExternalPriceSourceAuthorityPersistenceUnavailable>;
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

const decodeStoreOutcome = (
  rows: readonly (typeof AuthorityRoutineRowSchema.Type)[],
): Effect.Effect<ExternalPriceSourceAuthorityStoreOutcome, ExternalPriceSourceAuthorityPersistenceUnavailable> => {
  const decoded = Option.flatMap(
    onePayload(rows),
    Schema.decodeUnknownOption(ExternalPriceSourceAuthorityStoreOutcomeSchema),
  );
  return Effect.fromOption(decoded, () =>
    unavailable('Pricing external Price Source Authority store returned an invalid outcome'),
  );
};

const requestMatchesScope = (request: ExternalPriceSourceAuthorityAssessmentRequest, scope: OperationalScope) =>
  request.tenantId === scope.tenantId &&
  request.exactIdentityKey.catalogSelection.productRef.tenantId === scope.tenantId &&
  request.exactIdentityKey.catalogSelection.variantRef.tenantId === scope.tenantId &&
  request.exactIdentityKey.unitBasis.unitRef.tenantId === scope.tenantId &&
  request.exactIdentityKey.commercialScope.sellingLegalEntityId === scope.legalEntityId;

const grantMatchesScope = (grant: ExternalPriceSourceAuthorityGrant, scope: OperationalScope) =>
  grant.exactIdentityKey.catalogSelection.productRef.tenantId === scope.tenantId &&
  grant.exactIdentityKey.catalogSelection.variantRef.tenantId === scope.tenantId &&
  grant.exactIdentityKey.unitBasis.unitRef.tenantId === scope.tenantId &&
  grant.exactIdentityKey.commercialScope.sellingLegalEntityId === scope.legalEntityId;

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
    store: (grant) =>
      grantMatchesScope(grant, scope)
        ? transaction.invoke(storeExternalPriceSourceAuthorityGrantRoutine, [grant]).pipe(
            Effect.mapError((cause: ScopedRoutineInvocationError) => unavailable(cause)),
            Effect.flatMap(decodeStoreOutcome),
          )
        : Effect.fail(unavailable('Pricing external Price Source Authority grant is outside the trusted scope')),
  });
