import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { v1 } from '@authzed/authzed-node';
import { NodeServices } from '@effect/platform-node';
import { Cause, Effect, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  ACTION_AUTHORIZATION_DENIED_PRINCIPAL_ID,
  ActionAuthorizationProvisioningError,
  buildActionAuthorizationRelationships,
  buildExplicitActionGrantRelationships,
  deriveExplicitActionAuthorization,
  provisionActionAuthorization,
} from '../../packages/core-runtime/src/install/action-authorization-provisioning.ts';
import type {
  ActionAuthorizationContext,
  ActionAuthorizationProvisioningClient,
} from '../../packages/core-runtime/src/install/action-authorization-provisioning.ts';
import { parseStageAccountsFile } from '../../packages/core-runtime/src/install/stage-accounts-file.ts';
import type { SpiceDbConfigValue } from '../../packages/core-runtime/src/permissions/config.ts';
import { toSpiceDbActionObjectId } from '../../packages/core-runtime/src/permissions/service.ts';
import type { deriveOntosModuleDeploymentContract as DeriveModuleContract } from '../generate-ontos-module-contract.mts';
import { LOCAL_DEVELOPMENT_CONTEXT } from '../initialize-local-development.mts';
import {
  formatActionAuthorizationProvisioningFailure,
  runCurrentActionAuthorizationProvisioning,
  selectActionAuthorizationProvisioningTarget,
  stageAccountsAuthorization,
} from '../provision-current-action-authorization.mts';
import type {
  discoverCurrentActionKeys as DiscoverCurrentActionKeys,
  StageAccountsAuthorization,
} from '../provision-current-action-authorization.mts';

const attachPersonEngagementAction = 'party.registry.attach-person-engagement';
const restrictedAction = 'core.identity.restricted';
const changePrincipalBindingStatusAction = 'core.identity.change-principal-binding-status';
const testPreSharedKey = 'not-a-real-secret';
const ProvisioningFailureCauseSchema = Schema.Struct({ cause: Schema.Unknown });
const decodeProvisioningFailureCause = Schema.decodeUnknownSync(ProvisioningFailureCauseSchema);

const currentActionKeys = [
  'core.identity.bind-managed-api-key',
  'core.identity.bind-self-api-key',
  'core.identity.change-principal-status',
  'core.identity.create-non-human-principal',
  'core.identity.record-support-impersonation',
  'core.identity.set-managed-api-key-binding-status',
  'core.identity.set-self-api-key-binding-status',
  'core.modules.change-tenant-module-state',
  'party.registry.add-contact-point',
  'party.registry.add-party-official-identifier',
  'party.registry.archive-organization-engagement',
  'party.registry.archive-party',
  'party.registry.archive-person-engagement',
  'party.registry.attach-organization-engagement',
  attachPersonEngagementAction,
  'party.registry.confirm-duplicate-parties',
  'party.registry.correct-party-fact',
  'party.registry.counterparty-create',
  'party.registry.counterparty-role-add',
  'party.registry.counterparty-role-end',
  'party.registry.create-party',
  'party.registry.create-party-relationship',
  'party.registry.dismiss-duplicate-candidate',
  'party.registry.end-contact-point',
  'party.registry.end-party-official-identifier',
  'party.registry.end-party-relationship',
  'party.registry.mark-duplicate-candidate-needs-evidence',
  'party.registry.match-party',
  'party.registry.request-search-rebuild',
  'party.registry.resolve-duplicate-candidate-create',
  'party.registry.resolve-duplicate-candidate-match',
  'party.registry.unarchive-organization-engagement',
  'party.registry.unarchive-party',
  'party.registry.unarchive-person-engagement',
  'party.registry.update-contact-point',
  'party.registry.update-party',
  'party.registry.update-party-official-identifier',
  'party.registry.update-party-relationship',
] as const;

const addedVerticalActionKeys = [
  'commerce.catalog.activate-local-override',
  'commerce.catalog.activate-package-definition',
  'commerce.catalog.activate-package-option',
  'commerce.catalog.add-product-category-assignment',
  'commerce.catalog.assert-size-equivalence',
  'commerce.catalog.assign-catalog-media',
  'commerce.catalog.assign-sku',
  'commerce.catalog.change-local-override',
  'commerce.catalog.change-product-manufacturer',
  'commerce.catalog.change-product-relationship',
  'commerce.catalog.change-variant',
  'commerce.catalog.confirm-gtin',
  'commerce.catalog.confirm-variant-combination',
  'commerce.catalog.correct-gtin',
  'commerce.catalog.correct-product',
  'commerce.catalog.correct-sku',
  'commerce.catalog.create-attribute-definition',
  'commerce.catalog.create-brand',
  'commerce.catalog.create-configuration-unit',
  'commerce.catalog.create-controlled-attribute-value',
  'commerce.catalog.create-package-definition',
  'commerce.catalog.create-product',
  'commerce.catalog.create-product-category',
  'commerce.catalog.create-product-relationship',
  'commerce.catalog.create-product-type',
  'commerce.catalog.create-product-unit',
  'commerce.catalog.create-set-composition',
  'commerce.catalog.create-variant',
  'commerce.catalog.decide-product-type-unnecessary',
  'commerce.catalog.govern-product-attribute-applicability',
  'commerce.catalog.govern-variant-allowed-values',
  'commerce.catalog.govern-variant-axes',
  'commerce.catalog.import-source-assertion',
  'commerce.catalog.mark-gtin-unresolved',
  'commerce.catalog.move-product-category',
  'commerce.catalog.promote-package-definition',
  'commerce.catalog.publish-product-configuration',
  'commerce.catalog.reactivate-brand',
  'commerce.catalog.reactivate-controlled-attribute-value',
  'commerce.catalog.reactivate-product',
  'commerce.catalog.reactivate-variant',
  'commerce.catalog.release-local-override',
  'commerce.catalog.remove-catalog-media',
  'commerce.catalog.remove-product-attribute-values',
  'commerce.catalog.remove-product-category-assignment',
  'commerce.catalog.remove-product-localized-facts',
  'commerce.catalog.remove-product-manufacturer',
  'commerce.catalog.remove-product-relationship',
  'commerce.catalog.remove-variant-attribute-override',
  'commerce.catalog.remove-variant-localized-facts',
  'commerce.catalog.rename-attribute-definition',
  'commerce.catalog.rename-brand',
  'commerce.catalog.rename-controlled-attribute-value',
  'commerce.catalog.rename-product-category',
  'commerce.catalog.rename-sku',
  'commerce.catalog.reorder-catalog-media',
  'commerce.catalog.replace-product-sizes',
  'commerce.catalog.retire-brand',
  'commerce.catalog.retire-configuration-unit',
  'commerce.catalog.retire-controlled-attribute-value',
  'commerce.catalog.retire-gtin',
  'commerce.catalog.retire-package-definition',
  'commerce.catalog.retire-package-option',
  'commerce.catalog.retire-product',
  'commerce.catalog.retire-product-category',
  'commerce.catalog.retire-product-unit',
  'commerce.catalog.retire-variant',
  'commerce.catalog.revise-attribute-definition',
  'commerce.catalog.revise-configuration-unit',
  'commerce.catalog.revise-package-definition',
  'commerce.catalog.revise-product-type',
  'commerce.catalog.revise-product-unit',
  'commerce.catalog.revise-set-composition',
  'commerce.catalog.set-product-attribute-values',
  'commerce.catalog.set-product-brand',
  'commerce.catalog.set-product-localized-facts',
  'commerce.catalog.set-product-manufacturer',
  'commerce.catalog.set-product-type',
  'commerce.catalog.set-product-unit-target-divisibility',
  'commerce.catalog.set-variant-attribute-override',
  'commerce.catalog.set-variant-localized-facts',
  'commerce.catalog.update-product',
  'commerce.assortment.create-applicability-binding',
  'commerce.assortment.create-closed-assortment-boundary',
  'commerce.assortment.create-rule',
  'commerce.assortment.create-rule-revision',
  'commerce.assortment.end-applicability-binding',
  'commerce.assortment.end-closed-assortment-boundary',
  'commerce.assortment.issue-assortment-commitment-confirmation',
  'commerce.assortment.replace-applicability-binding',
  'commerce.assortment.replace-closed-assortment-boundary',
  'commerce.assortment.retire-rule',
  'commerce.customer-context.add-saved-address',
  'commerce.customer-context.administer-commerce-quantity-rule',
  'commerce.customer-context.administer-market-bootstrap-policy',
  'commerce.customer-context.administer-payment-term-policy',
  'commerce.customer-context.administer-purchase-currency-policy',
  'commerce.customer-context.archive-customer-group',
  'commerce.customer-context.archive-customer-profile',
  'commerce.customer-context.assign-commerce-quantity-rule',
  'commerce.customer-context.assign-counterparty-price-group',
  'commerce.customer-context.assign-customer-group',
  'commerce.customer-context.assign-customer-price-group',
  'commerce.customer-context.attribute-guest-retail-customer',
  'commerce.customer-context.bind-retail-portal-profile',
  'commerce.customer-context.bootstrap-counterparty-access-administrator',
  'commerce.customer-context.change-counterparty-purchase-limit',
  'commerce.customer-context.change-customer-payment-terms',
  'commerce.customer-context.change-principal-purchase-limit-override',
  'commerce.customer-context.change-retail-payment-term-preference',
  'commerce.customer-context.claim-counterparty-access-invitation',
  'commerce.customer-context.clear-default-billing-address',
  'commerce.customer-context.clear-default-delivery-destination',
  'commerce.customer-context.consume-purchase-approval',
  'commerce.customer-context.create-approval-hierarchy',
  'commerce.customer-context.create-counterparty-access-invitation',
  'commerce.customer-context.create-counterparty-purchasing-profile',
  'commerce.customer-context.create-customer-group',
  'commerce.customer-context.create-purchase-proposal-revision',
  'commerce.customer-context.decide-purchase-approval-request',
  'commerce.customer-context.ensure-retail-customer-profile',
  'commerce.customer-context.grant-counterparty-commerce-access',
  'commerce.customer-context.migrate-counterparty-price-group',
  'commerce.customer-context.migrate-customer-price-group',
  'commerce.customer-context.open-profile-reconciliation',
  'commerce.customer-context.reactivate-customer-group',
  'commerce.customer-context.reactivate-customer-profile',
  'commerce.customer-context.recover-retail-portal-profile-binding',
  'commerce.customer-context.remove-counterparty-price-group',
  'commerce.customer-context.remove-customer-group',
  'commerce.customer-context.remove-customer-payment-term',
  'commerce.customer-context.remove-customer-price-group',
  'commerce.customer-context.remove-saved-address',
  'commerce.customer-context.repeat-counterparty-order',
  'commerce.customer-context.repeat-retail-order',
  'commerce.customer-context.reroute-purchase-approval-request',
  'commerce.customer-context.resend-counterparty-access-invitation',
  'commerce.customer-context.reserve-market-retirement',
  'commerce.customer-context.reserve-payment-term-retirement',
  'commerce.customer-context.resolve-profile-reconciliation',
  'commerce.customer-context.revalidate-purchase-approval',
  'commerce.customer-context.revoke-counterparty-access-invitation',
  'commerce.customer-context.revoke-counterparty-commerce-access',
  'commerce.customer-context.revoke-retail-portal-profile-binding',
  'commerce.customer-context.set-default-billing-address',
  'commerce.customer-context.set-default-delivery-destination',
  'commerce.customer-context.submit-purchase-approval-request',
  'commerce.customer-context.suspend-customer-profile',
  'commerce.customer-context.trigger-purchase-approval',
  'commerce.customer-context.update-customer-group',
  'commerce.customer-context.update-saved-address',
  'commerce.inventory.create-inventory-reservation',
  'commerce.market-catalog.activate-market',
  'commerce.market-catalog.associate-storefront',
  'commerce.market-catalog.create-market',
  'commerce.market-catalog.remove-storefront-association',
  'commerce.market-catalog.retire-market',
  'commerce.market-catalog.revise-market-definition',
  'commerce.market-catalog.revise-storefront-association',
  'commerce.market-catalog.suspend-market',
  'commerce.pricing.define-price',
  'commerce.pricing.set-supported-currencies',
  'commerce.storefront-registry.register-storefront-application',
  'commerce.storefront-registry.revise-storefront-application',
  'payment.term-catalog.correct-payment-term',
  'payment.term-catalog.create-payment-term',
  'payment.term-catalog.reconcile-payment-term-reference',
  'payment.term-catalog.retire-payment-term',
  'pricing.price-group-catalog.create-price-group',
  'pricing.price-group-catalog.create-price-group-definition-revision',
  'pricing.price-group-catalog.retire-price-group',
] as const;

// These Actions are provisioned as 'explicit' (not Tenant-membership default), so they are discovered
// alongside currentActionKeys/addedVerticalActionKeys but excluded from the tenant-membership fixtures below.
const explicitlyProvisionedActionKeys = [
  'commerce.customer-context.claim-portal-enrollment-transition',
  'commerce.customer-context.record-portal-enrollment-outcome',
  'commerce.customer-context.start-portal-enrollment',
  'commerce.customer-context.terminate-portal-enrollment',
  'commerce.inventory.change-stock-sharing-eligibility',
  'commerce.inventory.compensate-inventory-pre-commit',
  'commerce.inventory.correct-catalog-to-stock-binding',
  'commerce.inventory.correct-external-stock-correlation',
  'commerce.inventory.correct-stock-position',
  'commerce.inventory.end-catalog-to-stock-binding',
  'commerce.inventory.end-external-stock-correlation',
  'commerce.inventory.end-stock-sharing-eligibility',
  'commerce.inventory.establish-catalog-to-stock-binding',
  'commerce.inventory.establish-commitment-protection',
  'commerce.inventory.establish-external-stock-correlation',
  'commerce.inventory.establish-stock-sharing-eligibility',
  'commerce.inventory.import-source-assertion',
  'commerce.inventory.recover-inventory-effect',
  'commerce.inventory.release-inventory-reservation',
  'commerce.inventory.resolve-inventory-source-conflict',
  'commerce.inventory.select-inventory-backend',
  'commerce.inventory.stock-issue',
  'commerce.inventory.stock-receipt',
  'commerce.pricing.compensate-currency-support-recovery',
  'commerce.pricing.define-commercial-fee',
  'commerce.pricing.manage-commitment-confirmation',
  'commerce.pricing.manage-contractual-discount',
  'commerce.pricing.manage-product-commercial-fees-bulk',
  'commerce.pricing.manage-product-prices-bulk',
  'commerce.pricing.manage-quantity-tier',
  'commerce.pricing.manage-quotation',
  'commerce.pricing.manage-zero-floor-authorization',
  'commerce.pricing.revise-commercial-fee',
  'commerce.pricing.revise-price',
  'commerce.tax.correct-tax-rule-revision',
  'commerce.tax.create-tax-rule',
  'commerce.tax.create-tax-rule-revision',
  'commerce.tax.end-tax-fact-authority-contract',
  'commerce.tax.end-tax-rule-revision',
  'commerce.tax.establish-tax-fact-authority-contract',
  'commerce.tax.finalize-order-tax',
  'commerce.tax.record-tax-source-assertion',
  'commerce.tax.revise-tax-fact-authority-contract',
  'core.identity.activate-principal-binding',
  changePrincipalBindingStatusAction,
  'core.identity.reserve-principal-binding',
  'payment.term-catalog.accept-payment-term-source-statement',
  'payment.term-catalog.configure-payment-term-source-authority',
] as const;

const completeCurrentActionKeys = [...addedVerticalActionKeys, ...currentActionKeys, ...explicitlyProvisionedActionKeys]
  // This top-level scripts/tests file resolves against the root tsconfig (no scripts-scoped project), whose
  // default lib lacks the ES2023 toSorted() overload that real tsc + Node accept at runtime; sorting the
  // freshly spread array in place is equivalent and side-effect-free.
  // oxlint-disable-next-line unicorn/no-array-sort -- See comment above.
  .sort();

const currentActions = currentActionKeys.map((actionKey) => ({
  actionKey,
  provisioning: 'tenant_membership_default' as const,
}));

const developmentConfiguration: SpiceDbConfigValue = {
  deploymentEnvironment: 'development',
  endpoint: 'localhost:50051',
  preSharedKey: testPreSharedKey,
};

const stageConfiguration: SpiceDbConfigValue = {
  deploymentEnvironment: 'stage',
  endpoint: 'spicedb:50051',
  preSharedKey: testPreSharedKey,
};

const stageFixtureAccount = (tenant: string, index: number, explicitActions: 'all' | readonly string[]) => ({
  authBindingId: `30000000-0000-4000-8000-0000000000${tenant}${index}`,
  displayName: `Tenant ${tenant.toUpperCase()} account ${index}`,
  email: `account-${tenant}-${index}@example.invalid`,
  grants: { explicitActions, tenantRelations: [] },
  password: `fixture-${tenant}-${index}-password`,
  principalId: `20000000-0000-4000-8000-0000000000${tenant}${index}`,
});

const stageFixtureTenant = (tenant: string) => ({
  accounts: [stageFixtureAccount(tenant, 1, []), stageFixtureAccount(tenant, 2, 'all')] as const,
  defaultLocale: 'cs',
  displayName: `Tenant ${tenant.toUpperCase()}`,
  legalEntity: {
    legalEntityId: `11000000-0000-4000-8000-0000000000${tenant}0`,
    legalName: `Tenant ${tenant.toUpperCase()} Legal`,
    registrationCountry: 'CZ',
    registrationNumber: `FIXTURE-${tenant.toUpperCase()}`,
  },
  moduleStateId: `40000000-0000-4000-8000-0000000000${tenant}0`,
  slug: `tenant-${tenant}`,
  tenantId: `10000000-0000-4000-8000-0000000000${tenant}0`,
});

/** Synthetic operator accounts file: two Tenants, each with one account that holds every explicit Action. */
const stageAccountsFileSource = JSON.stringify({
  retiredAccountEmails: [],
  retiredTenants: [],
  schemaVersion: 2,
  tenants: [stageFixtureTenant('a'), stageFixtureTenant('b')],
});

const stageFixturePrincipal = (tenant: string, index: number) => `20000000-0000-4000-8000-0000000000${tenant}${index}`;
const stageFixtureTenantId = (tenant: string) => `10000000-0000-4000-8000-0000000000${tenant}0`;

/** The Action authorization inputs the synthetic accounts file projects onto. */
const stageAuthorization: StageAccountsAuthorization = {
  contexts: ['a', 'b'].flatMap((tenant) =>
    [1, 2].map((index) => ({
      principalId: stageFixturePrincipal(tenant, index),
      tenantId: stageFixtureTenantId(tenant),
    })),
  ),
  explicitAccountGrants: ['a', 'b'].flatMap((tenant) => [
    { explicitActions: [], principalId: stageFixturePrincipal(tenant, 1) },
    { explicitActions: 'all' as const, principalId: stageFixturePrincipal(tenant, 2) },
  ]),
};

const grantedPrincipalIds = (contexts: readonly ActionAuthorizationContext[]) =>
  contexts.flatMap(({ principalId }) =>
    stageAuthorization.explicitAccountGrants.some(
      (grant) => grant.principalId === principalId && grant.explicitActions === 'all',
    )
      ? [principalId]
      : [],
  );
const ungrantedPrincipalIds = (contexts: readonly ActionAuthorizationContext[]) =>
  contexts.flatMap(({ principalId }) => (grantedPrincipalIds(contexts).includes(principalId) ? [] : [principalId]));

const response = (permissionship: v1.CheckPermissionResponse_Permissionship) =>
  v1.CheckPermissionResponse.create({ permissionship });

const failureOf = <Value,>(effect: Effect.Effect<Value, ActionAuthorizationProvisioningError>) =>
  Effect.gen(function* testEffect1() {
    return yield* Effect.flip(effect);
  });

const rejectionOf = <Value, Failure, Requirements>(effect: Effect.Effect<Value, Failure, Requirements>) =>
  effect.pipe(
    Effect.matchCause({
      onFailure: Cause.squash,
      onSuccess: () => {
        throw new Error('Expected the Effect to fail');
      },
    }),
  );

it.effect(
  'selects only exact source-controlled development and stage targets',
  Effect.fn(function* testEffect2() {
    const development = yield* selectActionAuthorizationProvisioningTarget(developmentConfiguration);
    expect(development.environment).toBe('development');
    expect(development.contexts).toEqual([
      {
        principalId: LOCAL_DEVELOPMENT_CONTEXT.principalId,
        tenantId: LOCAL_DEVELOPMENT_CONTEXT.tenantId,
      },
    ]);

    const stage = yield* selectActionAuthorizationProvisioningTarget(stageConfiguration, stageAuthorization);
    expect(stage.environment).toBe('stage');
    expect(stage.contexts.length).toBe(4);
    expect(stage.explicitAccountGrants).toHaveLength(4);
    expect(new Set(stage.contexts.map(({ tenantId }) => tenantId)).size).toBe(2);
    expect(JSON.stringify(stage)).not.toMatch(/password|example\.invalid/u);
    expect(development.explicitAccountGrants).toEqual([]);

    const { deploymentEnvironment: _environment, ...withoutEnvironment } = developmentConfiguration;
    const implicitDevelopment = yield* selectActionAuthorizationProvisioningTarget(withoutEnvironment);
    expect(implicitDevelopment.contexts).toEqual(development.contexts);
    expect(implicitDevelopment.environment).toBe('development');

    const ipv6Development = yield* selectActionAuthorizationProvisioningTarget({
      ...withoutEnvironment,
      endpoint: '[::1]:50051',
    });
    expect(ipv6Development.environment).toBe('development');

    yield* Effect.all(
      [
        { ...developmentConfiguration, deploymentEnvironment: 'production' },
        {
          ...developmentConfiguration,
          endpoint: 'spicedb.example.com:50051',
        },
        { ...withoutEnvironment, endpoint: 'spicedb.example.com:50051' },
        { ...withoutEnvironment, endpoint: 'spicedb:50051' },
        stageConfiguration,
        { ...stageConfiguration, endpoint: 'localhost:50051' },
        { ...stageConfiguration, endpoint: 'spicedb:50052' },
      ].map((configuration) =>
        Effect.gen(function* testEffect3() {
          const error = yield* failureOf(selectActionAuthorizationProvisioningTarget(configuration));
          expect(error.code).toBe('action_authorization_configuration_invalid');
          expect(error.reason).not.toMatch(new RegExp(testPreSharedKey, 'u'));
        }),
      ),
      { concurrency: 'unbounded' },
    );
  }),
);

it.effect(
  'reports expected provisioning failures and sanitizes unexpected Promise rejections',
  Effect.fn(function* testEffect4() {
    const expected = new ActionAuthorizationProvisioningError({
      code: 'action_authorization_configuration_invalid',
      reason: 'The SpiceDB provisioning configuration is invalid',
    });
    const expectedRejection = yield* rejectionOf(Effect.fail(expected));
    expect(formatActionAuthorizationProvisioningFailure(expectedRejection)).toBe(
      `${expected.code}: ${expected.reason}`,
    );

    const unexpectedMessage =
      'action_authorization_service_unavailable: Unexpected Action authorization provisioning failure';
    for (const error of [undefined, null, testPreSharedKey, new Error(testPreSharedKey), {}]) {
      expect(formatActionAuthorizationProvisioningFailure(error)).toBe(unexpectedMessage);
    }
    const unexpectedRejection = yield* rejectionOf(
      Effect.acquireUseRelease(
        Effect.void,
        () => Effect.void,
        () => Effect.die(new Error(`client.close failed with ${testPreSharedKey}`)),
      ),
    );
    expect(formatActionAuthorizationProvisioningFailure(unexpectedRejection)).toBe(unexpectedMessage);
  }),
);

it.effect(
  'discovers exactly the current generated Action baseline',
  Effect.fn(function* testEffect7() {
    const workspaceRoot = path.resolve(import.meta.dirname, '../..');
    const { discoverCurrentActionKeys } = yield* Effect.promise(
      (): Promise<{
        readonly discoverCurrentActionKeys: typeof DiscoverCurrentActionKeys;
      }> =>
        import(pathToFileURL(path.resolve(import.meta.dirname, '../provision-current-action-authorization.mts')).href),
    );
    const discoveredActionKeys = yield* discoverCurrentActionKeys(workspaceRoot).pipe(
      Effect.provide(NodeServices.layer),
    );
    expect(discoveredActionKeys).toEqual(completeCurrentActionKeys);
    expect(new Set(currentActionKeys).size).toBe(38);
    expect(currentActionKeys.filter((key) => key.startsWith('core.')).length).toBe(8);
    expect(currentActionKeys.filter((key) => key.startsWith('party.registry.')).length).toBe(30);
    expect(new Set(completeCurrentActionKeys).size).toBe(completeCurrentActionKeys.length);
    expect(completeCurrentActionKeys).toHaveLength(257);
    expect(completeCurrentActionKeys.filter((key) => key.startsWith('commerce.pricing.'))).toHaveLength(13);
    expect(completeCurrentActionKeys).toContain('commerce.customer-context.claim-counterparty-access-invitation');
    expect(completeCurrentActionKeys).toContain('commerce.catalog.publish-product-configuration');
    expect(completeCurrentActionKeys).toContain('commerce.assortment.replace-closed-assortment-boundary');
    expect(completeCurrentActionKeys).toContain('payment.term-catalog.retire-payment-term');
    expect(completeCurrentActionKeys).toContain('pricing.price-group-catalog.retire-price-group');
  }),
);

it.effect(
  'builds lossless, deterministic Tenant-membership grants for development and stage',
  Effect.fn(function* testEffect8() {
    const development = yield* selectActionAuthorizationProvisioningTarget(developmentConfiguration);
    const stage = yield* selectActionAuthorizationProvisioningTarget(stageConfiguration, stageAuthorization);
    const developmentRelationships = buildActionAuthorizationRelationships(currentActionKeys, development.contexts);
    const stageRelationships = buildActionAuthorizationRelationships(currentActionKeys, stage.contexts);

    expect(developmentRelationships.length).toBe(38);
    expect(stageRelationships.length).toBe(76);
    for (const relationship of [...developmentRelationships, ...stageRelationships]) {
      expect(relationship.relation).toBe('executor');
      expect(relationship.resource?.objectType).toBe('action');
      expect(relationship.subject?.object?.objectType).toBe('tenant');
      expect(relationship.subject?.optionalRelation).toBe('member');
    }
    const identifiers = stageRelationships.map(
      ({ resource, subject }) => `${resource?.objectId}:${subject?.object?.objectId}`,
    );
    expect(
      identifiers.every((identifier, index) => index === 0 || identifiers[index - 1]?.localeCompare(identifier) <= 0),
    ).toBe(true);
    expect(
      Buffer.from(toSpiceDbActionObjectId(attachPersonEngagementAction).slice(3), 'base64url').toString('utf-8'),
    ).toBe(attachPersonEngagementAction);
    expect(toSpiceDbActionObjectId(attachPersonEngagementAction)).not.toBe(
      toSpiceDbActionObjectId('contacts-core-attach-person-engagement'),
    );
  }),
);

interface ProvisioningClientState {
  readonly grants: Set<string>;
  relationshipWriteCount: number;
  schemaWriteCount: number;
  readonly updates: v1.RelationshipUpdate[];
}

interface ProvisioningClientFixture {
  readonly client: ActionAuthorizationProvisioningClient;
  readonly state: ProvisioningClientState;
}

const permissionResponse = (hasPermission: boolean) =>
  Option.some(
    response(
      hasPermission
        ? v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION
        : v1.CheckPermissionResponse_Permissionship.NO_PERMISSION,
    ),
  );

const hasActionGrant = (
  grants: ReadonlySet<string>,
  resourceId: string,
  principalId: string,
  tenantId: string | undefined,
): boolean =>
  grants.has(`${resourceId}:${principalId}`) || (tenantId !== undefined && grants.has(`${resourceId}:${tenantId}`));

const makeProvisioningClient = (contexts: readonly ActionAuthorizationContext[]): ProvisioningClientFixture => {
  const principalTenants = new Map(contexts.map(({ principalId, tenantId }) => [principalId, tenantId]));
  const state: ProvisioningClientState = {
    grants: new Set(),
    relationshipWriteCount: 0,
    schemaWriteCount: 0,
    updates: [],
  };
  return {
    client: {
      checkPermission: (request) =>
        Effect.sync(() => {
          const principalId = request.subject?.object?.objectId ?? '';
          const tenantId = principalTenants.get(principalId);
          if (request.permission === 'access') {
            return permissionResponse(tenantId === request.resource?.objectId);
          }
          return permissionResponse(
            hasActionGrant(state.grants, request.resource?.objectId ?? '', principalId, tenantId),
          );
        }),
      writeRelationships: (request) =>
        Effect.sync(() => {
          state.relationshipWriteCount += 1;
          state.updates.push(...request.updates);
          for (const update of request.updates) {
            const { relationship } = update;
            state.grants.add(
              `${relationship?.resource?.objectId ?? ''}:${relationship?.subject?.object?.objectId ?? ''}`,
            );
          }
          return v1.WriteRelationshipsResponse.create({});
        }),
      writeSchema: () =>
        Effect.sync(() => {
          state.schemaWriteCount += 1;
          return v1.WriteSchemaResponse.create({});
        }),
    },
    state,
  };
};

it.effect(
  'provisions with TOUCH, verifies both outcomes, and is safe to rerun',
  Effect.fn(function* testEffect9() {
    const target = yield* selectActionAuthorizationProvisioningTarget(developmentConfiguration);
    const { client, state } = makeProvisioningClient(target.contexts);
    const input = { actions: currentActions, contexts: target.contexts };

    const first = yield* provisionActionAuthorization(client, input);
    const second = yield* provisionActionAuthorization(client, input);

    expect(first).toEqual({ actionCount: 38, grantCount: 38, tenantCount: 1 });
    expect(second).toEqual(first);
    expect(state.schemaWriteCount).toBe(2);
    expect(state.relationshipWriteCount).toBe(2);
    expect(state.grants.size).toBe(38);
    expect(state.updates.length).toBe(76);
    expect(state.updates.every(({ operation }) => operation === v1.RelationshipUpdate_Operation.TOUCH)).toBe(true);
    expect(![...state.grants].some((grant) => grant.includes(ACTION_AUTHORIZATION_DENIED_PRINCIPAL_ID))).toBe(true);
  }),
);

it.effect(
  'never grants explicit Actions through Tenant membership and verifies recorded policy outcomes',
  Effect.fn(function* testEffect10() {
    const target = yield* selectActionAuthorizationProvisioningTarget(developmentConfiguration);
    const [context] = target.contexts;
    expect(context !== undefined).toBe(true);
    const deniedContext = {
      principalId: '00000000-0000-4000-8000-000000000020',
      tenantId: '00000000-0000-4000-8000-000000000021',
    };
    const contexts = [...target.contexts, deniedContext];
    const { client, state } = makeProvisioningClient(contexts);
    state.grants.add(`${toSpiceDbActionObjectId(restrictedAction)}:${context.principalId}`);

    const result = yield* provisionActionAuthorization(client, {
      actions: [
        {
          actionKey: attachPersonEngagementAction,
          provisioning: 'tenant_membership_default',
        },
        { actionKey: restrictedAction, provisioning: 'explicit' },
      ],
      contexts,
      explicitActionAssertions: [
        {
          actionKey: restrictedAction,
          assertions: [
            { expected: 'allowed', principalId: context.principalId },
            { expected: 'denied', principalId: deniedContext.principalId },
          ],
        },
      ],
    });

    expect(result).toEqual({ actionCount: 2, grantCount: 2, tenantCount: 2 });
    expect(state.updates.length).toBe(2);
    expect(state.updates[0]?.relationship?.resource?.objectId).toBe(
      toSpiceDbActionObjectId(attachPersonEngagementAction),
    );
  }),
);

it.effect(
  'rejects missing or mismatched explicit Action verification assertions',
  Effect.fn(function* testEffect11() {
    const target = yield* selectActionAuthorizationProvisioningTarget(developmentConfiguration);
    yield* Effect.all(
      [
        undefined,
        [],
        [
          {
            actionKey: restrictedAction,
            assertions: [
              {
                expected: 'allowed' as const,
                principalId: target.contexts[0]?.principalId ?? '',
              },
            ],
          },
        ],
        [
          {
            actionKey: 'core.identity.unknown',
            assertions: [
              {
                expected: 'allowed' as const,
                principalId: target.contexts[0]?.principalId ?? '',
              },
              {
                expected: 'denied' as const,
                principalId: ACTION_AUTHORIZATION_DENIED_PRINCIPAL_ID,
              },
            ],
          },
        ],
      ].map((explicitActionAssertions) =>
        Effect.gen(function* testEffect12() {
          const { client, state } = makeProvisioningClient(target.contexts);
          const error = yield* failureOf(
            provisionActionAuthorization(client, {
              actions: [{ actionKey: restrictedAction, provisioning: 'explicit' }],
              contexts: target.contexts,
              explicitActionAssertions,
            }),
          );
          expect(error.code).toBe('action_authorization_input_invalid');
          expect(state.schemaWriteCount).toBe(0);
          expect(state.relationshipWriteCount).toBe(0);
        }),
      ),
      { concurrency: 'unbounded' },
    );
  }),
);

it.effect(
  'fails promotion when an explicit Action policy contradicts a recorded assertion',
  Effect.fn(function* testEffect13() {
    const target = yield* selectActionAuthorizationProvisioningTarget(developmentConfiguration);
    const [context] = target.contexts;
    expect(context !== undefined).toBe(true);
    const deniedPrincipalId = ACTION_AUTHORIZATION_DENIED_PRINCIPAL_ID;
    const assertions = [
      { expected: 'allowed' as const, principalId: context.principalId },
      { expected: 'denied' as const, principalId: deniedPrincipalId },
    ];

    yield* Effect.all(
      [[], [context.principalId, deniedPrincipalId]].map((actualAllowedPrincipalIds) =>
        Effect.gen(function* testEffect14() {
          const { client, state } = makeProvisioningClient(target.contexts);
          for (const principalId of actualAllowedPrincipalIds) {
            state.grants.add(`${toSpiceDbActionObjectId(restrictedAction)}:${principalId}`);
          }
          const error = yield* failureOf(
            provisionActionAuthorization(client, {
              actions: [{ actionKey: restrictedAction, provisioning: 'explicit' }],
              contexts: target.contexts,
              explicitActionAssertions: [{ actionKey: restrictedAction, assertions }],
            }),
          );
          expect(error.code).toBe('action_authorization_verification_failed');
          expect(state.updates.length).toBe(0);
        }),
      ),
      { concurrency: 'unbounded' },
    );
  }),
);

it.effect(
  'rejects invalid input and missing membership before writing grants',
  Effect.fn(function* testEffect15() {
    const target = yield* selectActionAuthorizationProvisioningTarget(developmentConfiguration);
    const { client, state } = makeProvisioningClient([]);
    const missingMembership = yield* failureOf(
      provisionActionAuthorization(client, {
        actions: currentActions,
        contexts: target.contexts,
      }),
    );
    expect(missingMembership.code).toBe('action_authorization_membership_missing');
    expect(state.schemaWriteCount).toBe(1);
    expect(state.relationshipWriteCount).toBe(0);

    const duplicate = yield* failureOf(
      provisionActionAuthorization(client, {
        actions: [
          {
            actionKey: attachPersonEngagementAction,
            provisioning: 'tenant_membership_default',
          },
          {
            actionKey: attachPersonEngagementAction,
            provisioning: 'tenant_membership_default',
          },
        ],
        contexts: target.contexts,
      }),
    );
    expect(duplicate.code).toBe('action_authorization_input_invalid');
    expect(state.schemaWriteCount).toBe(1);
  }),
);

it.effect(
  'fails closed when authorization returns no permission response',
  Effect.fn(function* testEffect16() {
    const target = yield* selectActionAuthorizationProvisioningTarget(developmentConfiguration);
    const { client } = makeProvisioningClient(target.contexts);
    const noResponseClient: ActionAuthorizationProvisioningClient = {
      ...client,
      checkPermission: () => Effect.succeed(Option.none()),
    };
    const error = yield* failureOf(
      provisionActionAuthorization(noResponseClient, {
        actions: currentActions,
        contexts: target.contexts,
      }),
    );
    expect(error.code).toBe('action_authorization_membership_missing');
  }),
);

it.effect(
  'sanitizes authorization service failures',
  Effect.fn(function* testEffect17() {
    const secret = 'super-secret-credential';
    const upstreamFailure = new Error(secret);
    const target = yield* selectActionAuthorizationProvisioningTarget(developmentConfiguration);
    const unavailable: ActionAuthorizationProvisioningClient = {
      checkPermission: () =>
        Effect.succeed(Option.some(response(v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION))),
      writeRelationships: () => Effect.succeed(v1.WriteRelationshipsResponse.create({})),
      writeSchema: () => Effect.fail(upstreamFailure),
    };
    const error = yield* failureOf(
      provisionActionAuthorization(unavailable, {
        actions: currentActions,
        contexts: target.contexts,
      }),
    );
    expect(error.code).toBe('action_authorization_service_unavailable');
    expect(error.reason).not.toMatch(new RegExp(secret, 'u'));
    expect(decodeProvisioningFailureCause(error).cause).toBe(upstreamFailure);
  }),
);

const writeInventory = (
  root: string,
  verticals: readonly {
    readonly id: string;
    readonly package: string;
    readonly path: string;
  }[],
) =>
  Effect.gen(function* testEffect18() {
    yield* Effect.tryPromise(() => mkdir(path.join(root, 'topology'), { recursive: true }));
    yield* Effect.all(
      [
        Effect.promise(() =>
          writeFile(path.join(root, 'topology/reference-topology.json'), JSON.stringify({ verticals })),
        ),
        Effect.promise(() =>
          writeFile(path.join(root, 'topology/ownership.json'), JSON.stringify({ owners: verticals })),
        ),
      ],
      { concurrency: 'unbounded' },
    );
  });

it.effect(
  'rejects incomplete and duplicate public Action discovery',
  Effect.fn(function* testEffect19() {
    const workspaceRoot = path.resolve(import.meta.dirname, '../..');
    // Native discovery imports registrations dynamically; keep its private registry in one module instance.
    const { discoverCurrentActionKeys } = yield* Effect.promise(
      (): Promise<{
        readonly discoverCurrentActionKeys: typeof DiscoverCurrentActionKeys;
      }> =>
        import(pathToFileURL(path.resolve(import.meta.dirname, '../provision-current-action-authorization.mts')).href),
    );
    const { deriveOntosModuleDeploymentContract } = yield* Effect.promise(
      (): Promise<{
        readonly deriveOntosModuleDeploymentContract: typeof DeriveModuleContract;
      }> => import(pathToFileURL(path.resolve(import.meta.dirname, '../generate-ontos-module-contract.mts')).href),
    );
    const { ActionAuthorizationProvisioningError: NativeProvisioningError } = yield* Effect.promise(
      (): Promise<{
        readonly ActionAuthorizationProvisioningError: typeof ActionAuthorizationProvisioningError;
      }> =>
        import(
          pathToFileURL(
            path.resolve(
              import.meta.dirname,
              '../../packages/core-runtime/src/install/action-authorization-provisioning.ts',
            ),
          ).href
        ),
    );
    const currentContract = yield* deriveOntosModuleDeploymentContract({
      vertical: 'party-registry',
      workspaceRoot,
    }).pipe(Effect.provide(NodeServices.layer));
    const [currentPublicAction] = currentContract.manifest.publicSurface.actions;
    expect(currentPublicAction !== undefined).toBe(true);
    const root = yield* Effect.acquireRelease(
      Effect.tryPromise(() => mkdtemp(path.join(os.tmpdir(), 'ontos-action-discovery-'))),
      (directory) => Effect.promise(() => rm(directory, { force: true, recursive: true })),
    );
    const vertical = {
      id: 'example',
      package: '@app/example',
      path: 'verticals/example',
    };
    yield* writeInventory(root, [vertical]);
    const incomplete: typeof deriveOntosModuleDeploymentContract = (_options) =>
      Effect.succeed({
        ...currentContract,
        deployment: { ...currentContract.deployment, appId: 'wrong-deployment' },
        manifest: {
          ...currentContract.manifest,
          publicSurface: {
            ...currentContract.manifest.publicSurface,
            actions: [],
          },
        },
      });
    const incompleteError = yield* rejectionOf(
      discoverCurrentActionKeys(root, incomplete).pipe(Effect.provide(NodeServices.layer)),
    );
    expect(Schema.is(NativeProvisioningError)(incompleteError)).toBe(true);
    expect(Schema.decodeUnknownSync(NativeProvisioningError)(incompleteError).code).toBe(
      'action_authorization_discovery_failed',
    );

    const foundation: typeof deriveOntosModuleDeploymentContract = (options) =>
      incomplete(options).pipe(
        Effect.map((contract) => ({
          ...contract,
          deployment: { ...contract.deployment, appId: 'example' },
        })),
      );
    const foundationActions = yield* discoverCurrentActionKeys(root, foundation).pipe(
      Effect.provide(NodeServices.layer),
    );
    expect(foundationActions).toEqual(completeCurrentActionKeys.filter((key) => key.startsWith('core.')));

    const duplicate: typeof deriveOntosModuleDeploymentContract = () =>
      Effect.succeed({
        ...currentContract,
        deployment: { ...currentContract.deployment, appId: 'example' },
        manifest: {
          ...currentContract.manifest,
          publicSurface: {
            ...currentContract.manifest.publicSurface,
            actions: [
              {
                ...currentPublicAction,
                actionKey: 'core.identity.bind-managed-api-key',
              },
            ],
          },
        },
      });
    const duplicateError = yield* rejectionOf(
      discoverCurrentActionKeys(root, duplicate).pipe(Effect.provide(NodeServices.layer)),
    );
    expect(Schema.is(NativeProvisioningError)(duplicateError)).toBe(true);
    expect(Schema.decodeUnknownSync(NativeProvisioningError)(duplicateError).code).toBe(
      'action_authorization_discovery_failed',
    );

    yield* writeInventory(root, [vertical, vertical]);
    const duplicateInventoryError = yield* discoverCurrentActionKeys(root, duplicate).pipe(
      Effect.provide(NodeServices.layer),
      Effect.flip,
    );
    expect(Schema.is(NativeProvisioningError)(duplicateInventoryError)).toBe(true);
    expect(duplicateInventoryError.code).toBe('action_authorization_discovery_failed');
  }),
);

it.effect(
  'the operator entrypoint rejects every command-line argument before loading configuration',
  Effect.fn(function* testEffect20() {
    const error = yield* failureOf(
      runCurrentActionAuthorizationProvisioning(path.resolve(import.meta.dirname, '../..'), ['--tenant', 'arbitrary']),
    );
    expect(error.code).toBe('action_authorization_configuration_invalid');
    expect(error.reason).toMatch(/no command-line arguments/u);
  }),
);

const stageExplicitActions = [
  { actionKey: attachPersonEngagementAction, provisioning: 'tenant_membership_default' as const },
  { actionKey: restrictedAction, provisioning: 'explicit' as const },
  { actionKey: changePrincipalBindingStatusAction, provisioning: 'explicit' as const },
];

it.effect(
  'grants each explicit Action to the accounts whose grant data lists it and records every other denial',
  Effect.fn(function* testEffect21() {
    const stage = yield* selectActionAuthorizationProvisioningTarget(stageConfiguration, stageAuthorization);
    const granted = grantedPrincipalIds(stage.contexts);
    const ungranted = ungrantedPrincipalIds(stage.contexts);
    const derived = yield* deriveExplicitActionAuthorization(
      stageExplicitActions,
      stage.contexts,
      stage.explicitAccountGrants,
    );
    expect(derived.explicitActionGrants.map(({ actionKey }) => actionKey)).toEqual([
      restrictedAction,
      changePrincipalBindingStatusAction,
    ]);
    for (const { assertions } of derived.explicitActionAssertions) {
      expect(assertions.filter(({ expected }) => expected === 'allowed').map(({ principalId }) => principalId)).toEqual(
        granted,
      );
      expect(assertions.filter(({ expected }) => expected === 'denied').map(({ principalId }) => principalId)).toEqual([
        ...ungranted,
        ACTION_AUTHORIZATION_DENIED_PRINCIPAL_ID,
      ]);
    }
    const grantRelationships = buildExplicitActionGrantRelationships(derived.explicitActionGrants);
    expect(grantRelationships.length).toBe(4);
    for (const relationship of grantRelationships) {
      expect(relationship.subject?.object?.objectType).toBe('principal');
      expect(relationship.subject?.optionalRelation ?? '').toBe('');
      expect(granted).toContain(relationship.subject?.object?.objectId);
    }

    const { client, state } = makeProvisioningClient(stage.contexts);
    const input = { actions: stageExplicitActions, contexts: stage.contexts, ...derived };
    const first = yield* provisionActionAuthorization(client, input);
    const second = yield* provisionActionAuthorization(client, input);
    expect(first).toEqual({ actionCount: 3, grantCount: 6, tenantCount: 2 });
    expect(second).toEqual(first);
    expect(state.updates.every(({ operation }) => operation === v1.RelationshipUpdate_Operation.TOUCH)).toBe(true);
    expect([...state.grants].some((grant) => ungranted.some((principalId) => grant.endsWith(`:${principalId}`)))).toBe(
      false,
    );

    const noGrants = yield* deriveExplicitActionAuthorization(
      stageExplicitActions,
      stage.contexts,
      stage.explicitAccountGrants.map(({ principalId }) => ({ explicitActions: [], principalId })),
    );
    expect(noGrants.explicitActionGrants).toEqual([]);

    const listed = yield* deriveExplicitActionAuthorization(stageExplicitActions, stage.contexts, [
      { explicitActions: [restrictedAction], principalId: ungranted[0] ?? '' },
    ]);
    expect(listed.explicitActionGrants).toEqual([{ actionKey: restrictedAction, principalIds: [ungranted[0]] }]);
  }),
);

it.effect(
  'fails stage provisioning when a fixed Principal can access the other fixed Tenant',
  Effect.fn(function* testEffect22() {
    const stage = yield* selectActionAuthorizationProvisioningTarget(stageConfiguration, stageAuthorization);
    const derived = yield* deriveExplicitActionAuthorization(
      stageExplicitActions,
      stage.contexts,
      stage.explicitAccountGrants,
    );
    const { client, state } = makeProvisioningClient(stage.contexts);
    const [leaking] = stage.contexts;
    const leakingClient: ActionAuthorizationProvisioningClient = {
      ...client,
      checkPermission: (request) =>
        request.permission === 'access' && request.subject?.object?.objectId === leaking?.principalId
          ? Effect.succeed(permissionResponse(true))
          : client.checkPermission(request),
    };
    const error = yield* failureOf(
      provisionActionAuthorization(leakingClient, {
        actions: stageExplicitActions,
        contexts: stage.contexts,
        ...derived,
      }),
    );
    expect(error.code).toBe('action_authorization_verification_failed');
    expect(state.relationshipWriteCount).toBe(0);
  }),
);

it.effect(
  'rejects explicit grants for non-fixed Principals or Principals without an allowed assertion',
  Effect.fn(function* testEffect23() {
    const stage = yield* selectActionAuthorizationProvisioningTarget(stageConfiguration, stageAuthorization);
    const derived = yield* deriveExplicitActionAuthorization(
      stageExplicitActions,
      stage.contexts,
      stage.explicitAccountGrants,
    );
    const ungranted = ungrantedPrincipalIds(stage.contexts)[0] ?? '';
    yield* Effect.all(
      [
        [{ actionKey: restrictedAction, principalIds: ['00000000-0000-4000-8000-000000000099'] }],
        [{ actionKey: restrictedAction, principalIds: [ungranted] }],
        [{ actionKey: attachPersonEngagementAction, principalIds: [ungranted] }],
        [{ actionKey: restrictedAction, principalIds: [] }],
      ].map((explicitActionGrants) =>
        Effect.gen(function* testEffect24() {
          const { client, state } = makeProvisioningClient(stage.contexts);
          const error = yield* failureOf(
            provisionActionAuthorization(client, {
              actions: stageExplicitActions,
              contexts: stage.contexts,
              explicitActionAssertions: derived.explicitActionAssertions,
              explicitActionGrants,
            }),
          );
          expect(error.code).toBe('action_authorization_input_invalid');
          expect(state.schemaWriteCount).toBe(0);
        }),
      ),
      { concurrency: 'unbounded' },
    );
  }),
);

it.effect(
  'projects the parsed operator accounts file onto sorted contexts and per-account grants',
  Effect.fn(function* projectsAccountsFile() {
    const file = yield* parseStageAccountsFile({ mode: 0o600, source: stageAccountsFileSource });
    expect(stageAccountsAuthorization(file)).toEqual(stageAuthorization);
  }),
);

it.effect(
  'rejects explicit grant data for unknown Principals or Actions outside the explicit set',
  Effect.fn(function* testEffect25() {
    const stage = yield* selectActionAuthorizationProvisioningTarget(stageConfiguration, stageAuthorization);
    const [first] = stage.contexts;
    yield* Effect.all(
      [
        [{ explicitActions: 'all' as const, principalId: '00000000-0000-4000-8000-000000000099' }],
        [{ explicitActions: [attachPersonEngagementAction], principalId: first?.principalId ?? '' }],
        [{ explicitActions: ['core.identity.unknown'], principalId: first?.principalId ?? '' }],
        [
          { explicitActions: 'all' as const, principalId: first?.principalId ?? '' },
          { explicitActions: [], principalId: first?.principalId ?? '' },
        ],
      ].map((accountGrants) =>
        Effect.gen(function* testEffect26() {
          const error = yield* failureOf(
            deriveExplicitActionAuthorization(stageExplicitActions, stage.contexts, accountGrants),
          );
          expect(error.code).toBe('action_authorization_input_invalid');
        }),
      ),
      { concurrency: 'unbounded' },
    );
  }),
);
