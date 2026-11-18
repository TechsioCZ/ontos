import path from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { Effect, Exit } from 'effect';
import { expect, it } from 'effect-rstest';

const { assertRegisteredWorkloadCallers, assertRegisteredWorkloadCallsReceived, REVIEWED_REGISTERED_WORKLOAD_CALLERS } =
  await import(
    /* webpackIgnore: true */
    '../../check-ontos-module-contracts.mts'
  );
const { deriveOntosModuleDeploymentContract, registeredWorkloadCallTopologyIssue } = await import(
  /* webpackIgnore: true */
  '../../generate-ontos-module-contract.mts'
);

const workspaceRoot = path.resolve(import.meta.dirname, '../../..');
/**
 * The calling modules (demo divergence exception 8) and the reviewed calls each built contract records, as
 * 'workloadKey audience declarationKey schemaVersion' with the number of declarations that make it, so a new
 * cross-module credential call is a visible diff here.
 */
const callers = {
  assortment: {
    'commerce.assortment.symmy-fixture-currentness catalog commerce.catalog.assortment-product-classification-v1.read 1': 1,
    'commerce.assortment.symmy-fixture-currentness commerce-customer-context commerce.customer-context.customer-group.read 1': 1,
    'commerce.assortment.symmy-fixture-currentness commerce-market-catalog commerce.market-catalog.assortment-fixture-market-association.read 1': 1,
    'commerce.assortment.symmy-fixture-currentness storefront-registry commerce.storefront-registry.storefront-application.read-current 1': 1,
  },
  'commerce-customer-context': {
    'party.registry.source-read party-registry party.registry.counterparty-organization-ico-facts.read 1': 2,
    'party.registry.source-read party-registry party.registry.source-person-admission.read 1': 3,
    'pricing.price-group-catalog.source-read price-group-catalog pricing.price-group-catalog.price-group.read.compatibility 1': 1,
    'privacy.core.organization-business-check privacy privacy.core.organization-business-applicability.read 1': 3,
    'privacy.core.organization-profile-ico-check privacy privacy.core.organization-profile-ico-applicability.read 1': 2,
    'privacy.core.source-processing-check privacy privacy.core.source-processing-eligibility.read 1': 3,
  },
  'party-registry': {
    'privacy.core.organization-business-check privacy privacy.core.organization-business-applicability.read 1': 1,
    'privacy.core.source-processing-check privacy privacy.core.source-processing-eligibility.read 1': 3,
  },
  pricing: {
    'commerce.catalog.symmy-product-read catalog commerce.catalog.selection-evidence.read 1': 1,
    'commerce.market-catalog.source-read commerce-market-catalog commerce.market-catalog.market-catalog.read 1': 1,
  },
  privacy: {
    'commerce.customer-context.organization-ico-facts.read commerce-customer-context commerce.customer-context.customer-profile-organization-ico-facts.read 1': 3,
    'integration.symmy.source-organization-facts.read symmy-integration integration.symmy.symmy-source-organization-facts.read 1': 1,
    'party.registry.source-read party-registry party.registry.organization-ico-facts.read 1': 1,
    'party.registry.source-read party-registry party.registry.organization-record-facts.read 1': 2,
    'party.registry.source-read party-registry party.registry.source-person-admission.read 1': 2,
  },
  'symmy-integration': {
    'commerce.assortment.symmy-fixture-rule-import assortment commerce.assortment.symmy-fixture-rule.import 1': 1,
    'commerce.catalog.symmy-product-import catalog commerce.catalog.product.create 2': 1,
    'commerce.catalog.symmy-product-import catalog commerce.catalog.product.update 1': 1,
    'commerce.catalog.symmy-product-import catalog commerce.catalog.variant.create 2': 1,
    'commerce.catalog.symmy-product-read catalog commerce.catalog.catalog-source-product-page.read 1': 1,
    'commerce.catalog.symmy-product-read catalog commerce.catalog.catalog-source-products.read 1': 1,
    'commerce.catalog.symmy-product-read catalog commerce.catalog.create-product-recovery.read 1': 1,
    'commerce.catalog.symmy-product-read catalog commerce.catalog.create-variant-recovery.read 1': 1,
    'commerce.catalog.symmy-variant-localized-facts-recovery catalog commerce.catalog.set-variant-localized-facts-recovery.read 1': 1,
    'commerce.catalog.symmy-variant-localized-facts catalog commerce.catalog.variant-localized-facts.set 1': 1,
    'commerce.customer-context.source-read commerce-customer-context commerce.customer-context.customer-group-definition-source.read 1': 4,
    'commerce.customer-context.source-read commerce-customer-context commerce.customer-context.customer-group-membership-source-receipt.read 1': 1,
    'commerce.customer-context.source-read commerce-customer-context commerce.customer-context.customer-price-group-assignment-receipt.read 1': 2,
    'commerce.customer-context.source-read commerce-customer-context commerce.customer-context.customer-profile-source.read 1': 2,
    'commerce.customer-context.source-read commerce-customer-context commerce.customer-context.saved-address-source-receipt.read 1': 3,
    'commerce.customer-context.source-write commerce-customer-context commerce.customer-context.counterparty-price-group.assign 1': 1,
    'commerce.customer-context.source-write commerce-customer-context commerce.customer-context.counterparty-purchasing-profile.create 1': 1,
    'commerce.customer-context.source-write commerce-customer-context commerce.customer-context.customer-group-membership-source.apply 1': 1,
    'commerce.customer-context.source-write commerce-customer-context commerce.customer-context.customer-group.create 1': 2,
    'commerce.customer-context.source-write commerce-customer-context commerce.customer-context.customer-group.update 1': 1,
    'commerce.customer-context.source-write commerce-customer-context commerce.customer-context.customer-price-group.assign 1': 1,
    'commerce.customer-context.source-write commerce-customer-context commerce.customer-context.organization-customer-profile-ico.change 1': 1,
    'commerce.customer-context.source-write commerce-customer-context commerce.customer-context.retail-customer-profile.ensure 1': 1,
    'commerce.customer-context.source-write commerce-customer-context commerce.customer-context.saved-address.add 1': 1,
    'commerce.customer-context.source-write commerce-customer-context commerce.customer-context.saved-address.remove 1': 1,
    'commerce.customer-context.source-write commerce-customer-context commerce.customer-context.saved-address.update 1': 1,
    'commerce.inventory.source-read inventory commerce.inventory.inventory-source-import-receipt.read 1': 2,
    'commerce.inventory.source-write inventory commerce.inventory.source-assertion.import 1': 1,
    'commerce.pricing.source-read pricing commerce.pricing.price-source-result-lookup.read 1': 2,
    'commerce.pricing.source-read pricing commerce.pricing.price.read-definition 1': 1,
    'commerce.pricing.source-write pricing commerce.pricing.price.define 2': 1,
    'commerce.pricing.source-write pricing commerce.pricing.price.revise 2': 1,
    'commerce.tax.symmy-seller-vat-fixture-import tax commerce.tax.seller-vat-regime-declaration.import 1': 1,
    'party.registry.source-read party-registry party.registry.party-source-effect-receipt.read 1': 1,
    'party.registry.source-write party-registry party.registry.contact-point.add 1': 1,
    'party.registry.source-write party-registry party.registry.counterparty.onboard 1': 1,
    'party.registry.source-write party-registry party.registry.party.create 1': 1,
    'party.registry.source-write party-registry party.registry.party.update 1': 1,
    'pricing.price-group-catalog.source-read price-group-catalog pricing.price-group-catalog.price-group-catalog-head.read 1': 1,
    'pricing.price-group-catalog.source-read price-group-catalog pricing.price-group-catalog.price-group-result-lookup.read 1': 2,
    'pricing.price-group-catalog.source-read price-group-catalog pricing.price-group-catalog.price-group-source-associations.read 1': 1,
    'pricing.price-group-catalog.source-write price-group-catalog pricing.price-group-catalog.price-group-definition-revision.create 1': 1,
    'pricing.price-group-catalog.source-write price-group-catalog pricing.price-group-catalog.price-group.create 1': 1,
    'privacy.core.source-processing-check privacy privacy.core.source-processing-eligibility.read 1': 1,
  },
} as const satisfies Readonly<Record<string, Readonly<Record<string, number>>>>;
const receivers = [
  'catalog',
  'commerce-market-catalog',
  'inventory',
  'price-group-catalog',
  'storefront-registry',
  'tax',
];
type Contract = Parameters<typeof assertRegisteredWorkloadCallsReceived>[0][number];
type Call = NonNullable<Contract['manifest']['registeredWorkloadCalls']>[number];

const replacingPricingCalls = (contracts: readonly Contract[], calls: readonly Call[]) =>
  contracts.map((contract) =>
    contract.deployment.appId === 'pricing'
      ? { ...contract, manifest: { ...contract.manifest, registeredWorkloadCalls: calls } }
      : contract,
  );
const refusal = (contracts: readonly Contract[]) =>
  Effect.exit(assertRegisteredWorkloadCallsReceived(contracts)).pipe(
    Effect.map((exit) => (Exit.isFailure(exit) ? String(exit.cause) : 'accepted')),
  );

const callerRefusal = (contracts: Parameters<typeof assertRegisteredWorkloadCallers>[0]) =>
  Effect.exit(assertRegisteredWorkloadCallers(contracts)).pipe(
    Effect.map((exit) => (Exit.isFailure(exit) ? String(exit.cause) : 'accepted')),
  );
const declaring = (appId: string, ...workloadKeys: readonly string[]) => ({
  deployment: { appId },
  manifest: { registeredWorkloadCalls: workloadKeys.map((workloadKey) => ({ workloadKey })) },
});
const sourceWrite = 'commerce.customer-context.source-write';
const sourceProcessingCheck = 'privacy.core.source-processing-check';
const symmyIntegration = 'symmy-integration';

it.effect('admits each registered workload only from its reviewed callers', () =>
  Effect.gen(function* reviewedCallers() {
    expect(REVIEWED_REGISTERED_WORKLOAD_CALLERS.get(sourceWrite)).toEqual([symmyIntegration]);
    expect(
      yield* callerRefusal([
        declaring(symmyIntegration, sourceWrite, sourceProcessingCheck),
        declaring('party-registry', sourceProcessingCheck),
        declaring('catalog'),
      ]),
    ).toBe('accepted');
    // A second declarer of a one-caller workload.
    expect(yield* callerRefusal([declaring(symmyIntegration, sourceWrite), declaring('pricing', sourceWrite)])).toMatch(
      /pricing declares a call as registered workload commerce\.customer-context\.source-write, whose reviewed callers are symmy-integration/u,
    );
    // A sole declarer the table does not name.
    expect(yield* callerRefusal([declaring('privacy', sourceWrite)])).toMatch(
      /privacy declares .* whose reviewed callers are/u,
    );
    expect(yield* callerRefusal([declaring('payment', sourceProcessingCheck)])).toMatch(
      /payment declares .* whose reviewed callers are commerce-customer-context, party-registry, symmy-integration/u,
    );
    // A workload without a reviewed entry.
    expect(yield* callerRefusal([declaring(symmyIntegration, 'commerce.customer-context.source-delete')])).toMatch(
      /source-delete, which has no reviewed caller/u,
    );
  }),
);

it('refuses at generation a call to a deployment the topology does not have', () => {
  expect(registeredWorkloadCallTopologyIssue([{ audience: 'privacy' }], ['privacy', 'party-registry'])).toBeUndefined();
  expect(registeredWorkloadCallTopologyIssue([{ audience: 'privacy-next' }], ['privacy'])).toMatch(
    /privacy-next, which is not a topology deployment/u,
  );
});

it.live(
  'records each calling module calls in its built contract, and the workspace check refuses any undeclared call',
  () =>
    Effect.gen(function* builtCalls() {
      const contracts: readonly Contract[] = yield* Effect.forEach(
        [...Object.keys(callers), ...receivers],
        (vertical) => deriveOntosModuleDeploymentContract({ vertical, workspaceRoot }),
        { concurrency: 2 },
      ).pipe(Effect.provide(NodeServices.layer));
      for (const [appId, reviewed] of Object.entries(callers)) {
        const contract = contracts.find((candidate) => candidate.deployment.appId === appId);
        const built: Record<string, number> = {};
        for (const { audience, declarationKey, schemaVersion, workloadKey } of contract?.manifest
          .registeredWorkloadCalls ?? []) {
          const call = [workloadKey, audience, declarationKey, schemaVersion].join(' ');
          built[call] = (built[call] ?? 0) + 1;
        }
        expect(built).toEqual(reviewed);
      }
      for (const appId of receivers) {
        const contract = contracts.find((candidate) => candidate.deployment.appId === appId);
        expect(contract?.manifest.registeredWorkloadCalls).toBeUndefined();
      }
      expect(yield* refusal(contracts)).toBe('accepted');
      expect(yield* callerRefusal(contracts)).toBe('accepted');

      const first = contracts.find(({ deployment }) => deployment.appId === 'pricing')?.manifest
        .registeredWorkloadCalls?.[0];
      expect(first).toBeDefined();
      if (first === undefined) {
        return;
      }
      expect(yield* refusal(replacingPricingCalls(contracts, [{ ...first, audience: 'tagging' }]))).toMatch(
        /receiver is not installed/u,
      );
      expect(
        yield* refusal(replacingPricingCalls(contracts, [{ ...first, workloadKey: 'commerce.catalog.other-read' }])),
      ).toMatch(/does not declare/u);
      expect(
        yield* refusal(
          replacingPricingCalls(contracts, [{ ...first, declarationKey: 'commerce.catalog.selection-evidence.write' }]),
        ),
      ).toMatch(/does not declare/u);
      expect(yield* refusal(replacingPricingCalls(contracts, [{ ...first, schemaVersion: '9' }]))).toMatch(
        /no such operation version/u,
      );
    }),
  { timeout: 600_000 },
);
