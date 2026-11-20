import type { WorkloadBindingHolder } from '@app/core-runtime/access/enforcement';
import { Option } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { symmyIntegrationRegisteredWorkloadCalls } from '../../src/registered-workload-calls.ts';
import {
  SYMMY_JOB_KEY,
  checkSymmyRouteBindings,
  deriveSymmyRouteBindings,
  symmyBindingWorkloads,
  symmyCallInMode,
} from '../../src/ops/symmy-route-bindings.ts';
import type { SymmyRequiredBinding, SymmyRouteContract } from '../../src/ops/symmy-route-bindings.ts';
import { symmyRouteInventoryOf } from '../../src/ops/symmy-route-enrollment.ts';
import type { SymmyEnrollmentRouteKey, SymmyRouteInventory } from '../../src/ops/symmy-route-enrollment.ts';

const admit = 'integration.symmy-admit';
const poll = 'integration.symmy-poll';
const productImport = 'commerce.catalog.symmy-product-import';
const productRead = 'commerce.catalog.symmy-product-read';
const groupRead = 'pricing.price-group-catalog.source-read';
const nestedWrite = 'pricing.price-group-catalog.source-write';
const nestedRecovery = 'pricing.price-group-catalog.recovery-read';
const integrationId = '11111111-1111-4111-8111-111111111111';
const systemId = '22222222-2222-4222-8222-222222222222';
const otherSystemId = '33333333-3333-4333-8333-333333333333';
const company = '44444444-4444-4444-8444-444444444444';

type Surface = SymmyRouteContract['manifest']['publicSurface'];
type Calls = NonNullable<SymmyRouteContract['manifest']['registeredWorkloadCalls']>;
type Requirement = NonNullable<SymmyRouteContract['manifest']['requirements']>['operations'][number];
/** The installed module of each app a test call is addressed to. */
const modules = new Map([
  ['assortment', 'commerce.assortment'],
  ['catalog', 'commerce.catalog'],
  ['commerce-customer-context', 'commerce.customer-context'],
  ['commerce-market-catalog', 'commerce.market-catalog'],
  ['inventory', 'commerce.inventory'],
  ['party-registry', 'party.registry'],
  ['price-group-catalog', 'pricing.price-group-catalog'],
  ['pricing', 'commerce.pricing'],
  ['privacy', 'privacy.core'],
  ['tax', 'commerce.tax'],
]);
/** The requirements by which an operation names the operations its calls reach, as an owner manifest declares them. */
const requires = (entrypointKey: string, calls: readonly Calls[number][]): Requirement[] =>
  calls.map((call) => ({
    entrypointKey,
    key: `${entrypointKey}.requirement.${call.entrypointKey}`,
    provider: {
      entrypointKey: call.entrypointKey,
      moduleId: modules.get(call.audience) ?? call.audience,
      schemaVersion: call.schemaVersion,
    },
  }));
const contract = (
  appId: string,
  moduleId: string,
  surface: Partial<Surface>,
  calls: Calls = [],
  operations: readonly Requirement[] = [],
): SymmyRouteContract => ({
  deployment: { appId },
  manifest: {
    module: { id: moduleId },
    publicSurface: { actions: surface.actions ?? [], operationContracts: surface.operationContracts ?? [] },
    registeredWorkloadCalls: calls,
    requirements: { intrinsic: [], operations },
  },
});
const carrier = (entrypointKey: string, workloads: readonly string[], declarationKey = `${entrypointKey}.read`) => ({
  entrypoint: { entrypointKey },
  schemaVersion: '1',
  workloadCarrier: { declarationKey, workloads },
});
/**
 * The receiving side of every call Symmy registers for one entrypoint, exactly as Symmy registers it: from its job
 * worker, or from its synchronous admission.
 */
const received = (entrypointKey: string, sync = false) =>
  symmyIntegrationRegisteredWorkloadCalls.filter(
    (call) => call.entrypointKey === entrypointKey && (sync ? 'sourceActionKey' in call : 'workerKey' in call),
  );
const receivingAction = (entrypointKey: string, sync = false) =>
  received(entrypointKey, sync).map((call) => ({
    accessDeclaration: { key: call.declarationKey },
    accessWorkload: { workloads: [call.workloadKey] },
    entrypoint: { entrypointKey },
    legalEntityScope: call.legalEntityScope,
    schemaVersion: call.schemaVersion,
  }));
const receivingRead = (entrypointKey: string, sync = false) =>
  received(entrypointKey, sync)
    .slice(0, 1)
    .map((call) => carrier(entrypointKey, [call.workloadKey], call.declarationKey));

/** Symmy as installed: its carriers, the calls it declares and the job requirements naming them. */
const symmyWith = (calls: Calls, operations: readonly Requirement[]) =>
  contract(
    'symmy-integration',
    'integration.symmy',
    {
      actions: [
        {
          accessWorkload: { workloads: [admit] },
          entrypoint: { entrypointKey: 'integration.symmy.admit-symmy-job' },
          schemaVersion: '1',
        },
      ],
      operationContracts: [
        carrier('integration.symmy.api.symmy-route-context', [admit, poll]),
        carrier('integration.symmy.api.symmy-job-status', [poll]),
      ],
    },
    calls,
    operations,
  );
const jobCalls = symmyIntegrationRegisteredWorkloadCalls.filter(symmyCallInMode('job'));
const symmy = symmyWith(symmyIntegrationRegisteredWorkloadCalls, requires(SYMMY_JOB_KEY, jobCalls));
const nestedCall = {
  audience: 'price-group-catalog',
  declarationKey: 'pricing.price-group-catalog.nested.read',
  entrypointKey: 'pricing.price-group-catalog.api.nested',
  jobKey: SYMMY_JOB_KEY,
  legalEntityScope: 'forbidden' as const,
  schemaVersion: '1',
  sourceWorkloadKey: productImport,
  workloadKey: nestedWrite,
};
const nestedRecoveryCall = {
  ...nestedCall,
  allowRecoverySource: true,
  declarationKey: 'pricing.price-group-catalog.nested-recovery.read',
  entrypointKey: 'pricing.price-group-catalog.api.nested-recovery',
  sourceWorkloadKey: productRead,
  workloadKey: nestedRecovery,
};
const catalog = contract(
  'catalog',
  'commerce.catalog',
  {
    actions: receivingAction('commerce.catalog.create-product'),
    operationContracts: [
      ...receivingRead('commerce.catalog.api.catalog-source-products'),
      ...receivingRead('commerce.catalog.api.create-product-recovery'),
    ],
  },
  [nestedCall, nestedRecoveryCall],
  [
    ...requires('commerce.catalog.create-product', [nestedCall]),
    ...requires('commerce.catalog.api.create-product-recovery', [nestedRecoveryCall]),
  ],
);
const priceGroups = contract('price-group-catalog', 'pricing.price-group-catalog', {
  operationContracts: [
    carrier('pricing.price-group-catalog.api.price-group-source-associations', [groupRead]),
    carrier(nestedCall.entrypointKey, [nestedWrite], nestedCall.declarationKey),
    carrier(nestedRecoveryCall.entrypointKey, [nestedRecovery], nestedRecoveryCall.declarationKey),
  ],
});

/** The Privacy source processing check Commerce customer context makes for a membership write, as main registers it. */
const privacyCheck = {
  audience: 'privacy',
  declarationKey: 'privacy.core.source-processing-eligibility.read',
  entrypointKey: 'privacy.core.api.source-processing-eligibility',
  jobKey: SYMMY_JOB_KEY,
  legalEntityScope: 'required' as const,
  schemaVersion: '1',
  sourceWorkloadKey: 'commerce.customer-context.source-write',
  workloadKey: 'privacy.core.source-processing-check',
};

/** Pricing publishing only the source reads named, under the Pricing source read workload. */
const pricingReading = (published: readonly string[]) =>
  contract('pricing', 'commerce.pricing', {
    operationContracts: published.map((entrypointKey) => carrier(entrypointKey, ['commerce.pricing.source-read'])),
  });

const inventoryOf = (routeKey: SymmyEnrollmentRouteKey): SymmyRouteInventory => {
  const found = symmyRouteInventoryOf(routeKey);
  if (Option.isNone(found)) {
    throw new Error(`expected the ${routeKey} inventory`);
  }
  return found.value;
};
const products = () => inventoryOf('productsBatch');
const enrolledOf = (routeKey: SymmyEnrollmentRouteKey, entrypointKeys: readonly string[]) =>
  inventoryOf(routeKey).operations.filter(({ entrypointKey }) => entrypointKeys.includes(entrypointKey));
const enrolledProducts = () =>
  enrolledOf('productsBatch', [
    'commerce.catalog.create-product',
    'pricing.price-group-catalog.api.price-group-source-associations',
  ]);
/** The worker call of the Catalog Product create, as Symmy declares it. */
const createProduct = (call: Calls[number]) =>
  call.entrypointKey === 'commerce.catalog.create-product' && 'workerKey' in call;
/** The bindings of a products route that enrolls only the Pricing define. */
const definePrices = (contracts: readonly SymmyRouteContract[]) =>
  deriveSymmyRouteBindings({
    companyScoped: true,
    contracts,
    enrolled: enrolledOf('productsBatch', ['commerce.pricing.define-price']),
    inventory: products(),
  });
const derive = (contracts: readonly SymmyRouteContract[]) =>
  deriveSymmyRouteBindings({ companyScoped: true, contracts, enrolled: enrolledProducts(), inventory: products() });
/** Each binding of a plan with whether its calls run in the route's company. */
const scoped = ({ bindings }: { readonly bindings: readonly SymmyRequiredBinding[] }) =>
  bindings.map(
    ({ companyScoped, identity, workloads }) => `${identity} ${workloads.join(' | ')}: ${String(companyScoped)}`,
  );
const workloadsOf = (bindings: readonly SymmyRequiredBinding[], identity: SymmyRequiredBinding['identity']) =>
  bindings.filter((binding) => binding.identity === identity).map(({ workloads }) => workloads.join(' | '));
/** The bindings of a read route of this kind for a company, enrolling every read of its inventory. */
const readRoute = (routeKey: SymmyEnrollmentRouteKey, contracts: readonly SymmyRouteContract[]) => {
  const inventory = inventoryOf(routeKey);
  return deriveSymmyRouteBindings({ companyScoped: true, contracts, enrolled: inventory.operations, inventory });
};
/** The refusals of a plan whose every workload the integration principal holds, registered for the company as named. */
const integrationRefusals = (bindings: readonly SymmyRequiredBinding[], companyRegistration: 'binding' | 'none') =>
  checkSymmyRouteBindings({
    bindings,
    holders: new Map(
      symmyBindingWorkloads(bindings).map(
        (workload) =>
          [
            workload,
            [{ apiKey: true, companyRegistration, kind: 'integration' as const, principalId: integrationId }],
          ] as const,
      ),
    ),
    legalEntityId: company,
    principalId: integrationId,
  }).refusals;

describe('Symmy route bindings', () => {
  it('derives the integration and executor bindings of a route from the active composition', () => {
    const plan = derive([symmy, catalog, priceGroups]);
    expect(plan.refusals).toEqual([]);
    expect(plan.moduleKeys).toEqual(['commerce.catalog', 'integration.symmy', 'pricing.price-group-catalog']);
    expect(workloadsOf(plan.bindings, 'integration')).toEqual([
      `${admit} | ${poll}`,
      admit,
      poll,
      groupRead,
      productImport,
      nestedWrite,
      productRead,
    ]);
    expect(workloadsOf(plan.bindings, 'executor')).toEqual([
      productImport,
      nestedWrite,
      productRead,
      nestedRecovery,
      SYMMY_JOB_KEY,
    ]);
    expect(symmyBindingWorkloads(plan.bindings)).toContain(nestedRecovery);
  });

  it('refuses a route whose calls or reads the active composition does not publish', () => {
    const plan = derive([symmy, priceGroups]);
    expect(plan.refusals.map(({ code }) => code)).toEqual([
      'operation_not_published',
      'operation_not_published',
      'operation_not_published',
    ]);
    expect(derive([symmy, catalog]).refusals.map(({ detail }) => detail)).toEqual([
      'pricing.price-group-catalog.api.price-group-source-associations@1 is not published by pricing.price-group-catalog',
      expect.stringContaining('pricing.price-group-catalog.api.nested@1'),
      expect.stringContaining('pricing.price-group-catalog.api.nested-recovery@1'),
    ]);
  });

  it("takes Symmy's own workloads from its descriptors, as its deployed reads publish no carrier", () => {
    const deployed = (reads: readonly string[]) =>
      contract(
        'symmy-integration',
        'integration.symmy',
        {
          actions: [
            {
              accessWorkload: { workloads: [admit] },
              entrypoint: { entrypointKey: 'integration.symmy.admit-symmy-job' },
              schemaVersion: '1',
            },
          ],
          operationContracts: reads.map((entrypointKey) => ({ entrypoint: { entrypointKey }, schemaVersion: '1' })),
        },
        symmyIntegrationRegisteredWorkloadCalls,
        requires(SYMMY_JOB_KEY, jobCalls),
      );
    const plan = derive([
      deployed(['integration.symmy.api.symmy-route-context', 'integration.symmy.api.symmy-job-status']),
      catalog,
      priceGroups,
    ]);
    expect(plan.refusals).toEqual([]);
    expect(workloadsOf(plan.bindings, 'integration').slice(0, 3)).toEqual([`${admit} | ${poll}`, admit, poll]);
    expect(derive([deployed(['integration.symmy.api.symmy-route-context']), catalog, priceGroups]).refusals).toEqual([
      {
        code: 'operation_not_published',
        detail: 'integration.symmy.api.symmy-job-status@1 is not published by integration.symmy',
      },
    ]);
  });

  it('refuses a call the deployed Symmy does not declare, even when its receiver publishes it', () => {
    const undeclared = symmyWith(
      symmyIntegrationRegisteredWorkloadCalls.filter((call) => !createProduct(call)),
      requires(SYMMY_JOB_KEY, jobCalls),
    );
    expect(derive([undeclared, catalog, priceGroups]).refusals).toEqual([
      {
        code: 'call_not_declared',
        detail: 'The installed integration.symmy registers no job call of commerce.catalog.create-product@2',
      },
    ]);
    const unrequired = symmyWith(
      symmyIntegrationRegisteredWorkloadCalls,
      requires(
        SYMMY_JOB_KEY,
        jobCalls.filter((call) => !createProduct(call)),
      ),
    );
    expect(derive([unrequired, catalog, priceGroups]).refusals).toEqual([
      {
        code: 'call_not_declared',
        detail: `The installed integration.symmy names commerce.catalog.create-product@2 on commerce.catalog as no requirement of ${SYMMY_JOB_KEY}`,
      },
    ]);
  });

  it('asks only for the nested calls the owner names for the enrolled operation, not for its whole workload', () => {
    const sourceWrite = privacyCheck.sourceWorkloadKey;
    const compatibility = {
      ...privacyCheck,
      audience: 'price-group-catalog',
      declarationKey: 'pricing.price-group-catalog.price-group.read.compatibility',
      entrypointKey: 'pricing.price-group-catalog.api.validate-price-group-compatibility',
      legalEntityScope: 'forbidden' as const,
      workloadKey: groupRead,
    };
    const customerContext = contract(
      'commerce-customer-context',
      'commerce.customer-context',
      {
        actions: receivingAction('commerce.customer-context.apply-customer-group-membership-source'),
        operationContracts: [
          ...receivingRead('commerce.customer-context.api.customer-group-definition-source'),
          ...receivingRead('commerce.customer-context.api.customer-group-membership-source-receipt'),
        ],
      },
      [privacyCheck, compatibility],
      [
        ...requires('commerce.customer-context.apply-customer-group-membership-source', [privacyCheck]),
        ...requires('commerce.customer-context.assign-customer-price-group', [compatibility]),
      ],
    );
    const privacy = contract('privacy', 'privacy.core', {
      operationContracts: [
        carrier(privacyCheck.entrypointKey, [privacyCheck.workloadKey], privacyCheck.declarationKey),
      ],
    });
    const compatibilityReceiver = contract('price-group-catalog', 'pricing.price-group-catalog', {
      operationContracts: [carrier(compatibility.entrypointKey, [groupRead], compatibility.declarationKey)],
    });
    const membership = inventoryOf('customerGroupCustomersBatch');
    const plan = deriveSymmyRouteBindings({
      companyScoped: true,
      contracts: [symmy, customerContext, privacy, compatibilityReceiver],
      enrolled: membership.operations,
      inventory: membership,
    });
    expect(plan.refusals).toEqual([]);
    expect(plan.moduleKeys).toEqual(['commerce.customer-context', 'integration.symmy', 'privacy.core']);
    expect(workloadsOf(plan.bindings, 'executor')).toEqual([
      sourceWrite,
      privacyCheck.workloadKey,
      'commerce.customer-context.source-read',
      SYMMY_JOB_KEY,
    ]);
    expect(symmyBindingWorkloads(plan.bindings)).not.toContain(groupRead);
  });

  it('refuses by name a requirement of a reached operation its owner registers no call for', () => {
    // Pricing requires its market read for define-price but omits the call to it.
    const sourceWrite = 'commerce.pricing.source-write';
    const marketRead = {
      audience: 'commerce-market-catalog',
      declarationKey: 'commerce.market-catalog.market-catalog.read',
      entrypointKey: 'commerce.market-catalog.api.current-market-catalog',
      jobKey: SYMMY_JOB_KEY,
      legalEntityScope: 'required' as const,
      schemaVersion: '1',
      sourceWorkloadKey: sourceWrite,
      workloadKey: 'commerce.market-catalog.source-read',
    };
    const marketRequirement: Requirement = {
      entrypointKey: 'commerce.pricing.define-price',
      key: 'commerce.pricing.requirement.define-price-market',
      provider: { entrypointKey: marketRead.entrypointKey, moduleId: 'commerce.market-catalog', schemaVersion: '1' },
    };
    const pricing = (calls: Calls) =>
      contract(
        'pricing',
        'commerce.pricing',
        {
          actions: receivingAction('commerce.pricing.define-price'),
          operationContracts: receivingRead('commerce.pricing.api.price-source-result-lookup'),
        },
        calls,
        [marketRequirement],
      );
    const market = contract('commerce-market-catalog', 'commerce.market-catalog', {
      operationContracts: [carrier(marketRead.entrypointKey, [marketRead.workloadKey], marketRead.declarationKey)],
    });
    const declared = definePrices([symmy, pricing([marketRead]), market]);
    expect(declared.refusals).toEqual([]);
    expect(workloadsOf(declared.bindings, 'executor')).toContain(marketRead.workloadKey);
    const required =
      'The installed commerce.pricing requires commerce.market-catalog commerce.market-catalog.api.current-market-catalog@1 for commerce.pricing.define-price@2 (requirement commerce.pricing.requirement.define-price-market)';
    expect(definePrices([symmy, pricing([]), market]).refusals).toEqual([
      { code: 'call_not_declared', detail: `${required} and registers no call to it under ${sourceWrite}` },
    ]);
    // Two calls that would serve the requirement leave the gateway no single call to admit.
    const twice = pricing([
      marketRead,
      { ...marketRead, declarationKey: 'commerce.market-catalog.market-catalog.read-again' },
    ]);
    expect(definePrices([symmy, twice, market]).refusals).toEqual([
      {
        code: 'call_not_declared',
        detail: `${required} and registers 2 calls, where one is needed, to it under ${sourceWrite}`,
      },
    ]);
    // The call must reach the module the requirement names, not only its operation.
    const elsewhere = contract('commerce-market-catalog', 'commerce.other-market', {
      operationContracts: [carrier(marketRead.entrypointKey, [marketRead.workloadKey], marketRead.declarationKey)],
    });
    expect(definePrices([symmy, pricing([marketRead]), elsewhere]).refusals.map(({ detail }) => detail)).toEqual([
      `${required}, and its registered call reaches commerce.other-market`,
    ]);

    // A nested owner's requirement too, as on main: Privacy requires Party's organization record facts for the check
    // Commerce customer context makes for a membership write, and registers no call to them.
    const organizationParty: Requirement = {
      entrypointKey: privacyCheck.entrypointKey,
      key: 'privacy.core.requirement.customer-intake-organization-party',
      provider: {
        entrypointKey: 'party.registry.api.organization-record-facts',
        moduleId: 'party.registry',
        schemaVersion: '1',
      },
    };
    const customerContext = contract(
      'commerce-customer-context',
      'commerce.customer-context',
      {
        actions: receivingAction('commerce.customer-context.apply-customer-group-membership-source'),
        operationContracts: [
          ...receivingRead('commerce.customer-context.api.customer-group-definition-source'),
          ...receivingRead('commerce.customer-context.api.customer-group-membership-source-receipt'),
        ],
      },
      [privacyCheck],
      requires('commerce.customer-context.apply-customer-group-membership-source', [privacyCheck]),
    );
    const privacy = contract(
      'privacy',
      'privacy.core',
      {
        operationContracts: [
          carrier(privacyCheck.entrypointKey, [privacyCheck.workloadKey], privacyCheck.declarationKey),
        ],
      },
      [],
      [organizationParty],
    );
    const membership = inventoryOf('customerGroupCustomersBatch');
    expect(
      deriveSymmyRouteBindings({
        companyScoped: true,
        contracts: [symmy, customerContext, privacy],
        enrolled: membership.operations,
        inventory: membership,
      }).refusals,
    ).toEqual([
      {
        code: 'call_not_declared',
        detail: `The installed privacy.core requires party.registry party.registry.api.organization-record-facts@1 for privacy.core.api.source-processing-eligibility@1 (requirement privacy.core.requirement.customer-intake-organization-party) and registers no call to it under ${privacyCheck.workloadKey}`,
      },
    ]);
  });

  it('asks the integration principal for the price reads the Shell makes for a REVISE, and only for one', () => {
    const reads = ['commerce.pricing.api.price-schedule', 'commerce.pricing.api.price-group-source-prices'];
    const unpublished = (entrypointKeys: readonly string[], published: readonly string[]) =>
      deriveSymmyRouteBindings({
        companyScoped: true,
        contracts: [symmy, pricingReading(published), priceGroups],
        enrolled: enrolledOf('priceListPricesBatch', entrypointKeys),
        inventory: inventoryOf('priceListPricesBatch'),
      }).refusals.flatMap(({ detail }) => (reads.some((read) => detail.startsWith(read)) ? [detail] : []));
    expect(unpublished(['commerce.pricing.revise-price'], [])).toEqual([
      'commerce.pricing.api.price-schedule@1 is not published by commerce.pricing',
      'commerce.pricing.api.price-group-source-prices@1 is not published by commerce.pricing',
    ]);
    expect(unpublished(['commerce.pricing.revise-price'], reads)).toEqual([]);
    expect(unpublished(['commerce.pricing.define-price'], [])).toEqual([]);
  });

  it('asks the integration principal for the Group definition read the Shell makes before it admits groups, registered for the route company', () => {
    const definitionRead = 'commerce.customer-context.api.customer-group-definition-source';
    const sourceRead = 'commerce.customer-context.source-read';
    const groupBindings = (published: readonly string[]) =>
      deriveSymmyRouteBindings({
        companyScoped: true,
        contracts: [
          symmy,
          contract('commerce-customer-context', 'commerce.customer-context', {
            operationContracts: published.map((entrypointKey) => carrier(entrypointKey, [sourceRead])),
          }),
        ],
        enrolled: enrolledOf('customerGroupsBatch', [
          'commerce.customer-context.create-customer-group',
          definitionRead,
        ]),
        inventory: inventoryOf('customerGroupsBatch'),
      });
    const reading = groupBindings([definitionRead]);
    // Commerce publishes the read `required`, so the Shell signs it into the route's company: the integration principal
    // needs one of its bindings registered for that company, or the company gate refuses the read there.
    const definitionBindings = reading.bindings.filter(({ purpose }) => purpose === `${definitionRead}@1`);
    expect(definitionBindings).toEqual([
      { companyScoped: true, identity: 'integration', purpose: `${definitionRead}@1`, workloads: [sourceRead] },
    ]);
    expect(integrationRefusals(definitionBindings, 'binding')).toEqual([]);
    expect(integrationRefusals(definitionBindings, 'none')).toEqual([
      {
        code: 'integration_company_registration_missing',
        detail: `The integration principal ${integrationId} holds ${sourceRead}, needed for ${definitionRead}@1, but none of its active bindings is registered for company ${company}, so the company gate refuses it there (deny.workload_unbound)`,
      },
    ]);
    expect(reading.moduleKeys).toContain('commerce.customer-context');
    expect(groupBindings([]).refusals.map(({ detail }) => detail)).toContain(
      `${definitionRead}@1 is not published by commerce.customer-context`,
    );
  });

  it('derives the bindings of a Tenant-wide stock route and refuses one with a company, which Inventory publishes no import for', () => {
    const syncAdmission = 'integration.symmy.admit-symmy-sync';
    const sourceWrite = 'commerce.inventory.source-write';
    const sourceRead = 'commerce.inventory.source-read';
    const syncSymmy = contract(
      'symmy-integration',
      'integration.symmy',
      {
        actions: [
          { accessWorkload: { workloads: [admit] }, entrypoint: { entrypointKey: syncAdmission }, schemaVersion: '1' },
        ],
        operationContracts: [
          carrier('integration.symmy.api.symmy-route-context', [admit, poll]),
          carrier('integration.symmy.api.symmy-sync-admission', [admit]),
        ],
      },
      symmyIntegrationRegisteredWorkloadCalls,
      requires(syncAdmission, symmyIntegrationRegisteredWorkloadCalls.filter(symmyCallInMode('sync'))),
    );
    const inventory = contract('inventory', 'commerce.inventory', {
      actions: receivingAction('commerce.inventory.import-source-assertion', true),
      operationContracts: receivingRead('commerce.inventory.api.inventory-source-import-receipt', true),
    });
    const stock = (companyScoped: boolean) =>
      deriveSymmyRouteBindings({
        companyScoped,
        contracts: [syncSymmy, inventory],
        enrolled: inventoryOf('inventoryStockBatch').operations,
        inventory: inventoryOf('inventoryStockBatch'),
      });
    const tenantWide = stock(false);
    expect(tenantWide.refusals).toEqual([]);
    expect(tenantWide.moduleKeys).toEqual(['commerce.inventory', 'integration.symmy']);
    // The route context, the admission and its receipt, then the import the gateway checks the integration principal for.
    expect(workloadsOf(tenantWide.bindings, 'integration')).toEqual([`${admit} | ${poll}`, admit, admit, sourceWrite]);
    // The import and its recovery through the receipt read run as the worker, and no job is executed.
    expect(workloadsOf(tenantWide.bindings, 'executor')).toEqual([sourceWrite, sourceRead]);
    // The route names no company, so neither identity needs a company registration for any binding.
    expect(tenantWide.bindings.filter(({ companyScoped }) => companyScoped)).toEqual([]);
    expect(stock(true).refusals).toEqual([
      {
        code: 'company_scope_forbidden',
        detail:
          'commerce.inventory.import-source-assertion@1 is published without a company, which the synchronous admission of this route passes to it',
      },
    ]);
  });

  it('refuses a company-scoped call on a route that passes no company to it', () => {
    const pricing = contract('pricing', 'commerce.pricing', {
      actions: receivingAction('commerce.pricing.define-price'),
      operationContracts: receivingRead('commerce.pricing.api.price-source-result-lookup'),
    });
    const prices = (companyScoped: boolean) =>
      deriveSymmyRouteBindings({
        companyScoped,
        contracts: [symmy, pricing],
        enrolled: enrolledOf('productsBatch', ['commerce.pricing.define-price']),
        inventory: products(),
      }).refusals;
    expect(prices(true)).toEqual([]);
    expect(prices(false).map(({ code, detail }) => `${code}: ${detail}`)).toEqual([
      'company_scope_required: commerce.pricing.define-price@2 is published for a company, which this route does not pass to it',
      'company_scope_required: commerce.pricing.api.price-source-result-lookup@1 is published for a company, which this route does not pass to it',
    ]);
  });

  it('checks every binding by name and names the executor of each workload', () => {
    const { bindings } = derive([symmy, catalog, priceGroups]);
    const both = [
      {
        apiKey: true,
        companyRegistration: 'binding' as const,
        kind: 'integration' as const,
        principalId: integrationId,
      },
      { apiKey: false, companyRegistration: 'binding' as const, kind: 'system' as const, principalId: systemId },
    ];
    const holders = new Map(symmyBindingWorkloads(bindings).map((workload) => [workload, both] as const));
    const satisfied = checkSymmyRouteBindings({
      bindings,
      holders,
      legalEntityId: company,
      principalId: integrationId,
    });
    expect(satisfied.refusals).toEqual([]);
    expect(satisfied.executors.get(SYMMY_JOB_KEY)).toBe(systemId);
    expect(satisfied.executors.get(nestedRecovery)).toBe(systemId);

    const missing = new Map<string, readonly WorkloadBindingHolder[]>([...holders, [productImport, []]]);
    expect(
      checkSymmyRouteBindings({ bindings, holders: missing, legalEntityId: company, principalId: integrationId })
        .refusals,
    ).toEqual([
      {
        code: 'integration_binding_missing',
        detail: `The integration principal holds none of ${productImport}, needed for commerce.catalog.create-product@2`,
      },
      {
        code: 'executor_binding_missing',
        detail: `No active system principal holds ${productImport}, needed for commerce.catalog.create-product@2`,
      },
    ]);

    const shared = new Map<string, readonly WorkloadBindingHolder[]>([
      ...holders,
      [
        productRead,
        [...both, { apiKey: false, companyRegistration: 'binding', kind: 'system', principalId: otherSystemId }],
      ],
    ]);
    expect(
      checkSymmyRouteBindings({
        bindings,
        holders: shared,
        legalEntityId: company,
        principalId: integrationId,
      }).refusals.map(({ code }) => code),
    ).toEqual(['executor_binding_not_unique']);

    // The route context admits either Symmy workload; the admission needs its own.
    const pollOnly = new Map<string, readonly WorkloadBindingHolder[]>([
      ...holders,
      [admit, [{ apiKey: false, companyRegistration: 'binding', kind: 'system', principalId: systemId }]],
    ]);
    expect(
      checkSymmyRouteBindings({
        bindings,
        holders: pollOnly,
        legalEntityId: company,
        principalId: integrationId,
      }).refusals.map(({ detail }) => detail),
    ).toEqual([`The integration principal holds none of ${admit}, needed for job admission`]);
  });

  it('refuses a route principal without an active API-key binding, whatever workload bindings it holds', () => {
    const { bindings } = derive([symmy, catalog, priceGroups]);
    const unbound = [
      {
        apiKey: false,
        companyRegistration: 'binding' as const,
        kind: 'integration' as const,
        principalId: integrationId,
      },
      { apiKey: false, companyRegistration: 'binding' as const, kind: 'system' as const, principalId: systemId },
    ];
    const holders = new Map(symmyBindingWorkloads(bindings).map((workload) => [workload, unbound] as const));
    expect(
      checkSymmyRouteBindings({ bindings, holders, legalEntityId: company, principalId: integrationId }).refusals,
    ).toEqual([
      {
        code: 'integration_api_key_binding_missing',
        detail:
          'No active, unrevoked API-key binding of the staff namespace authenticates as the route principal, so the Shell resolves no x-api-key to it',
      },
    ]);
  });

  it('refuses executor workloads held by different system principals, as the worker is one identity', () => {
    const { bindings } = derive([symmy, catalog, priceGroups]);
    const integration = {
      apiKey: true,
      companyRegistration: 'binding' as const,
      kind: 'integration' as const,
      principalId: integrationId,
    };
    const systemOf = (workload: string) => (workload === productRead ? otherSystemId : systemId);
    const holders = new Map(
      symmyBindingWorkloads(bindings).map(
        (workload) =>
          [
            workload,
            [
              integration,
              {
                apiKey: false,
                companyRegistration: 'binding' as const,
                kind: 'system' as const,
                principalId: systemOf(workload),
              },
            ],
          ] as const,
      ),
    );
    const checked = checkSymmyRouteBindings({ bindings, holders, legalEntityId: company, principalId: integrationId });
    expect(checked.refusals.map(({ code }) => code)).toEqual(['executor_principals_differ']);
    expect(checked.refusals[0]?.detail).toContain(`${productRead} by ${otherSystemId}`);
    expect(checked.refusals[0]?.detail).toContain(`${SYMMY_JOB_KEY} by ${systemId}`);
  });

  it('refuses a route principal of another kind than integration', () => {
    const { bindings } = derive([symmy, catalog, priceGroups]);
    const holders = new Map(
      symmyBindingWorkloads(bindings).map(
        (workload) => [workload, [{ apiKey: true, kind: 'service' as const, principalId: integrationId }]] as const,
      ),
    );
    expect(
      checkSymmyRouteBindings({ bindings, holders, legalEntityId: company, principalId: integrationId }).refusals[0],
    ).toEqual({
      code: 'integration_principal_not_integration',
      detail: 'The route principal is a service principal',
    });
  });
  it('asks a registration only for the bindings whose calls run in the route company', () => {
    // The route context and the job poll run tenant-only and the admission in the company; the association read is
    // published `forbidden`, so the Shell signs it tenant-only; a live call's gateway check needs only the binding;
    // Catalog's calls are published without a company.
    expect(scoped(derive([symmy, catalog, priceGroups]))).toEqual([
      `integration ${admit} | ${poll}: false`,
      `integration ${admit}: true`,
      `integration ${poll}: false`,
      `integration ${groupRead}: false`,
      `integration ${productImport}: false`,
      `integration ${nestedWrite}: false`,
      `integration ${productRead}: false`,
      `executor ${productImport}: false`,
      `executor ${nestedWrite}: false`,
      `executor ${productRead}: false`,
      `executor ${nestedRecovery}: false`,
      `executor ${SYMMY_JOB_KEY}: false`,
    ]);
    // Pricing's define and its recovery read are published for a company, so the executor needs both registered; the
    // job worker itself runs tenant-only. A Tenant-only route asks no registration at all.
    const pricing = contract('pricing', 'commerce.pricing', {
      actions: receivingAction('commerce.pricing.define-price'),
      operationContracts: receivingRead('commerce.pricing.api.price-source-result-lookup'),
    });
    const prices = (companyScoped: boolean) =>
      deriveSymmyRouteBindings({
        companyScoped,
        contracts: [symmy, pricing],
        enrolled: enrolledOf('productsBatch', ['commerce.pricing.define-price']),
        inventory: products(),
      });
    expect(scoped(prices(true)).filter((binding) => binding.startsWith('executor'))).toEqual([
      'executor commerce.pricing.source-write: true',
      'executor commerce.pricing.source-read: true',
      `executor ${SYMMY_JOB_KEY}: false`,
    ]);
    expect(prices(false).bindings.some(({ companyScoped }) => companyScoped)).toBe(false);
  });

  it('asks a registration of an owner read exactly when its published scope lets it run in the company', () => {
    // The Catalog product page is published `forbidden`: the Shell reads it tenant-only on a company route too, so an
    // integration principal registered for no company is accepted.
    const productPage = 'commerce.catalog.api.catalog-source-product-page';
    const productPages = readRoute('adminProducts', [
      symmy,
      contract('catalog', 'commerce.catalog', { operationContracts: [carrier(productPage, [productRead])] }),
    ]);
    expect(productPages.refusals).toEqual([]);
    expect(scoped(productPages)).toEqual([
      `integration ${admit} | ${poll}: false`,
      `integration ${productRead}: false`,
    ]);
    expect(integrationRefusals(productPages.bindings, 'none')).toEqual([]);

    // The market read is published `required`, the currency read `forbidden`: the same unregistered principal is refused
    // for the market read alone, by name.
    const marketRead = 'commerce.market-catalog.source-read';
    const currencyRead = 'commerce.pricing.currency-read';
    const regions = readRoute('adminRegions', [
      symmy,
      contract('commerce-market-catalog', 'commerce.market-catalog', {
        operationContracts: [carrier('commerce.market-catalog.api.current-market-catalog', [marketRead])],
      }),
      contract('pricing', 'commerce.pricing', {
        operationContracts: [carrier('commerce.pricing.api.current-supported-currencies', [currencyRead])],
      }),
    ]);
    expect(regions.refusals).toEqual([]);
    expect(scoped(regions)).toEqual([
      `integration ${admit} | ${poll}: false`,
      `integration ${marketRead}: true`,
      `integration ${currencyRead}: false`,
    ]);
    expect(integrationRefusals(regions.bindings, 'none')).toEqual([
      {
        code: 'integration_company_registration_missing',
        detail: `The integration principal ${integrationId} holds ${marketRead}, needed for commerce.market-catalog.api.current-market-catalog@1, but none of its active bindings is registered for company ${company}, so the company gate refuses it there (deny.workload_unbound)`,
      },
    ]);
  });

  describe('company registrations', () => {
    const priceWrite = 'commerce.pricing.source-write';
    const routeBindings: readonly SymmyRequiredBinding[] = [
      { companyScoped: false, identity: 'integration', purpose: 'route context', workloads: [admit, poll] },
      { companyScoped: true, identity: 'integration', purpose: 'job admission', workloads: [admit] },
      { companyScoped: false, identity: 'integration', purpose: 'job read', workloads: [poll] },
      {
        companyScoped: true,
        identity: 'executor',
        purpose: 'commerce.pricing.define-price@2',
        workloads: [priceWrite],
      },
      { companyScoped: false, identity: 'executor', purpose: 'Symmy job execution', workloads: [SYMMY_JOB_KEY] },
    ];
    type Registration = NonNullable<WorkloadBindingHolder['companyRegistration']>;
    /** A holder as Core reports it: read with the company, where it is registered; read without one, nothing of it. */
    const integrationAs = (companyRegistration?: Registration): WorkloadBindingHolder =>
      companyRegistration === undefined
        ? { apiKey: true, kind: 'integration', principalId: integrationId }
        : { apiKey: true, companyRegistration, kind: 'integration', principalId: integrationId };
    const systemAs = (companyRegistration?: Registration, principalId = systemId): WorkloadBindingHolder =>
      companyRegistration === undefined
        ? { apiKey: false, kind: 'system', principalId }
        : { apiKey: false, companyRegistration, kind: 'system', principalId };
    /** Every holder of the route's workloads; the tenant-only ones are read without the company. */
    const holdersOf = (
      admission: WorkloadBindingHolder,
      executor: readonly WorkloadBindingHolder[],
    ): ReadonlyMap<string, readonly WorkloadBindingHolder[]> =>
      new Map([
        [admit, [admission]],
        [poll, [integrationAs()]],
        [priceWrite, executor],
        [SYMMY_JOB_KEY, [systemAs()]],
      ]);
    /** The refusals of the route enrolled for the company. */
    const check = (holders: ReadonlyMap<string, readonly WorkloadBindingHolder[]>) =>
      checkSymmyRouteBindings({ bindings: routeBindings, holders, legalEntityId: company, principalId: integrationId })
        .refusals;

    it('accepts the registrations the company gate admits each identity by, and asks none of a tenant-only call', () => {
      expect(check(holdersOf(integrationAs('binding'), [systemAs('binding')]))).toEqual([]);
      // The integration principal calls directly, so a registration of another of its bindings admits it too.
      expect(check(holdersOf(integrationAs('other_binding'), [systemAs('binding')]))).toEqual([]);
      // A Tenant-only route reads no company and needs no registration.
      expect(
        checkSymmyRouteBindings({
          bindings: routeBindings,
          holders: holdersOf(integrationAs(), [systemAs()]),
          principalId: integrationId,
        }).refusals,
      ).toEqual([]);
    });

    it('refuses a missing registration of either identity, naming the principal, the workload and the company', () => {
      expect(check(holdersOf(integrationAs('none'), [systemAs('none')]))).toEqual([
        {
          code: 'integration_company_registration_missing',
          detail: `The integration principal ${integrationId} holds ${admit}, needed for job admission, but none of its active bindings is registered for company ${company}, so the company gate refuses it there (deny.workload_unbound)`,
        },
        {
          code: 'executor_company_registration_missing',
          detail: `The system principal ${systemId} holds ${priceWrite}, needed for commerce.pricing.define-price@2, but that binding is not registered for company ${company}, so the company gate refuses it there (deny.workload_unbound)`,
        },
      ]);
      // The worker calls as a verified gateway workload, which only the binding it names admits in the company.
      expect(check(holdersOf(integrationAs('binding'), [systemAs('other_binding')])).map(({ code }) => code)).toEqual([
        'executor_company_registration_missing',
      ]);
    });

    it('keeps an ambiguous executor ambiguous, whichever of its holders is registered', () => {
      for (const [first, second] of [
        ['binding', 'none'],
        ['none', 'binding'],
        ['none', 'none'],
      ] as const) {
        const refusals = check(holdersOf(integrationAs('binding'), [systemAs(first), systemAs(second, otherSystemId)]));
        expect(refusals.map(({ code }) => code)).toEqual(['executor_binding_not_unique']);
        expect(refusals[0]?.detail).toBe(
          `2 active system principals hold ${priceWrite}: ${systemId}, ${otherSystemId}`,
        );
      }
    });
  });
});
