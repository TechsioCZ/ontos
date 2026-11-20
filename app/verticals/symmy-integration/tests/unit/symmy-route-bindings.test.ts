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
/** The receiving side of every worker call Symmy registers for one entrypoint, exactly as Symmy registers it. */
const received = (entrypointKey: string) =>
  symmyIntegrationRegisteredWorkloadCalls.filter((call) => call.entrypointKey === entrypointKey && 'workerKey' in call);
const receivingAction = (entrypointKey: string) =>
  received(entrypointKey).map((call) => ({
    accessDeclaration: { key: call.declarationKey },
    accessWorkload: { workloads: [call.workloadKey] },
    entrypoint: { entrypointKey },
    legalEntityScope: call.legalEntityScope,
    schemaVersion: call.schemaVersion,
  }));
const receivingRead = (entrypointKey: string) =>
  received(entrypointKey)
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
  if (!Option.isOption(found) || Option.isNone(found)) {
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
const workloadsOf = (bindings: readonly SymmyRequiredBinding[], identity: SymmyRequiredBinding['identity']) =>
  bindings.filter((binding) => binding.identity === identity).map(({ workloads }) => workloads.join(' | '));

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
      { apiKey: true, kind: 'integration' as const, principalId: integrationId },
      { apiKey: false, kind: 'system' as const, principalId: systemId },
    ];
    const holders = new Map(symmyBindingWorkloads(bindings).map((workload) => [workload, both] as const));
    const satisfied = checkSymmyRouteBindings({ bindings, holders, principalId: integrationId });
    expect(satisfied.refusals).toEqual([]);
    expect(satisfied.executors.get(SYMMY_JOB_KEY)).toBe(systemId);
    expect(satisfied.executors.get(nestedRecovery)).toBe(systemId);

    const missing = new Map<string, readonly WorkloadBindingHolder[]>([...holders, [productImport, []]]);
    expect(checkSymmyRouteBindings({ bindings, holders: missing, principalId: integrationId }).refusals).toEqual([
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
      [productRead, [...both, { apiKey: false, kind: 'system', principalId: otherSystemId }]],
    ]);
    expect(
      checkSymmyRouteBindings({ bindings, holders: shared, principalId: integrationId }).refusals.map(
        ({ code }) => code,
      ),
    ).toEqual(['executor_binding_not_unique']);

    // The route context admits either Symmy workload; the admission needs its own.
    const pollOnly = new Map<string, readonly WorkloadBindingHolder[]>([
      ...holders,
      [admit, [{ apiKey: false, kind: 'system', principalId: systemId }]],
    ]);
    expect(
      checkSymmyRouteBindings({ bindings, holders: pollOnly, principalId: integrationId }).refusals.map(
        ({ detail }) => detail,
      ),
    ).toEqual([`The integration principal holds none of ${admit}, needed for job admission`]);
  });

  it('refuses a route principal without an active API-key binding, whatever workload bindings it holds', () => {
    const { bindings } = derive([symmy, catalog, priceGroups]);
    const unbound = [
      { apiKey: false, kind: 'integration' as const, principalId: integrationId },
      { apiKey: false, kind: 'system' as const, principalId: systemId },
    ];
    const holders = new Map(symmyBindingWorkloads(bindings).map((workload) => [workload, unbound] as const));
    expect(checkSymmyRouteBindings({ bindings, holders, principalId: integrationId }).refusals).toEqual([
      {
        code: 'integration_api_key_binding_missing',
        detail:
          'No active, unrevoked API-key binding of the staff namespace authenticates as the route principal, so the Shell resolves no x-api-key to it',
      },
    ]);
  });

  it('refuses executor workloads held by different system principals, as the worker is one identity', () => {
    const { bindings } = derive([symmy, catalog, priceGroups]);
    const integration = { apiKey: true, kind: 'integration' as const, principalId: integrationId };
    const systemOf = (workload: string) => (workload === productRead ? otherSystemId : systemId);
    const holders = new Map(
      symmyBindingWorkloads(bindings).map(
        (workload) =>
          [
            workload,
            [integration, { apiKey: false, kind: 'system' as const, principalId: systemOf(workload) }],
          ] as const,
      ),
    );
    const checked = checkSymmyRouteBindings({ bindings, holders, principalId: integrationId });
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
    expect(checkSymmyRouteBindings({ bindings, holders, principalId: integrationId }).refusals[0]).toEqual({
      code: 'integration_principal_not_integration',
      detail: 'The route principal is a service principal',
    });
  });
});
