import { DateTime, Effect, Schema } from 'effect';
import type { MarketCommandRejected } from '../../shared/action-contracts.ts';
import { MarketCommandRejected as MarketCommandRejectedError } from '../../shared/action-contracts.ts';
import type { EffectivePeriod } from '../../shared/market-contracts.ts';
import type { MarketDefinitionRevisionRef } from '../../shared/resources/market-definition-revision.ts';
import type { MarketRef } from '../../shared/resources/market.ts';
import type { StorefrontAssociationRef } from '../../shared/resources/storefront-association.ts';
import { MarketRetirementImpactAssessmentSchema } from '../../shared/domain/market-retirement-impact.ts';

export const MODULE_KEY = 'commerce.market-catalog' as const;

export const MarketAdministrationAuditEvidenceSchema = Schema.Struct({
  changed: Schema.Boolean,
  completenessGeneration: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  operation: Schema.Literals([
    'ACTIVATE',
    'ASSOCIATE_STOREFRONT',
    'CREATE',
    'REMOVE_STOREFRONT_ASSOCIATION',
    'RETIRE',
    'REVISE_DEFINITION',
    'REVISE_STOREFRONT_ASSOCIATION',
    'SUSPEND',
  ]),
  reason: Schema.String,
  retirementImpactAssessment: Schema.optionalKey(MarketRetirementImpactAssessmentSchema),
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
});

export const marketRecordedAt = DateTime.now.pipe(Effect.map(DateTime.formatIso));

export const encodeEffectivePeriod = (period: EffectivePeriod) => {
  const startsAt = DateTime.formatIso(period.startsAt);
  return period.endsAt === undefined ? { startsAt } : { endsAt: DateTime.formatIso(period.endsAt), startsAt };
};

export const rejectMarketCommand = (
  code: MarketCommandRejected['code'],
  reason: string,
): Effect.Effect<never, MarketCommandRejected> =>
  Effect.fail(
    new MarketCommandRejectedError({
      code,
      reason,
    }),
  );

export const marketRef = (tenantId: string, resourceId: string): MarketRef => ({
  moduleId: MODULE_KEY,
  resourceId,
  resourceType: 'commerce.market-catalog.market',
  tenantId,
});

export const definitionRevisionRef = (tenantId: string, resourceId: string): MarketDefinitionRevisionRef => ({
  moduleId: MODULE_KEY,
  resourceId,
  resourceType: 'commerce.market-catalog.market-definition-revision',
  tenantId,
});

export const associationRef = (tenantId: string, resourceId: string): StorefrontAssociationRef => ({
  moduleId: MODULE_KEY,
  resourceId,
  resourceType: 'commerce.market-catalog.storefront-association',
  tenantId,
});

export const marketDataAccessEvidence = (input: {
  readonly operation: string;
  readonly resourceId: string;
  readonly resourceType: string;
}) => ({
  accessKind: 'read' as const,
  queryHash: `market-administration:${input.operation}:${input.resourceId}`,
  resultCount: 1,
  servingModuleKey: MODULE_KEY,
  targetModuleKey: MODULE_KEY,
  targetResourceId: input.resourceId,
  targetResourceType: input.resourceType,
});
