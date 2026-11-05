import { randomUUID } from 'node:crypto';

import { NodeCrypto } from '@effect/platform-node';
import { OperationContextDenied, ReadHandlerNotFound, ReadPermissionDenied } from '@app/core-runtime';
import type {
  OperationalScope,
  ReadRuntimeService,
  ScopedTransactionExecutor,
  TrustedPrincipalContext,
} from '@app/core-runtime';
import {
  NativeReadTestError,
  NativeReadTestOwnerRegistration,
  makeNativeReadTestContext,
} from '@app/core-runtime/testing/native-reads';
import { makeTestBoundAccessGate } from '@app/core-runtime/testing/access-gate';
import type { TestGateAnswer } from '@app/core-runtime/access/enforcement';
import { Crypto, Effect, Match, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { catalogMediaCurrentRead } from '../../src/api/catalog-media-current.read.ts';
import { pricingPurposeEquivalenceRead } from '../../src/api/pricing-purpose-equivalence.read.ts';
import { quantityBasisCompatibilityRead } from '../../src/api/quantity-basis-compatibility.read.ts';
import { quantityPreparationRead } from '../../src/api/quantity-preparation.read.ts';
import { catalogPersistenceForScope } from '../../src/persistence/catalog-persistence.ts';
import { VariantRefSchema } from '../../shared/resources/variant.ts';
import { catalogRegistration } from '../../vertical.registration.ts';

type NativeReadTestContext = Effect.Success<ReturnType<typeof makeNativeReadTestContext>>;
type NativeReadInputs = ReturnType<typeof nativeInputs>;

/**
 * The one access gate a native Catalog Read suite controls (C1: allow → revoke → deny → restore). It
 * scripts Core's own test double with a mutable answer map keyed by the Read's `accessDeclaration.key`,
 * so a v2 revoke is a real flip of the gate the runtime asks — never a SpiceDB tuple v2 no longer reads.
 * The map starts empty, so the default is a denial and a suite must name every capability it grants.
 */
const mutableCatalogReadGate = () => {
  const answers: Record<string, TestGateAnswer> = {};
  return {
    bound: makeTestBoundAccessGate({ answers }).bound,
    grant: (capabilityKey: string) => {
      answers[capabilityKey] = { outcome: 'ALLOWED' };
    },
    revoke: (capabilityKey: string) => {
      answers[capabilityKey] = { outcome: 'DENIED' };
    },
  };
};

/**
 * The four real Catalog read declarations this suite exercises, by their own `accessDeclaration.key`
 * (the one thing a v2 gate decides on, CUTOVER-PLAN §3.1). The retired SpiceDB resource tuples and
 * context permissions no longer appear here: v2 answers a protected read at the one access gate.
 */
const readCapabilityKeys = [
  'commerce.catalog.catalog-media-current.read',
  'commerce.catalog.quantity-preparation.read',
  'commerce.catalog.quantity-basis-compatibility.read',
  'commerce.catalog.pricing-purpose-equivalence.read',
] as const;

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
  (runtime: ReadRuntimeService, principal: TrustedPrincipalContext, inputs: NativeReadInputs) =>
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
  (runtime: ReadRuntimeService, principal: TrustedPrincipalContext, inputs: NativeReadInputs) =>
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
  (runtime: ReadRuntimeService, principal: TrustedPrincipalContext, inputs: NativeReadInputs) =>
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
  (runtime: ReadRuntimeService, principal: TrustedPrincipalContext, inputs: NativeReadInputs) =>
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

/** Every read in turn, each asserting the owner result its real handler produces for these inputs. */
const runAllReads = (fixture: NativeReadTestContext, principal: TrustedPrincipalContext, subject: NativeReadInputs) =>
  Effect.forEach(nativeReadCases, (run) => run(fixture.runtime, principal, subject), {
    concurrency: 1,
    discard: true,
  });

/** Every read in turn, collected as the typed failure it refused with (never an implicit allow). */
const collectReadFailures = (
  fixture: NativeReadTestContext,
  principal: TrustedPrincipalContext,
  subject: NativeReadInputs,
) =>
  Effect.forEach(nativeReadCases, (run) => run(fixture.runtime, principal, subject).pipe(Effect.flip), {
    concurrency: 1,
  });

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

const assertCatalogReadMatrix = Effect.fn('CatalogReadPermission.assertMatrix')(function* assertCatalogReadMatrix(
  fixture: NativeReadTestContext,
  accessGate: ReturnType<typeof mutableCatalogReadGate>,
) {
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

  // 1. No capability is granted yet: every read refuses and writes its denial evidence.
  const beforeDenied = yield* fixture.evidenceCount();
  for (const failure of yield* collectReadFailures(fixture, fixture.principal, inputs)) {
    expect(Schema.is(ReadPermissionDenied)(failure)).toBe(true);
  }
  expect(yield* fixture.evidenceCount()).toBe(beforeDenied + 4);

  // 2. Grant every capability: the gate admits the same-Tenant record for all four reads.
  for (const key of readCapabilityKeys) {
    accessGate.grant(key);
  }
  const beforeAllowed = yield* fixture.evidenceCount();
  yield* runAllReads(fixture, fixture.principal, inputs);
  expect(yield* fixture.evidenceCount()).toBe(beforeAllowed + 4);

  // 3. The retired SpiceDB resource tuples decide nothing (C1 legacy-grant equivalent): the old
  //    suite flipped the grant on the Product ref, but v2's scope-wide capability is unaffected by
  //    that tuple, so both a grant and a revoke leave every read admitted.
  yield* fixture.grantResource(created.product.productRef);
  yield* runAllReads(fixture, fixture.principal, inputs);
  yield* fixture.revokeResource(created.product.productRef);
  yield* runAllReads(fixture, fixture.principal, inputs);

  // 4. Revoke mid-run: every read refuses again, and restoring the capability re-admits it.
  for (const key of readCapabilityKeys) {
    accessGate.revoke(key);
  }
  for (const failure of yield* collectReadFailures(fixture, fixture.principal, inputs)) {
    expect(Schema.is(ReadPermissionDenied)(failure)).toBe(true);
  }
  for (const key of readCapabilityKeys) {
    accessGate.grant(key);
  }
  yield* runAllReads(fixture, fixture.principal, inputs);

  // 5. A sibling record in the same Tenant and Legal Entity is admitted by the same scope-wide
  //    capability: these declarations carry no per-record selectors, so the owner — not a
  //    per-resource tuple — bounds which records exist (CUTOVER-PLAN §3.1).
  yield* runAllReads(fixture, fixture.principal, siblingInputs);

  // 6. A foreign principal, Legal Entity or Tenant never resolves a trusted scope.
  for (const principal of [
    { ...fixture.principal, principalId: randomUUID() },
    { ...fixture.principal, legalEntityId: randomUUID() },
    { ...fixture.principal, tenantId: randomUUID() },
  ]) {
    for (const failure of yield* collectReadFailures(fixture, principal, inputs)) {
      expect(Schema.is(OperationContextDenied)(failure)).toBe(true);
    }
  }

  // 7. A foreign-Tenant record reference is never found by the owner, so it is not read.
  const foreignInputs = nativeInputs({ ...created.product.productRef, tenantId: randomUUID() }, created.variantId, at);
  for (const failure of yield* collectReadFailures(fixture, fixture.principal, foreignInputs)) {
    expect(Schema.is(ReadHandlerNotFound)(failure)).toBe(true);
  }

  // A Variant target resolves through the same declaration as its Product (no per-record grant).
  const variant = Schema.decodeSync(VariantRefSchema)({
    ...created.product.productRef,
    resourceId: created.variantId,
    resourceType: 'commerce.catalog.variant',
  });
  const media = yield* fixture.runtime.runRead({
    input: { target: variant },
    principal: fixture.principal,
    registration: catalogMediaCurrentRead,
    transport: { correlationId: 'catalog-native-variant' },
  });
  expect(media.target).toEqual(variant);
});

it.live(
  'decides all four Catalog governed reads at the one access gate, allowing only a granted scope-wide capability',
  () =>
    Effect.scoped(
      Effect.gen(function* catalogReadPermissionRuntime() {
        // The one access gate this suite controls (C1: allow → revoke → deny → restore). It answers
        // only what the suite states, so the default is a denial and a mid-run revoke is a real flip.
        const accessGate = mutableCatalogReadGate();
        const fixture = yield* makeNativeReadTestContext({
          accessDecision: accessGate.bound,
          // v2 consults no context permission for a protected read; the harness still seeds the
          // legacy SpiceDB graph, so it stays empty rather than inventing grants v2 would ignore.
          contextPermissions: [],
          moduleId: 'commerce.catalog',
          // Catalog forbids deleting Product/Variant identity and append-only history even as admin.
          ownerFixtureRetention: 'retain-complete-context',
        }).pipe(Effect.provideService(NativeReadTestOwnerRegistration, catalogRegistration));
        yield* assertCatalogReadMatrix(fixture, accessGate).pipe(Effect.provide(fixture.layer));
      }),
    ).pipe(Effect.provide(NodeCrypto.layer)),
);
