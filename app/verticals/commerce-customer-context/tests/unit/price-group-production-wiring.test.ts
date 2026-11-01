import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { Hex } from 'effect/encoding';
import {
  makeApplicationCompositionSnapshotFixture,
  makeModuleContractFixture,
} from '@app/core-runtime/testing/module-contract';
import { bindActionTestServices, makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { commerceCustomerContextRegistration } from '../../vertical.registration.ts';
import { CustomerPriceGroupCatalogUnavailable } from '../../shared/domain/price-group-errors.ts';
import {
  OperationContextUnavailable,
  ModuleOperationRequirementError,
  OntosModuleDeploymentContractSchema,
  OntosShellRuntimeContractSchema,
  applicationCompositionContentRevision,
  extractVerticalRuntimeSafeDescriptors,
  validateActiveApplicationCompositionSnapshot,
} from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import { Effect, Layer, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { getActionServiceFactory } from '../../../../packages/core-runtime/src/actions/definition.ts';
import { getReadServiceFactory } from '../../../../packages/core-runtime/src/reads/definition.ts';

import { PriceGroupCatalogGatewayCredentialService } from '../../shared/domain/price-group-catalog-gateway-credential.ts';
import { assignCounterpartyPriceGroupAction } from '../../src/actions/assign-counterparty-price-group.action.ts';
import { assignCustomerPriceGroupAction } from '../../src/actions/assign-customer-price-group.action.ts';
import { migrateCounterpartyPriceGroupAction } from '../../src/actions/migrate-counterparty-price-group.action.ts';
import { migrateCustomerPriceGroupAction } from '../../src/actions/migrate-customer-price-group.action.ts';
import {
  priceGroupActionServicesForTransaction,
  assignCustomerPriceGroupServicesForTransaction,
  assignCounterpartyPriceGroupServicesForTransaction,
  migrateCustomerPriceGroupServicesForTransaction,
  migrateCounterpartyPriceGroupServicesForTransaction,
} from '../../src/actions/price-group-action-services.ts';
import { removeCounterpartyPriceGroupAction } from '../../src/actions/remove-counterparty-price-group.action.ts';
import { removeCustomerPriceGroupAction } from '../../src/actions/remove-customer-price-group.action.ts';
import {
  customerPriceGroupResolutionRead,
  customerPriceGroupResolutionServicesForTransaction,
} from '../../src/api/customer-price-group-resolution.read.ts';
import type { PriceGroupRoutineInvoker } from '../../src/persistence/price-group-persistence.ts';

interface CapturedCompositionContext {
  readonly revision?: string;
}

const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '20000000-0000-4000-8000-000000000001';
const scopeFields = {
  authBindingId: '30000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:price-group-production-wiring',
  authMethod: 'session',
  correlationId: 'price-group-production-wiring',
  legalEntityId,
  principalId: '40000000-0000-4000-8000-000000000001',
  tenantId,
} as const;
// SAFETY: the fixed UUID and session fields satisfy the trusted test-context contract.
const scope = scopeFields as OperationalScope & { readonly legalEntityId: string };

const routineInvoker = {
  invoke: () => Effect.die('production-wiring tests must not invoke persistence'),
};
// SAFETY: Price Group persistence consumes only `invoke`; this fake supplies that exact test seam.
const priceGroupInvoker = routineInvoker as PriceGroupRoutineInvoker;
const scopeWithoutLegalEntity: OperationalScope = {
  authBindingId: scope.authBindingId,
  authContextRef: scope.authContextRef,
  authMethod: scope.authMethod,
  correlationId: scope.correlationId,
  principalId: scope.principalId,
  tenantId: scope.tenantId,
};

it('attaches every Price Group Action and the governed resolution Read to production catalog wiring', () => {
  expect(getActionServiceFactory(assignCustomerPriceGroupAction)).toBe(assignCustomerPriceGroupServicesForTransaction);
  expect(getActionServiceFactory(assignCounterpartyPriceGroupAction)).toBe(
    assignCounterpartyPriceGroupServicesForTransaction,
  );
  expect(getActionServiceFactory(migrateCustomerPriceGroupAction)).toBe(
    migrateCustomerPriceGroupServicesForTransaction,
  );
  expect(getActionServiceFactory(migrateCounterpartyPriceGroupAction)).toBe(
    migrateCounterpartyPriceGroupServicesForTransaction,
  );

  expect(getActionServiceFactory(removeCustomerPriceGroupAction).toString()).toContain(
    'priceGroupActionServicesForTransaction',
  );
  expect(getActionServiceFactory(removeCounterpartyPriceGroupAction).toString()).toContain(
    'priceGroupActionServicesForTransaction',
  );

  expect(getReadServiceFactory(customerPriceGroupResolutionRead)).toBe(
    customerPriceGroupResolutionServicesForTransaction,
  );
  const readFactorySource = customerPriceGroupResolutionServicesForTransaction.toString();
  expect(readFactorySource).toContain('priceGroupCatalogPortFromEnvironment');
  expect(readFactorySource).not.toContain('unavailablePriceGroupCatalogPort');
});

it.effect(
  'creates a fresh catalog adapter for every governed Action and Read attempt without eager credential issuance',
  () =>
    Effect.gen(function* freshPerAttempt() {
      let credentialIssues = 0;
      const credentialLayer = Layer.succeed(PriceGroupCatalogGatewayCredentialService, {
        issue: () =>
          Effect.sync(() => {
            credentialIssues += 1;
            return {
              baseUrl: new URL('https://shell.example.test/owner-api'),
              credential: Redacted.make(`Bearer production-wiring-${credentialIssues}`),
            };
          }),
      });

      const firstActionServices = yield* priceGroupActionServicesForTransaction(
        priceGroupInvoker,
        scope,
        'a'.repeat(64),
      ).pipe(Effect.provide(credentialLayer));
      const secondActionServices = yield* priceGroupActionServicesForTransaction(
        priceGroupInvoker,
        scope,
        'a'.repeat(64),
      ).pipe(Effect.provide(credentialLayer));
      const readServices = yield* customerPriceGroupResolutionServicesForTransaction(
        priceGroupInvoker,
        scope,
        'a'.repeat(64),
      ).pipe(Effect.provide(credentialLayer));

      expect(firstActionServices.catalog).not.toBe(secondActionServices.catalog);
      expect(readServices.catalog).not.toBe(firstActionServices.catalog);
      expect(credentialIssues).toBe(0);
    }),
);

it.effect('keeps both remove Actions catalog-free and rejects missing Legal Entity scope before wiring', () =>
  Effect.gen(function* removalBoundary() {
    let credentialIssues = 0;
    const credentialLayer = Layer.succeed(PriceGroupCatalogGatewayCredentialService, {
      issue: () =>
        Effect.sync(() => {
          credentialIssues += 1;
          return {
            baseUrl: new URL('https://shell.example.test/owner-api'),
            credential: Redacted.make('Bearer must-not-be-issued'),
          };
        }),
    });

    yield* priceGroupActionServicesForTransaction(priceGroupInvoker, scope, 'a'.repeat(64)).pipe(
      Effect.provide(credentialLayer),
    );
    expect(credentialIssues).toBe(0);

    const failure = yield* Effect.flip(
      priceGroupActionServicesForTransaction(priceGroupInvoker, scopeWithoutLegalEntity, 'a'.repeat(64)).pipe(
        Effect.provide(credentialLayer),
      ),
    );
    expect(Schema.is(OperationContextUnavailable)(failure)).toBe(true);
    expect(credentialIssues).toBe(0);
  }),
);

it.effect(
  'rejects a cross-owner Read without its captured verified composition revision before issuing credentials',
  () =>
    Effect.gen(function* missingCompositionRevision() {
      let credentialIssues = 0;
      const missingComposition: CapturedCompositionContext = {};
      const failure = yield* customerPriceGroupResolutionServicesForTransaction(
        priceGroupInvoker,
        scope,
        missingComposition.revision,
      ).pipe(
        Effect.provide(
          Layer.succeed(PriceGroupCatalogGatewayCredentialService, {
            issue: () =>
              Effect.sync(() => {
                credentialIssues += 1;
                return {
                  baseUrl: new URL('https://shell.example.test/owner-api'),
                  credential: Redacted.make('Bearer must-not-be-issued'),
                };
              }),
          }),
        ),
        Effect.flip,
      );
      expect(Schema.is(OperationContextUnavailable)(failure)).toBe(true);
      expect(credentialIssues).toBe(0);
    }),
);

// Controlled unit metadata is projected from the real owner. It does not claim a published release.
const makeMissingPriceGroupComposition = Effect.fn('Test.missingPriceGroupComposition')(function* missingProvider() {
  const base = yield* makeApplicationCompositionSnapshotFixture(['commerce-customer-context']);
  const owner = extractVerticalRuntimeSafeDescriptors(commerceCustomerContextRegistration);
  const fixture = makeModuleContractFixture({
    appId: 'commerce-customer-context',
    buildMarker: 'fixture-build',
    moduleId: owner.moduleId,
  });
  const document = yield* Schema.decodeUnknownEffect(OntosModuleDeploymentContractSchema)({
    ...fixture,
    manifest: {
      ...fixture.manifest,
      publicSurface: {
        ...fixture.manifest.publicSurface,
        actions: owner.actions,
        api: [...new Set(owner.operationContracts.map(({ apiKey }) => apiKey))].map((key) => ({
          key,
          operationKeys: owner.operationContracts
            .filter(({ apiKey }) => apiKey === key)
            .map(({ operationKey }) => operationKey),
        })),
        operationContracts: owner.operationContracts,
      },
      requirements: owner.requirements,
    },
  });
  const contractDocument = yield* Schema.encodeEffect(Schema.fromJsonString(OntosModuleDeploymentContractSchema))(
    document,
  );
  const digest = Hex.encode(sha256(utf8ToBytes(contractDocument)));
  const coreCapabilities = owner.requirements?.coreCapabilities ?? [];
  const shellDocument = yield* Schema.encodeEffect(Schema.fromJsonString(OntosShellRuntimeContractSchema))({
    contributionAbi: base.composition.shell.contributionAbi,
    coreCapabilities,
    deployment: base.composition.shell.deployment,
    schemaVersion: '2',
  });
  const candidate = {
    ...base.composition,
    modules: base.composition.modules.map((module) => ({
      ...module,
      contract: { ...module.contract, sha256: digest },
      contractDocument,
      moduleId: owner.moduleId,
      publicContract: { ...module.publicContract, id: owner.moduleId, sha256: digest },
      requiredCoreCapabilities: coreCapabilities,
    })),
    shell: {
      ...base.composition.shell,
      coreCapabilities,
      runtimeContract: {
        ...base.composition.shell.runtimeContract,
        sha256: Hex.encode(sha256(utf8ToBytes(shellDocument))),
      },
    },
  };
  const snapshot = yield* validateActiveApplicationCompositionSnapshot({
    ...base,
    composition: { ...candidate, revision: yield* applicationCompositionContentRevision(candidate) },
  });
  return { deployment: document.deployment, snapshot };
});

it.effect(
  'keeps the actual default Assign catalog gate inside genuine Action execution before acquisition or mutation',
  () =>
    Effect.gen(function* defaultFactoryRequiresOperationClaim() {
      let credentialIssues = 0;
      let writes = 0;
      const requirementFailures: ModuleOperationRequirementError[] = [];
      const { deployment, snapshot } = yield* makeMissingPriceGroupComposition();
      const from = '2027-01-01T00:00:00.000Z';
      const assembled = yield* assignCustomerPriceGroupServicesForTransaction(
        priceGroupInvoker,
        scope,
        snapshot.composition.revision,
      ).pipe(
        Effect.provide(
          Layer.succeed(PriceGroupCatalogGatewayCredentialService, {
            issue: () =>
              Effect.sync(() => {
                credentialIssues += 1;
                return {
                  baseUrl: new URL('https://catalog.example.test'),
                  credential: Redacted.make('Bearer transport-seam'),
                };
              }),
          }),
        ),
      );
      const services = {
        ...assembled,
        catalog: {
          resolveCurrent: (...args: Parameters<typeof assembled.catalog.resolveCurrent>) =>
            assembled.catalog.resolveCurrent(...args).pipe(
              Effect.tapError((failure) =>
                Effect.sync(() => {
                  if (Schema.is(Schema.Struct({ cause: ModuleOperationRequirementError }))(failure)) {
                    requirementFailures.push(failure.cause);
                  }
                }),
              ),
            ),
        },
        now: Effect.succeed(from),
        profileValidation: {
          inspect: () =>
            Effect.succeed({ _tag: 'CURRENT' as const, counterpartyRef: null, revision: 1, state: 'ACTIVE' as const }),
        },
        store: {
          ...assembled.store,
          assign: () => {
            writes += 1;
            return Effect.die('Missing operation evidence must prevent persistence');
          },
        },
      };
      const harness = yield* makeActionTestHarness({
        actionPermission: 'allowed',
        applicationComposition: { load: Effect.succeed(snapshot) },
        expectedDeployment: deployment,
        ownerRegistration: commerceCustomerContextRegistration,
        resourcePermission: 'allowed',
        services: [bindActionTestServices(assignCustomerPriceGroupAction, services)],
      });
      const failure = yield* harness.runtime
        .runAction({
          payload: {
            effectiveFrom: from,
            expectedProfileRevision: 1,
            priceGroupRef: {
              moduleId: 'pricing.price-group-catalog',
              resourceId: 'closure-group',
              resourceType: 'pricing.price-group-catalog.price-group',
              tenantId,
            },
            profile: {
              kind: 'RETAIL',
              moduleId: 'commerce.customer-context',
              resourceId: 'closure-profile',
              resourceType: 'commerce.customer-context.retail-customer-profile',
              tenantId,
            },
            reason: 'Require exact catalog operation before assignment',
          },
          principal: scope,
          registration: assignCustomerPriceGroupAction,
          transport: { correlationId: scope.correlationId, idempotencyKey: 'price-group-operation-closure-negative' },
        })
        .pipe(Effect.flip);
      expect(Schema.is(CustomerPriceGroupCatalogUnavailable)(failure)).toBe(true);
      expect(requirementFailures).toHaveLength(1);
      expect(requirementFailures.map(({ code, reason }) => ({ code, reason }))).toEqual([
        {
          code: 'module_operation_requirement_unsatisfied',
          reason: 'The required module operation is not supported by the admitted composition',
        },
      ]);
      expect(credentialIssues).toBe(0);
      expect(writes).toBe(0);
      expect(harness.snapshot().committed).toHaveLength(0);
      expect(harness.snapshot().permissionDenials).toHaveLength(0);
    }),
);
