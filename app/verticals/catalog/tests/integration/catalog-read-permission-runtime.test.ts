import { randomUUID } from 'node:crypto';

import { NodeCrypto } from '@effect/platform-node';
import {
  OperationContextDenied,
  ReadHandlerNotFound,
  ReadPermissionDenied,
  makeContextAccessLive,
  toContextPermissionAccessKey,
} from '@app/core-runtime';
import type {
  OperationalScope,
  ReadRuntimeService,
  ScopedTransactionExecutor,
  TrustedPrincipalContext,
} from '@app/core-runtime';
import { NativeReadTestError, makeNativeReadTestContext } from '@app/core-runtime/testing/native-reads';
import { Crypto, Effect, Match, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { catalogPublicOperationContracts } from '../../shared/api.ts';
import { catalogMediaCurrentRead } from '../../src/api/catalog-media-current.read.ts';
import { quantityPreparationRead } from '../../src/api/quantity-preparation.read.ts';
import { quantityBasisCompatibilityRead } from '../../src/api/quantity-basis-compatibility.read.ts';
import { pricingPurposeEquivalenceRead } from '../../src/api/pricing-purpose-equivalence.read.ts';
import { catalogPersistenceForScope } from '../../src/persistence/catalog-persistence.ts';
import { VariantRefSchema } from '../../shared/resources/variant.ts';

const tenantId = randomUUID();
const foreignTenantId = randomUUID();
const principalId = randomUUID();
const readTargets = Object.values(catalogPublicOperationContracts)
  .filter((contract) => contract.permissionKind === 'context_permission')
  .map((contract) => ({ moduleId: 'commerce.catalog', permission: contract.permission }));

it.live('never allows Catalog governed reads without a verified grant', () =>
  Effect.scoped(
    Effect.gen(function* checkCatalogReadPermissions() {
      expect(readTargets.length).toBeGreaterThan(0);
      const access = yield* makeContextAccessLive();
      const check = access.contextPermissions;
      if (check === undefined) {
        throw new Error('The Core context-permission adapter is unavailable');
      }

      const local = yield* check({ principalId, targets: readTargets, tenantId });
      expect(local.map(({ key }) => key)).toEqual(readTargets.map(toContextPermissionAccessKey));
      expect(local.every(({ decision }) => decision === 'denied' || decision === 'unavailable')).toBe(true);

      const foreign = yield* check({ principalId, targets: readTargets, tenantId: foreignTenantId });
      expect(foreign.map(({ key }) => key)).toEqual(readTargets.map(toContextPermissionAccessKey));
      expect(foreign.every(({ decision }) => decision === 'denied' || decision === 'unavailable')).toBe(true);
    }),
  ),
);

// This is an untrusted, syntactically valid old handoff, deliberately contradicted by native
// DRAFT/WIP owner state. It must never become READY or CONFIRMED merely because auth passes.
const nativeInputs = (
  productRef: {
    readonly moduleId: 'commerce.catalog';
    readonly resourceId: string;
    readonly resourceType: 'commerce.catalog.product';
    readonly tenantId: string;
  },
  variantId: string,
  effectiveAt: string,
) => {
  const variantRef = { ...productRef, resourceId: variantId, resourceType: 'commerce.catalog.variant' };
  const unitRef = { ...productRef, resourceId: randomUUID(), resourceType: 'commerce.catalog.product-unit' };
  const selection = { productRef, variantRef };
  const quantityBasis = { targetDivisibilityRevision: 1, targetRef: variantRef, unitRef, unitRuleRevision: 1 };
  const handoff = {
    completeness: {
      observedAt: effectiveAt,
      ownerRevision: 'commerce.catalog.quantity:old-input',
      scope: { kind: 'EXACT_PREDICATE', predicateRef: 'commerce.catalog.quantity:old-input' },
    },
    divisible: false,
    equivalentSelectionKey: 'commerce.catalog.selection:old-input',
    evidence: {
      assessedAt: effectiveAt,
      basis: [
        { role: 'PRODUCT', source: { resourceRef: productRef, revision: 1 } },
        { role: 'VARIANT', source: { resourceRef: variantRef, revision: 1 } },
        {
          provenance: 'CATALOG_OWNER_CONFIRMED_UNTYPED_DECISION',
          role: 'PRODUCT_TYPE_UNTYPED_DECISION',
          source: { resourceRef: productRef, revision: 1 },
        },
      ],
      membership: {
        attestationId: 'old-untrusted-input',
        observedAt: effectiveAt,
        productRef,
        source: 'CATALOG_OWNER_CURRENT_READ',
        variant: { resourceRef: variantRef, revision: 1 },
      },
      purpose: 'PRICING',
      selection,
      status: 'VALID',
    },
    hierarchyRevision: 'commerce.catalog.hierarchy:old-input',
    ownerRevision: 'commerce.catalog.quantity:old-input',
    quantity: {
      changed: false,
      notice: null,
      requested: '2',
      resulting: '2',
      rounding: 'UP',
      status: 'VALID',
      step: '1',
      targetId: variantId,
      tenantId: productRef.tenantId,
      unitId: unitRef.resourceId,
      unitRuleRevision: 1,
    },
    quantityBasis,
    selection,
    status: 'READY',
    unitRef,
  };
  return {
    compatibility: { effectiveAt, handoff, price: { quantity: '1', quantityBasis } },
    equivalence: { anchorSelection: selection, effectiveAt, members: [{ handoff, occurrenceId: 'single-member' }] },
    media: { target: productRef },
    preparation: { amount: '2', purpose: 'PRICING', selection },
  };
};

const nativeReadCases = [
  (runtime: ReadRuntimeService, principal: TrustedPrincipalContext, inputs: ReturnType<typeof nativeInputs>) =>
    runtime
      .runRead({
        input: inputs.preparation,
        principal,
        registration: quantityPreparationRead,
        transport: { correlationId: 'catalog-native-targets' },
      })
      .pipe(
        Effect.tap((result) => Effect.sync(() => expect(result.status).toBe('INVALID'))),
        Effect.asVoid,
      ),
  (runtime: ReadRuntimeService, principal: TrustedPrincipalContext, inputs: ReturnType<typeof nativeInputs>) =>
    runtime
      .runRead({
        input: inputs.compatibility,
        principal,
        registration: quantityBasisCompatibilityRead,
        transport: { correlationId: 'catalog-native-targets' },
      })
      .pipe(
        Effect.tap((result) => Effect.sync(() => expect(result.outcome).toBe('INVALID'))),
        Effect.asVoid,
      ),
  (runtime: ReadRuntimeService, principal: TrustedPrincipalContext, inputs: ReturnType<typeof nativeInputs>) =>
    runtime
      .runRead({
        input: inputs.equivalence,
        principal,
        registration: pricingPurposeEquivalenceRead,
        transport: { correlationId: 'catalog-native-targets' },
      })
      .pipe(
        Effect.tap((result) => Effect.sync(() => expect(result.outcome).not.toBe('CATALOG_EQUIVALENCE_CONFIRMED'))),
        Effect.asVoid,
      ),
  (runtime: ReadRuntimeService, principal: TrustedPrincipalContext, inputs: ReturnType<typeof nativeInputs>) =>
    runtime
      .runRead({
        input: inputs.media,
        principal,
        registration: catalogMediaCurrentRead,
        transport: { correlationId: 'catalog-native-targets' },
      })
      .pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(result.target).toEqual(inputs.media.target);
            expect(result.ordered).toEqual([]);
          }),
        ),
        Effect.asVoid,
      ),
];

const produceNativeCatalogProduct = Effect.fn('NativeCatalogReadFixture.product')(function* produceNativeCatalogProduct(
  transaction: ScopedTransactionExecutor,
  scope: OperationalScope,
) {
  const crypto = yield* Crypto.Crypto;
  const service = yield* catalogPersistenceForScope(transaction, scope);
  const result = yield* service.create({
    actionInvocationId: yield* crypto.randomUUIDv4(),
    description: 'Created through native Catalog persistence',
    name: 'Native read target fixture',
    principalId: scope.principalId,
    reason: 'Isolated native read target proof',
    tenantId: scope.tenantId,
    variantId: yield* crypto.randomUUIDv4(),
  });
  return yield* Match.value(result).pipe(
    Match.tag('conflict', () =>
      Effect.fail(
        new NativeReadTestError({
          code: 'native_read_test_failed',
          reason: 'Native owner fixture identity conflicted',
        }),
      ),
    ),
    Match.tag('created', (created) => Effect.succeed(created)),
    Match.exhaustive,
  );
});

it.live(
  'runs all four original Catalog registrations through native Core, PostgreSQL and exact SpiceDB resource grants',
  () =>
    Effect.scoped(
      Effect.gen(function* nativeCatalogRegistrations() {
        const fixture = yield* makeNativeReadTestContext({
          contextPermissions: [
            'commerce.catalog.read.quantity-preparation',
            'commerce.catalog.read.quantity-basis-compatibility',
            'commerce.catalog.read.pricing-purpose-equivalence',
            'commerce.catalog.read.media',
          ],
          moduleId: 'commerce.catalog',
          // Catalog forbids deleting Product/Variant identity and append-only history even as
          // admin. Retain its complete random Core context; only exact SpiceDB grants are removed.
          ownerFixtureRetention: 'retain-complete-context',
        });
        yield* Effect.gen(function* nativeFixtureScope() {
          const create = () => fixture.prepareOwner(produceNativeCatalogProduct);
          const created = yield* create();
          const sibling = yield* create();
          yield* Effect.logInfo('Retained isolated native Catalog fixture').pipe(
            Effect.annotateLogs({
              authBindingId: fixture.principal.authBindingId,
              legalEntityId: fixture.principal.legalEntityId,
              principalId: fixture.principal.principalId,
              productIds: [created.product.productRef.resourceId, sibling.product.productRef.resourceId],
              tenantId: fixture.principal.tenantId,
              variantIds: [created.variantId, sibling.variantId],
            }),
          );
          const at = '2026-09-27T12:00:00.000Z';
          const inputs = nativeInputs(created.product.productRef, created.variantId, at);
          const siblingInputs = nativeInputs(sibling.product.productRef, sibling.variantId, at);
          yield* Effect.gen(function* nativeRegisteredAssertions() {
            for (const run of nativeReadCases) {
              const failure = yield* run(fixture.runtime, fixture.principal, inputs).pipe(Effect.flip);
              expect(Schema.is(ReadPermissionDenied)(failure)).toBe(true);
            }
            const beforeAllowed = yield* fixture.evidenceCount();
            yield* fixture.grantResource(created.product.productRef);
            for (const run of nativeReadCases) {
              yield* run(fixture.runtime, fixture.principal, inputs);
            }
            expect(yield* fixture.evidenceCount()).toBe(beforeAllowed + 4);
            for (const run of nativeReadCases) {
              const failure = yield* run(fixture.runtime, fixture.principal, siblingInputs).pipe(Effect.flip);
              expect(Schema.is(ReadPermissionDenied)(failure)).toBe(true);
            }
            const variant = Schema.decodeSync(VariantRefSchema)({
              ...created.product.productRef,
              resourceId: created.variantId,
              resourceType: 'commerce.catalog.variant',
            });
            yield* fixture.grantResource(variant);
            const media = yield* fixture.runtime.runRead({
              input: { target: variant },
              principal: fixture.principal,
              registration: catalogMediaCurrentRead,
              transport: { correlationId: 'catalog-native-variant' },
            });
            expect(media.target).toEqual(variant);
            yield* fixture.revokeResource(created.product.productRef);
            for (const run of nativeReadCases) {
              const failure = yield* run(fixture.runtime, fixture.principal, inputs).pipe(Effect.flip);
              expect(Schema.is(ReadPermissionDenied)(failure)).toBe(true);
            }
            const wrongLegalEntity = { ...fixture.principal, legalEntityId: randomUUID() };
            const foreignTenant = { ...fixture.principal, tenantId: randomUUID() };
            for (const run of nativeReadCases) {
              for (const principal of [wrongLegalEntity, foreignTenant]) {
                const failure = yield* run(fixture.runtime, principal, inputs).pipe(Effect.flip);
                expect(Schema.is(OperationContextDenied)(failure)).toBe(true);
              }
            }
            yield* fixture.grantResource(created.product.productRef);
            const foreignInputs = nativeInputs(
              { ...created.product.productRef, tenantId: randomUUID() },
              created.variantId,
              at,
            );
            for (const run of nativeReadCases) {
              const failure = yield* run(fixture.runtime, fixture.principal, foreignInputs).pipe(Effect.flip);
              expect(Schema.is(ReadHandlerNotFound)(failure)).toBe(true);
            }
          });
        }).pipe(Effect.provide(fixture.layer));
      }),
    ).pipe(Effect.provide(NodeCrypto.layer)),
);
