import type { ActionHandlerContext } from '@app/core-runtime';
import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { catalogAuthorityBundles, catalogPublicOperationContracts } from '../../shared/api.ts';
import { handleRetireVariant } from '../../src/actions/retire-variant.action.ts';
import type { VariantPersistence } from '../../src/persistence/variant-persistence.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const foreignTenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const grantedPermissions = (...bundles: (keyof typeof catalogAuthorityBundles)[]) =>
  new Set<string>(bundles.flatMap((bundle) => catalogAuthorityBundles[bundle]));

describe('Catalog permission boundaries (#477)', () => {
  it('does not infer Catalog authority from membership, purchasing, or Storefront identity', () => {
    const catalogPermissions = new Set<string>(
      Object.values(catalogPublicOperationContracts).map(({ permission }) => permission),
    );
    for (const unrelatedGrant of [
      'tenant.member',
      'commerce.counterparty.buyer',
      'commerce.purchase.submit',
      'commerce.storefront.client',
      'admin',
      'manage',
    ]) {
      expect(catalogPermissions.has(unrelatedGrant)).toBe(false);
      expect(
        Object.values(catalogAuthorityBundles).some((permissions) => new Set<string>(permissions).has(unrelatedGrant)),
      ).toBe(false);
    }
    expect(catalogPermissions.has('commerce.catalog.import-source-assertion')).toBe(true);
    expect(catalogPermissions.has('commerce.catalog.activate-local-override')).toBe(true);
    expect(catalogPermissions.has('commerce.catalog.read.storefront')).toBe(false);
  });

  it('keeps Reader, importer, override, product, definition, and lifecycle authority separate', () => {
    const reader = grantedPermissions('CATALOG_READER');
    const editor = grantedPermissions('PRODUCT_EDITOR');
    const definitionManager = grantedPermissions('CATALOG_DEFINITION_MANAGER');
    const lifecycleManager = grantedPermissions('CATALOG_LIFECYCLE_MANAGER');
    const importer = grantedPermissions('CATALOG_IMPORTER');
    const overrideManager = grantedPermissions('CATALOG_OVERRIDE_MANAGER');

    expect(reader.has('commerce.catalog.create-product')).toBe(false);
    expect(editor.has('commerce.catalog.read.product-detail')).toBe(false);
    expect(editor.has('commerce.catalog.rename-attribute-definition')).toBe(false);
    expect(editor.has('commerce.catalog.retire-product')).toBe(false);
    expect(editor.has('commerce.catalog.retire-variant')).toBe(false);
    expect(definitionManager.has('commerce.catalog.correct-product')).toBe(false);
    expect(definitionManager.has('commerce.catalog.retire-product')).toBe(false);
    expect(lifecycleManager.has('commerce.catalog.rename-attribute-definition')).toBe(false);
    expect(lifecycleManager.has('commerce.catalog.correct-product')).toBe(false);
    expect(importer.has('commerce.catalog.activate-local-override')).toBe(false);
    expect(importer.has('commerce.catalog.change-local-override')).toBe(false);
    expect(overrideManager.has('commerce.catalog.import-source-assertion')).toBe(false);
    expect(overrideManager.has('commerce.catalog.correct-product')).toBe(false);

    for (const [leftName, leftPermissions] of Object.entries(catalogAuthorityBundles)) {
      for (const [rightName, rightPermissions] of Object.entries(catalogAuthorityBundles)) {
        if (leftName !== rightName) {
          const rightPermissionSet = new Set<string>(rightPermissions);
          expect(leftPermissions.filter((permission) => rightPermissionSet.has(permission))).toEqual([]);
        }
      }
    }
  });

  it('requires exact permissions even when a principal holds several bundles', () => {
    const editorAndDefinitions = grantedPermissions('PRODUCT_EDITOR', 'CATALOG_DEFINITION_MANAGER');
    expect(editorAndDefinitions.has('commerce.catalog.correct-product')).toBe(true);
    expect(editorAndDefinitions.has('commerce.catalog.rename-attribute-definition')).toBe(true);
    expect(editorAndDefinitions.has('commerce.catalog.retire-product')).toBe(false);
    expect(editorAndDefinitions.has('commerce.catalog.retire-variant')).toBe(false);

    const allBundles = grantedPermissions(
      'CATALOG_READER',
      'PRODUCT_EDITOR',
      'CATALOG_DEFINITION_MANAGER',
      'CATALOG_LIFECYCLE_MANAGER',
      'CATALOG_IMPORTER',
      'CATALOG_OVERRIDE_MANAGER',
    );
    expect(allBundles).toEqual(
      new Set(Object.values(catalogPublicOperationContracts).map(({ permission }) => permission)),
    );
    expect(allBundles.has('commerce.catalog.activate-local-override')).toBe(true);
    expect(allBundles.has('commerce.catalog.future-action')).toBe(false);
  });

  it('classifies Buyer-sensitive retirement as lifecycle-only and tenant-scoped', () => {
    for (const operation of ['commerce.catalog.retire-product', 'commerce.catalog.retire-variant'] as const) {
      expect(catalogPublicOperationContracts[operation]).toMatchObject({
        authorityBundle: 'CATALOG_LIFECYCLE_MANAGER',
        permission: operation,
        permissionKind: 'action_execution',
        scope: 'tenant',
      });
      expect(grantedPermissions('PRODUCT_EDITOR', 'CATALOG_DEFINITION_MANAGER').has(operation)).toBe(false);
    }
    expect(catalogPublicOperationContracts['commerce.catalog.rename-attribute-definition']).toMatchObject({
      authorityBundle: 'CATALOG_DEFINITION_MANAGER',
      permissionKind: 'action_execution',
      scope: 'tenant',
    });
  });

  it.effect('does not resolve a foreign Variant during a lifecycle write', () =>
    Effect.gen(function* foreignVariantRetirement() {
      let persistenceCalls = 0;
      const unexpected = () => {
        persistenceCalls += 1;
        return Effect.die('foreign Variant persistence access');
      };
      const services: VariantPersistence = {
        change: unexpected,
        confirm: unexpected,
        create: unexpected,
        reactivate: unexpected,
        recoverCreateVariant: unexpected,
        retire: unexpected,
      };
      const scope = {
        ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
          authContextRef: 'job:catalog-permission-boundaries:run:1',
          authMethod: 'system',
          principalId: '55555555-5555-4555-8555-555555555555',
          tenantId,
        }),
        correlationId: 'catalog-permission-boundaries',
      };
      const context: ActionHandlerContext<Readonly<Record<string, never>>, VariantPersistence> = {
        actionInvocationId: '66666666-6666-4666-8666-666666666666',
        addDomainEvent: () => Effect.succeed(Object.create(null)),
        addOutboxMessage: () => Effect.void,
        recordAuditEvidence: () => Effect.void,
        recordDataAccess: () => Effect.void,
        scope,
        services,
      };
      const error = yield* handleRetireVariant(
        {
          expectedVariantRevision: 1,
          reason: 'retire',
          variantRef: {
            moduleId: 'commerce.catalog',
            resourceId: '33333333-3333-4333-8333-333333333333',
            resourceType: 'commerce.catalog.variant',
            tenantId: foreignTenantId,
          },
        },
        context,
      ).pipe(Effect.flip);
      expect(error.code).toBe('variant_action_not_found');
      expect(persistenceCalls).toBe(0);
      expect(JSON.stringify(error)).not.toContain(foreignTenantId);
    }),
  );
});
