// Test-owned declarations of the pre-extraction protocol. Expected baseline literals live separately.
import { Match, Schema } from 'effect';
import { defineBusinessPermission } from '../../src/permissions/business-permission.ts';
import { createOwnerPermissionAccessTarget } from '../../src/permissions/context-access.ts';
import type { OwnerPermissionAccessTarget, OwnerPermissionContract } from '../../src/permissions/context-access.ts';

interface HistoricalOwnerTargetInput {
  readonly counterpartyId?: string;
  readonly kind?: string;
  readonly legalEntityId?: string;
  readonly moduleId?: string;
  readonly priceGroupId?: string;
  readonly pricingCatalogId?: string;
  readonly profileId?: string;
  readonly resource?: { readonly moduleId: string; readonly resourceId: string; readonly resourceType: string };
  readonly resourceId?: string;
  readonly resourceType?: string;
  readonly storefrontId?: string;
  readonly tenantId?: string;
}

const recordSchema = Schema.Record(Schema.String, Schema.Unknown);
const uuidSchema = Schema.String.check(Schema.isUUID());
const inventoryTypeSchema = Schema.String.check(Schema.isPattern(/^commerce\.inventory\.[a-z][a-z0-9-]*$/u));
const field = (target: HistoricalOwnerTargetInput, name: string): string => {
  if (!Schema.is(recordSchema)(target)) {
    return '';
  }
  const value = target[name];
  return Schema.is(Schema.String)(value) ? value : '';
};
const resourceOf = (target: HistoricalOwnerTargetInput) => {
  if (!Schema.is(recordSchema)(target)) {
    return {};
  }
  const value = target.resource;
  return Schema.is(recordSchema)(value) ? value : {};
};
const parts = (target: HistoricalOwnerTargetInput): readonly string[] => {
  const tenant = field(target, 'tenantId');
  const entity = field(target, 'legalEntityId');
  const kind = field(target, 'kind');
  return Match.value(kind).pipe(
    Match.when('retail_profile', () => [tenant, entity, kind, field(target, 'profileId')]),
    Match.when('counterparty', () => [tenant, entity, kind, field(target, 'counterpartyId')]),
    Match.when('counterparty_storefront', () => [
      tenant,
      entity,
      kind,
      field(target, 'counterpartyId'),
      field(target, 'storefrontId'),
    ]),
    Match.when('pricing_catalog', () => [tenant, kind, field(target, 'pricingCatalogId')]),
    Match.when('price_group', () => [tenant, kind, field(target, 'pricingCatalogId'), field(target, 'priceGroupId')]),
    Match.when('tax_selling_legal_entity', () => [tenant, entity, kind]),
    Match.orElse(() => {
      const resource = resourceOf(target);
      return [
        tenant,
        kind,
        field(resource, 'moduleId'),
        field(resource, 'resourceType'),
        field(resource, 'resourceId'),
      ];
    }),
  );
};
const family = (permission: string) => {
  if (permission.startsWith('retail.')) {
    return { kinds: ['retail_profile'], owner: 'commerce.customer-context' };
  }
  if (permission.startsWith('counterparty.')) {
    return { kinds: ['counterparty', 'counterparty_storefront'], owner: 'commerce.customer-context' };
  }
  if (permission.startsWith('pricing.price_group.')) {
    return { kinds: ['pricing_catalog', 'price_group'], owner: 'pricing.price-group-catalog' };
  }
  if (permission.startsWith('inventory.')) {
    return { kinds: ['inventory_resource'], owner: 'commerce.inventory' };
  }
  if (permission === 'tax.rule.manage') {
    return { kinds: ['tax_selling_legal_entity'], owner: 'commerce.tax' };
  }
  return { kinds: ['unmapped_fixture_target'], owner: 'commerce.fixture' };
};
const contracts = new Map<string, OwnerPermissionContract>();
export const historicalOwnerContract = (permission: string): OwnerPermissionContract => {
  const existing = contracts.get(permission);
  if (existing !== undefined) {
    return existing;
  }
  const identity = family(permission);
  const definition = defineBusinessPermission({
    allowedScopeKinds: identity.kinds,
    auditSensitivity: 'sensitive',
    authorityGroups: [],
    customerDelegable: false,
    internalGrantable: true,
    key: permission,
    meaning: 'An explicit historical owner test declaration.',
    owningCapability: identity.owner,
    protectedEntrypoints: [],
    schemaVersion: '1',
  });
  const contract: OwnerPermissionContract = Object.freeze({
    ownerStateRequired: permission !== 'tax.rule.manage',
    owningModuleKey: identity.owner,
    permissions: Object.freeze([definition]),
    schemaVersion: '1',
    targetResourceType: 'historical_owner_permission',
  });
  contracts.set(permission, contract);
  return contract;
};
export const historicalPermissionKey = ({
  permission,
  target,
}: {
  readonly permission: string;
  readonly target: HistoricalOwnerTargetInput;
}): string => [permission, ...parts(target)].join(':');
export const historicalPermissionObjectId = (
  permission: string,
  target: HistoricalOwnerTargetInput,
): string | undefined => {
  const kind = field(target, 'kind');
  if (!family(permission).kinds.includes(kind)) {
    return undefined;
  }
  if (
    (kind === 'pricing_catalog' || kind === 'price_group') &&
    (!Schema.is(uuidSchema)(field(target, 'pricingCatalogId')) ||
      (kind === 'price_group' && !Schema.is(uuidSchema)(field(target, 'priceGroupId'))))
  ) {
    return undefined;
  }
  const resource = resourceOf(target);
  if (
    kind === 'inventory_resource' &&
    (field(resource, 'moduleId') !== 'commerce.inventory' ||
      !Schema.is(uuidSchema)(field(resource, 'resourceId')) ||
      !Schema.is(inventoryTypeSchema)(field(resource, 'resourceType')))
  ) {
    return undefined;
  }
  const values = [permission, ...parts(target)];
  if (values.some((value) => value.length === 0)) {
    return undefined;
  }
  const encoded = `ctx_${Buffer.from(JSON.stringify(values), 'utf-8').toString('base64url')}`;
  return encoded.length <= 1024 ? encoded : undefined;
};
export const historicalOwnerTarget = (
  permission: string,
  target: HistoricalOwnerTargetInput,
): OwnerPermissionAccessTarget => {
  const contract = historicalOwnerContract(permission);
  const [definition] = contract.permissions;
  if (definition === undefined) {
    throw new Error('Historical fixture requires its published definition');
  }
  const kind = field(target, 'kind');
  const tenantId = field(target, 'tenantId');
  const legalEntityId = field(target, 'legalEntityId');
  const scope = ['retail_profile', 'counterparty', 'counterparty_storefront', 'tax_selling_legal_entity'].includes(kind)
    ? { kind: 'legal_entity' as const, legalEntityId, tenantId }
    : { kind: 'tenant' as const, tenantId };
  const resource = resourceOf(target);
  const transportObjectId = Match.value(kind).pipe(
    Match.when('retail_profile', () => field(target, 'profileId')),
    Match.when('counterparty_storefront', () => `${field(target, 'counterpartyId')}:${field(target, 'storefrontId')}`),
    Match.when('counterparty', () => field(target, 'counterpartyId')),
    Match.when('pricing_catalog', () => field(target, 'pricingCatalogId')),
    Match.when('price_group', () => `${field(target, 'pricingCatalogId')}:${field(target, 'priceGroupId')}`),
    Match.when('tax_selling_legal_entity', () => legalEntityId),
    Match.orElse(() => field(resource, 'resourceId')),
  );
  const base = {
    definition,
    key: historicalPermissionKey({ permission, target }),
    objectId: historicalPermissionObjectId(permission, target) ?? '',
    scope,
    scopeKind: kind,
    target: Schema.is(recordSchema)(target) ? target : {},
    transportModuleKey: contract.owningModuleKey,
    transportObjectId,
    transportResourceType: kind === 'inventory_resource' ? field(resource, 'resourceType') : `${kind}:${permission}`,
  };
  if (kind === 'counterparty_storefront') {
    const inherited = historicalPermissionObjectId(permission, { ...target, kind: 'counterparty' });
    return createOwnerPermissionAccessTarget(contract, {
      ...base,
      alternativeObjectIds: Object.freeze(inherited === undefined ? [] : [inherited]),
      requiredStorefrontId: field(target, 'storefrontId'),
    });
  }
  return createOwnerPermissionAccessTarget(contract, base);
};
export const historicalOwnerReadTarget = (
  permission: string,
  target: HistoricalOwnerTargetInput,
): OwnerPermissionAccessTarget => {
  const prepared = historicalOwnerTarget(permission, target);
  const inventoryResource = field(target, 'kind') === 'inventory_resource' ? resourceOf(target) : undefined;
  return createOwnerPermissionAccessTarget(prepared.contract, {
    ...prepared,
    transportModuleKey: inventoryResource === undefined ? permission : field(inventoryResource, 'moduleId'),
    transportObjectId:
      inventoryResource === undefined ? prepared.transportObjectId : field(inventoryResource, 'resourceId'),
    transportResourceType:
      inventoryResource === undefined ? field(target, 'kind') : field(inventoryResource, 'resourceType'),
  });
};
