import { createHash } from 'node:crypto';

import { ownerResourceModuleContainment } from '@app/core-runtime';
import { v1 } from '@authzed/authzed-node';
import { Array as Arr, Order, Schema } from 'effect';

import { ProductIdReferenceSchema } from '../../verticals/merchandise/shared/domain/merchandise-model.ts';
import { akrosDemoLegalEntityId, demoId, demoTenantId } from './fixture-ids.mts';
import { eshopDemoRoles, principalRelationships } from './permissions.mts';
import type { DemoAction, DemoRelationship } from './permissions.mts';

/** Fixed migration of the demo company's storefront identity; there is no tenant, company or code flag. */
export const legacyStorefront = 'akros-storefront';
export const pseudonymStorefront = 'sroubshop-storefront';
export const pseudonymPrincipalId = demoId('core.principal', pseudonymStorefront);
export const legacyStorefrontPrincipalId = demoId('core.principal', legacyStorefront);
export const legacyMarketPrefix = 'AKROS-';
export const pseudonymMarketPairs = ['CZ', 'SK', 'EU', 'PL', 'CZ-B2B'].map((suffix) => ({
  marketId: demoId('commerce.market-catalog.market', `sroub-${suffix.toLowerCase()}`),
  sourceCode: `${legacyMarketPrefix}${suffix}`,
  targetCode: `SROUB-${suffix}`,
}));
/** Throwaway Market lifecycle QA markets: no replacement; the retire phase retires them and removes their pricing. */
export const isLegacyQaMarket = (code: string) => /^AKROS-QA-[0-9A-Z]+$/u.test(code);
/** Container-local private handoff of the newly issued key, relative to the operator's home directory. */
export const keyHandoffDirectory = '.ontos-operator-handoff';
export const keyHandoffFile = 'sroubshop-storefront-api-key';

/**
 * Startup (`reconcile-stage-service-grants.mts --apply` on every deploy) installs the principals of the deployed
 * `permissions.mts`. Retirement is safe only once that release reconciles the new principal and no longer the old one.
 */
export const deployedServiceSliceReady = (principalIds: readonly string[]) =>
  principalIds.includes(pseudonymPrincipalId) && !principalIds.includes(legacyStorefrontPrincipalId);

export const pseudonymFingerprint = (value: string) => createHash('sha256').update(value).digest('hex');
/** Unreviewed brand text is never rewritten automatically; it stops the plan for a manual edit. */
export const containsLegacyBrand = (text: string) => /akros/iu.test(text);
export const OfferExceptionSchema = Schema.Struct({
  offered: Schema.Boolean,
  productId: Schema.toEncoded(ProductIdReferenceSchema),
});
export type OfferException = typeof OfferExceptionSchema.Type;
export const sameOfferExceptions = Schema.toEquivalence(Schema.Array(OfferExceptionSchema));
export const sortedBy = <A,>(items: Iterable<A>, key: (item: A) => string) =>
  Arr.sort(items, Order.mapInput(Order.String, key));
export const orderedExceptions = (items: readonly OfferException[]) => sortedBy(items, ({ productId }) => productId);

const toRelationship = (item: DemoRelationship) =>
  v1.Relationship.create({
    relation: item.relation,
    resource: { objectId: item.resourceId, objectType: item.resourceType },
    subject: {
      object: { objectId: item.subjectId, objectType: item.subjectType },
      optionalRelation: item.subjectRelation ?? '',
    },
  });

/**
 * Edges whose subject is the old storefront principal itself: its company role, tenant/company membership and direct
 * Action grants. Grants of its own role identity stay untouched; they no longer reach anybody.
 */
export const legacyStorefrontMemberships = (actions: readonly DemoAction[]): readonly v1.Relationship[] =>
  principalRelationships(legacyStorefrontPrincipalId, eshopDemoRoles.akrosStorefront, actions, akrosDemoLegalEntityId)
    .filter(({ subjectId, subjectType }) => subjectType === 'principal' && subjectId === legacyStorefrontPrincipalId)
    .map(toRelationship);

/** Exact storefront service role for the new principal plus the new application's company containment. */
export const pseudonymServiceRelationships = (actions: readonly DemoAction[]): readonly v1.Relationship[] => {
  const app = ownerResourceModuleContainment(demoTenantId, akrosDemoLegalEntityId, {
    moduleId: 'commerce.storefront-registry',
    resourceId: pseudonymStorefront,
    resourceType: 'commerce.storefront-registry.storefront-application',
  });
  const containment: readonly DemoRelationship[] =
    app === undefined
      ? []
      : [
          {
            relation: app.relation,
            resourceId: app.resource.objectId,
            resourceType: app.resource.objectType,
            subjectId: app.container.objectId,
            subjectType: app.container.objectType,
          },
        ];
  return [
    ...principalRelationships(pseudonymPrincipalId, eshopDemoRoles.akrosStorefront, actions, akrosDemoLegalEntityId),
    ...containment,
  ].map(toRelationship);
};
