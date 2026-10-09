import type { AssortmentPermissionAccessTarget, OperationalScope, ScopedTransactionExecutor } from '@app/core-runtime';
import { DateTime, Effect, Match, Schema } from 'effect';
import { and, eq } from 'drizzle-orm';
import { AssortmentConfigurationResponseSchema } from '../../shared/domain/governed-read-contracts.ts';
import type { AssortmentCatalogSelectorKind } from '../../shared/domain/decision-contracts.ts';
import {
  AssortmentCatalogSelectorKindSchema,
  AssortmentCatalogSelectorSchema,
} from '../../shared/domain/decision-contracts.ts';
import type {
  AssortmentConfigurationRequest,
  AssortmentConfigurationResponse,
} from '../../shared/domain/governed-read-contracts.ts';
import {
  applicabilityBindingEndFacts,
  applicabilityBindings,
  closedBoundaries,
  closedBoundaryEndFacts,
  ruleRetirementFacts,
  ruleRevisions,
  stableRules,
} from '../database/schema.ts';
import { AssortmentPolicyPersistenceUnavailable } from '../../shared/domain/policy-errors.ts';

type Failure = InstanceType<typeof AssortmentPolicyPersistenceUnavailable>;
type ConfigurationResource = AssortmentConfigurationRequest['resource'];
const AssortmentConfigurationCandidateSchema = Schema.Struct({ configuration: Schema.Unknown });
type AssortmentConfigurationCandidate = typeof AssortmentConfigurationCandidateSchema.Encoded;

/** The owner-local source must query only the requested resource under the supplied scope. */
export interface AssortmentConfigurationReadSource {
  readonly resolve: (
    resource: ConfigurationResource,
    scope: OperationalScope,
  ) => Effect.Effect<AssortmentConfigurationResponse, Failure>;
}

/** The generated API remains fail-closed until an owner read adapter is installed. */
export interface AssortmentConfigurationReadService {
  readonly read: (request: AssortmentConfigurationRequest) => Effect.Effect<AssortmentConfigurationResponse, Failure>;
}

const unavailable = (cause?: unknown) => {
  const failure = new AssortmentPolicyPersistenceUnavailable({
    code: 'assortment_policy_persistence_unavailable',
    reason: 'Assortment configuration is temporarily unavailable',
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

const MODULE_ID = 'commerce.assortment';
const CUSTOMER_CONTEXT_MODULE_ID = 'commerce.customer-context';
const PARTY_REGISTRY_MODULE_ID = 'party.registry';
const ref = (resourceType: string, resourceId: string, tenantId: string, moduleId = MODULE_ID) => ({
  moduleId,
  resourceId,
  resourceType,
  tenantId,
});
const instant = (value: Date) => DateTime.formatIso(DateTime.makeUnsafe(value));
const resourceTypes = {
  binding: 'commerce.assortment.applicability-binding',
  boundary: 'commerce.assortment.closed-assortment-boundary',
  revision: 'commerce.assortment.rule-revision',
  stableRule: 'commerce.assortment.stable-rule',
} as const;

const selectorForKind = (kind: AssortmentCatalogSelectorKind, target: ReturnType<typeof ref>) =>
  Match.value(kind).pipe(
    Match.when('CATEGORY', () => ({ categoryRef: target, kind: 'CATEGORY' as const })),
    Match.when('PACKAGE_OPTION', () => ({ kind: 'PACKAGE_OPTION' as const, packageOptionRef: target })),
    Match.when('PRODUCT', () => ({ kind: 'PRODUCT' as const, productRef: target })),
    Match.when('VARIANT', () => ({ kind: 'VARIANT' as const, variantRef: target })),
    Match.when('ALL', () => ({ kind: 'ALL' as const })),
    Match.exhaustive,
  );

const decodeConfiguration = (
  value: AssortmentConfigurationCandidate,
): Effect.Effect<AssortmentConfigurationResponse, Failure> =>
  Schema.decodeUnknownEffect(AssortmentConfigurationResponseSchema)(value).pipe(
    Effect.mapError((cause) => unavailable(cause)),
  );

const configurationSourceForScope = (
  transaction: ScopedTransactionExecutor,
  scope: OperationalScope,
): AssortmentConfigurationReadSource => ({
  resolve: (resource) => {
    const tenant = resource.tenantId;
    if (resource.resourceType === resourceTypes.stableRule) {
      return Effect.gen(function* readStableRule() {
        const rows = yield* transaction
          .select()
          .from(stableRules)
          .where(and(eq(stableRules.tenantId, tenant), eq(stableRules.stableRuleId, resource.resourceId)))
          .limit(1)
          .pipe(Effect.mapError((cause) => unavailable(cause)));
        const [row] = rows;
        if (row === undefined) {
          return yield* unavailable();
        }
        const retirements = yield* transaction
          .select({ retiredAt: ruleRetirementFacts.effectiveAt })
          .from(ruleRetirementFacts)
          .where(
            and(eq(ruleRetirementFacts.tenantId, tenant), eq(ruleRetirementFacts.stableRuleId, resource.resourceId)),
          )
          .limit(1)
          .pipe(Effect.mapError((cause) => unavailable(cause)));
        const retiredAt = retirements[0]?.retiredAt;
        return yield* decodeConfiguration({
          configuration: {
            kind: 'RULE',
            value: {
              createdAt: instant(row.createdAt),
              ...(retiredAt !== undefined && { retiredAt: instant(retiredAt) }),
              stableCode: row.stableCode,
              stableRuleRef: ref(resourceTypes.stableRule, row.stableRuleId, tenant),
            },
          },
        });
      });
    }
    if (resource.resourceType === resourceTypes.revision) {
      return Effect.gen(function* readRevision() {
        const rows = yield* transaction
          .select()
          .from(ruleRevisions)
          .where(and(eq(ruleRevisions.tenantId, tenant), eq(ruleRevisions.ruleRevisionId, resource.resourceId)))
          .limit(1)
          .pipe(Effect.mapError((cause) => unavailable(cause)));
        const [row] = rows;
        if (row === undefined) {
          return yield* unavailable();
        }
        const selectorKind: AssortmentCatalogSelectorKind = yield* Schema.decodeUnknownEffect(
          AssortmentCatalogSelectorKindSchema,
        )(row.selectorKind).pipe(Effect.mapError(unavailable));
        let selectorValue: ReturnType<typeof selectorForKind> | Readonly<{ readonly kind: 'ALL' }>;
        if (selectorKind === 'ALL') {
          selectorValue = { kind: 'ALL' };
        } else {
          // Reconcile legacy rows only from authoritative Catalog owner evidence; never guess the module ID.
          if (row.selectorTargetOwnerModuleId === null || row.selectorTargetOwnerModuleId.trim().length === 0) {
            return yield* unavailable();
          }
          const target = ref(
            row.selectorTargetResourceType ?? '',
            row.selectorTargetResourceId ?? '',
            tenant,
            row.selectorTargetOwnerModuleId,
          );
          selectorValue = selectorForKind(selectorKind, target);
        }
        const selector = yield* Schema.decodeEffect(AssortmentCatalogSelectorSchema)(selectorValue).pipe(
          Effect.mapError(unavailable),
        );
        return yield* decodeConfiguration({
          configuration: {
            kind: 'REVISION',
            value: {
              createdAt: instant(row.recordedAt),
              decisionPurpose: row.purpose,
              effect: row.effect,
              meaningFingerprint: row.semanticFingerprint,
              revision: {
                ownerModuleId: MODULE_ID,
                revision: String(row.revisionNumber),
                sourceRef: ref(resourceTypes.revision, row.ruleRevisionId, tenant),
              },
              selector,
            },
          },
        });
      });
    }
    const { legalEntityId } = scope;
    if (legalEntityId === undefined) {
      return Effect.fail(unavailable());
    }
    if (resource.resourceType === resourceTypes.binding) {
      return Effect.gen(function* readBinding() {
        const rows = yield* transaction
          .select()
          .from(applicabilityBindings)
          .where(
            and(
              eq(applicabilityBindings.tenantId, tenant),
              eq(applicabilityBindings.legalEntityId, legalEntityId),
              eq(applicabilityBindings.applicabilityBindingId, resource.resourceId),
            ),
          )
          .limit(1)
          .pipe(Effect.mapError((cause) => unavailable(cause)));
        const [row] = rows;
        if (row === undefined) {
          return yield* unavailable();
        }
        const revisions = yield* transaction
          .select()
          .from(ruleRevisions)
          .where(and(eq(ruleRevisions.tenantId, tenant), eq(ruleRevisions.ruleRevisionId, row.ruleRevisionId)))
          .limit(1)
          .pipe(Effect.mapError((cause) => unavailable(cause)));
        const [revision] = revisions;
        if (revision === undefined) {
          return yield* unavailable();
        }
        let audience;
        if (row.bindingKind === 'SHARED') {
          audience = { kind: 'SHARED' as const };
        } else if (row.bindingKind === 'COMMERCE_CUSTOMER_GROUP') {
          audience = {
            groupRef: ref(
              'commerce.customer-context.customer-group',
              row.customerGroupResourceId ?? '',
              tenant,
              CUSTOMER_CONTEXT_MODULE_ID,
            ),
            kind: 'COMMERCE_CUSTOMER_GROUP' as const,
          };
        } else if (row.subjectKind === 'COUNTERPARTY') {
          audience = {
            kind: 'SUBJECT' as const,
            subject: {
              counterpartyRef: ref(
                'party.registry.counterparty',
                row.subjectResourceId ?? '',
                tenant,
                PARTY_REGISTRY_MODULE_ID,
              ),
              kind: 'COUNTERPARTY' as const,
            },
          };
        } else {
          audience = {
            kind: 'SUBJECT' as const,
            subject: {
              kind: 'RETAIL_CUSTOMER_PROFILE' as const,
              profileRef: ref(
                'commerce.customer-context.retail-customer-profile',
                row.subjectResourceId ?? '',
                tenant,
                CUSTOMER_CONTEXT_MODULE_ID,
              ),
            },
          };
        }
        const commercialScope = {
          channelRef: ref('commerce.channel.channel', row.channelResourceId, tenant, 'commerce.channel'),
          sellingLegalEntityRef: ref('party.registry.legal-entity', legalEntityId, tenant, PARTY_REGISTRY_MODULE_ID),
          ...(row.marketResourceId !== null && {
            commerceMarketRef: ref('commerce.market.market', row.marketResourceId, tenant, 'commerce.market'),
          }),
          ...(row.storefrontResourceId !== null && {
            storefrontRef: ref(
              'commerce.storefront.storefront',
              row.storefrontResourceId,
              tenant,
              'commerce.storefront',
            ),
          }),
        };
        const ends = yield* transaction
          .select({ effectiveTo: applicabilityBindingEndFacts.effectiveAt })
          .from(applicabilityBindingEndFacts)
          .where(
            and(
              eq(applicabilityBindingEndFacts.tenantId, tenant),
              eq(applicabilityBindingEndFacts.legalEntityId, legalEntityId),
              eq(applicabilityBindingEndFacts.applicabilityBindingId, row.applicabilityBindingId),
            ),
          )
          .limit(1)
          .pipe(Effect.mapError((cause) => unavailable(cause)));
        return yield* decodeConfiguration({
          configuration: {
            kind: 'BINDING',
            value: {
              audience,
              bindingRef: ref(resourceTypes.binding, row.applicabilityBindingId, tenant),
              commercialScope,
              effectiveFrom: instant(row.effectiveFrom),
              ...(ends[0] !== undefined && { effectiveTo: instant(ends[0].effectiveTo) }),
              ruleRevision: {
                ownerModuleId: MODULE_ID,
                revision: String(revision.revisionNumber),
                sourceRef: ref(resourceTypes.revision, revision.ruleRevisionId, tenant),
              },
            },
          },
        });
      });
    }
    return Effect.gen(function* readBoundary() {
      const rows = yield* transaction
        .select()
        .from(closedBoundaries)
        .where(
          and(
            eq(closedBoundaries.tenantId, tenant),
            eq(closedBoundaries.legalEntityId, legalEntityId),
            eq(closedBoundaries.closedBoundaryId, resource.resourceId),
          ),
        )
        .limit(1)
        .pipe(Effect.mapError((cause) => unavailable(cause)));
      const [row] = rows;
      if (row === undefined) {
        return yield* unavailable();
      }
      const ends = yield* transaction
        .select({ effectiveTo: closedBoundaryEndFacts.effectiveAt })
        .from(closedBoundaryEndFacts)
        .where(
          and(
            eq(closedBoundaryEndFacts.tenantId, tenant),
            eq(closedBoundaryEndFacts.legalEntityId, legalEntityId),
            eq(closedBoundaryEndFacts.closedBoundaryId, row.closedBoundaryId),
          ),
        )
        .limit(1)
        .pipe(Effect.mapError((cause) => unavailable(cause)));
      const subject =
        row.subjectKind === 'COUNTERPARTY'
          ? {
              counterpartyRef: ref(
                'party.registry.counterparty',
                row.subjectResourceId,
                tenant,
                PARTY_REGISTRY_MODULE_ID,
              ),
              kind: 'COUNTERPARTY' as const,
            }
          : {
              kind: 'RETAIL_CUSTOMER_PROFILE' as const,
              profileRef: ref(
                'commerce.customer-context.retail-customer-profile',
                row.subjectResourceId,
                tenant,
                CUSTOMER_CONTEXT_MODULE_ID,
              ),
            };
      return yield* decodeConfiguration({
        configuration: {
          kind: 'BOUNDARY',
          value: {
            boundaryRef: ref(resourceTypes.boundary, row.closedBoundaryId, tenant),
            commercialScope: {
              channelRef: ref('commerce.channel.channel', row.channelResourceId, tenant, 'commerce.channel'),
              sellingLegalEntityRef: ref(
                'party.registry.legal-entity',
                legalEntityId,
                tenant,
                PARTY_REGISTRY_MODULE_ID,
              ),
              ...(row.marketResourceId !== null && {
                commerceMarketRef: ref('commerce.market.market', row.marketResourceId, tenant, 'commerce.market'),
              }),
              ...(row.storefrontResourceId !== null && {
                storefrontRef: ref(
                  'commerce.storefront.storefront',
                  row.storefrontResourceId,
                  tenant,
                  'commerce.storefront',
                ),
              }),
            },
            decisionPurpose: row.purpose,
            effectiveFrom: instant(row.effectiveFrom),
            ...(ends[0] !== undefined && { effectiveTo: instant(ends[0].effectiveTo) }),
            meaningFingerprint: row.semanticFingerprint,
            subject,
          },
        },
      });
    });
  },
});

export const assortmentConfigurationReadSourceForScope = configurationSourceForScope;

const isOwnedResource = (resource: ConfigurationResource): boolean =>
  resource.moduleId === MODULE_ID &&
  [
    'commerce.assortment.stable-rule',
    'commerce.assortment.rule-revision',
    'commerce.assortment.applicability-binding',
    'commerce.assortment.closed-assortment-boundary',
  ].includes(resource.resourceType);

export const assortmentConfigurationReadService = (
  source: AssortmentConfigurationReadSource,
  scope: OperationalScope,
): AssortmentConfigurationReadService => {
  const read = Effect.fn('AssortmentConfigurationReadService.read')(function* readConfiguration(
    request: AssortmentConfigurationRequest,
  ) {
    if (
      scope.legalEntityId === undefined ||
      request.resource.tenantId !== scope.tenantId ||
      !isOwnedResource(request.resource)
    ) {
      return yield* unavailable();
    }
    return yield* source.resolve(request.resource, scope);
  });
  return { read };
};

export const configurationPermissionTarget = (
  request: AssortmentConfigurationRequest,
  scope: OperationalScope,
): Extract<AssortmentPermissionAccessTarget, { readonly kind: 'assortment_configuration' }> => {
  if (
    scope.legalEntityId === undefined ||
    request.resource.tenantId !== scope.tenantId ||
    !isOwnedResource(request.resource)
  ) {
    throw unavailable();
  }
  return {
    kind: 'assortment_configuration',
    permission: 'assortment.configuration.read',
    resource: {
      moduleId: request.resource.moduleId,
      resourceId: request.resource.resourceId,
      resourceType: request.resource.resourceType,
    },
  };
};
