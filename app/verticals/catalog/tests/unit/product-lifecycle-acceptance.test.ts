import type { ActionHandlerContext, DomainEventContractMap } from '@app/core-runtime';
import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { Effect, Match, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { catalogReadiness, productActivationBlockers, ProductSchema } from '../../shared/domain/product.ts';
import type { CatalogSelectionEvidenceReader } from '../../shared/domain/catalog-open-selection-population.ts';
import { CatalogSelectionEvidenceSchema } from '../../shared/domain/catalog-selection-evidence.ts';
import type { CatalogSelection } from '../../shared/domain/catalog-selection-evidence.ts';
import {
  ProductLifecycleConflict,
  ProductNotCatalogReady,
  ProductNotFound,
  ProductRevisionConflict,
} from '../../shared/domain/product-errors.ts';
import { handleReactivateProduct, reactivateProductAction } from '../../src/actions/reactivate-product.action.ts';
import { handleRetireProduct, retireProductAction } from '../../src/actions/retire-product.action.ts';
import { handleUpdateProduct, updateProductAction } from '../../src/actions/update-product.action.ts';
import {
  productLifecycleEvents,
  productRevisions,
  productVariants,
  productVariantRevisions,
  products,
} from '../../src/database/schema.ts';
import {
  catalogPersistenceForScope,
  catalogPersistenceWithCurrentSelectionEvidenceForScope,
} from '../../src/persistence/catalog-persistence.ts';
import { catalogSelectionCurrentBasisForScope } from '../../src/persistence/catalog-selection-current-basis.ts';
import type { CatalogPersistence } from '../../src/persistence/catalog-persistence.ts';

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, sonarjs/no-nested-functions -- The Drizzle transaction fake records heterogeneous Catalog writes and implements only the exercised query chains. expires: 2027-03-31. */

type ProductView = Schema.Schema.Type<typeof ProductSchema>;

const tenantId = '00000000-0000-4000-8000-000000000001';
const principalId = '00000000-0000-4000-8000-000000000002';
const productId = '00000000-0000-4000-8000-000000000003';
const variantId = '00000000-0000-4000-8000-000000000004';
const secondVariantId = '00000000-0000-4000-8000-000000000006';
const invocationId = '00000000-0000-4000-8000-000000000005';
const foreignTenantId = '00000000-0000-4000-8000-0000000000ff';
const now = new Date('2026-09-17T10:00:00.000Z');
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:product-lifecycle-acceptance:run:1',
    authMethod: 'system',
    principalId,
    tenantId,
  }),
  correlationId: 'product-lifecycle-acceptance',
};
const productRef = {
  moduleId: 'commerce.catalog',
  resourceId: productId,
  resourceType: 'commerce.catalog.product',
  tenantId,
} as const;
const variantRef = {
  moduleId: 'commerce.catalog',
  resourceId: variantId,
  resourceType: 'commerce.catalog.variant',
  tenantId,
} as const;

const currentValidEvidence = (selection: CatalogSelection) =>
  Schema.decodeUnknownSync(CatalogSelectionEvidenceSchema)({
    assessedAt: '2026-09-17T10:00:00.000Z',
    basis: [
      { role: 'PRODUCT', source: { resourceRef: selection.productRef, revision: 3 } },
      { role: 'VARIANT', source: { resourceRef: selection.variantRef, revision: 1 } },
      {
        provenance: 'CATALOG_OWNER_CONFIRMED_UNTYPED_DECISION',
        role: 'PRODUCT_TYPE_UNTYPED_DECISION',
        source: { resourceRef: selection.productRef, revision: 1 },
      },
    ],
    membership: {
      attestationId: 'product-lifecycle-current-membership',
      observedAt: '2026-09-17T10:00:00.000Z',
      productRef: selection.productRef,
      source: 'CATALOG_OWNER_CURRENT_READ',
      variant: { resourceRef: selection.variantRef, revision: 1 },
    },
    purpose: 'PURCHASE_ACCEPTANCE',
    selection,
    status: 'VALID',
  });

const currentValidEvidenceReader: CatalogSelectionEvidenceReader = {
  assess: ({ selection }) => Effect.succeed({ evidence: currentValidEvidence(selection) }),
};

const unavailableEvidenceReader: CatalogSelectionEvidenceReader = {
  assess: () =>
    Effect.succeed({ evidence: { kind: 'UNAVAILABLE', reason: 'Catalog Current basis is temporarily unavailable' } }),
};

const productAggregate = (
  lifecycle: ProductView['lifecycle'],
  variantLifecycles: readonly ProductView['variants'][number]['lifecycle'][],
  revision = 1,
): ProductView =>
  Schema.decodeUnknownSync(ProductSchema)({
    catalogReady: false,
    createdAt: '2026-09-17T10:00:00.000Z',
    lifecycle,
    name: 'Kladivo',
    productRef,
    revision,
    updatedAt: '2026-09-17T10:00:00.000Z',
    variants: variantLifecycles.map((variantLifecycle, index) => {
      const id = index === 0 ? variantId : secondVariantId;
      return {
        lifecycle: variantLifecycle,
        productRef,
        variantId: id,
        variantRef: {
          moduleId: 'commerce.catalog',
          resourceId: id,
          resourceType: 'commerce.catalog.variant',
          tenantId,
        },
      };
    }),
  });

interface FakeProduct {
  readonly createdAt: Date;
  readonly currentRevision: number;
  readonly description: string | null;
  readonly lifecycleState: string;
  readonly name: string | null;
  readonly productId: string;
  readonly retiredEffectiveAt: Date | null;
  readonly retiredReason: string | null;
  readonly tenantId: string;
  readonly updatedAt: Date;
}

interface FakeVariant {
  readonly createdAt: Date;
  readonly currentRevision: number;
  readonly lifecycleState: string;
  readonly productId: string;
  readonly tenantId: string;
  readonly updatedAt: Date;
  readonly variantId: string;
}

const draftProduct = (): FakeProduct => ({
  createdAt: now,
  currentRevision: 1,
  description: null,
  lifecycleState: 'DRAFT',
  name: null,
  productId,
  retiredEffectiveAt: null,
  retiredReason: null,
  tenantId,
  updatedAt: now,
});

const activeProduct = (currentRevision: number): FakeProduct => ({
  ...draftProduct(),
  currentRevision,
  lifecycleState: 'ACTIVE',
  name: 'Kladivo',
});

const retiredProduct = (currentRevision: number): FakeProduct => ({
  ...activeProduct(currentRevision),
  lifecycleState: 'RETIRED',
  retiredEffectiveAt: now,
  retiredReason: 'Discontinued',
});

const variant = (lifecycleState: string): FakeVariant => ({
  createdAt: now,
  currentRevision: 1,
  lifecycleState,
  productId,
  tenantId,
  updatedAt: now,
  variantId,
});

const selectable = <T>(rows: T) =>
  Object.assign(Effect.succeed(rows), {
    limit: () => Effect.succeed(rows),
    orderBy: () => Effect.succeed(rows),
  });

interface HarnessState {
  readonly lifecycleEvents: Record<string, unknown>[];
  product: Record<string, unknown>;
  readonly revisions: Record<string, unknown>[];
  readonly variantRevisions: Record<string, unknown>[];
  variants: Record<string, unknown>[];
}

const makeTransaction = (input: {
  readonly localizedNames?: readonly { readonly name: string | null; readonly state: string }[];
  readonly product: FakeProduct;
  readonly variants: readonly FakeVariant[];
}) => {
  const state: HarnessState = {
    lifecycleEvents: [],
    product: { ...input.product },
    revisions: [],
    variantRevisions: [],
    variants: input.variants.map((row) => ({ ...row })),
  };
  const transaction = {
    insert: (table: unknown) => ({
      values: (value: Record<string, unknown>) => {
        if (table === products) {
          state.product = { createdAt: now, currentRevision: 1, updatedAt: now, ...value };
        } else if (table === productVariants) {
          state.variants = [{ createdAt: now, currentRevision: 1, updatedAt: now, ...value }];
        } else if (table === productRevisions) {
          state.revisions.push(value);
        } else if (table === productVariantRevisions) {
          state.variantRevisions.push(value);
        } else if (table === productLifecycleEvents) {
          state.lifecycleEvents.push(value);
        }
        return Effect.succeed([]);
      },
    }),
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          if (table === products) {
            return selectable([state.product]);
          }
          if (table === productVariants) {
            return selectable([...state.variants]);
          }
          return Effect.succeed(input.localizedNames ?? []);
        },
      }),
    }),
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: () => ({
          returning: () => {
            if (table === products) {
              state.product = { ...state.product, ...patch };
            }
            return Effect.succeed([state.product]);
          },
        }),
      }),
    }),
  };
  return { state, transaction };
};

const persistenceFor = (
  input: Parameters<typeof makeTransaction>[0],
  selectionEvidence?: CatalogSelectionEvidenceReader,
) => {
  const harness = makeTransaction(input);
  if (selectionEvidence === undefined) {
    // @ts-expect-error Only the exercised Drizzle query chains are mocked.
    return catalogPersistenceForScope(harness.transaction, scope).pipe(
      Effect.map((services) => ({ persistence: services, state: harness.state })),
    );
  }
  // @ts-expect-error Only the exercised Drizzle query chains are mocked.
  return catalogPersistenceWithCurrentSelectionEvidenceForScope(harness.transaction, scope, selectionEvidence).pipe(
    Effect.map((services) => ({ persistence: services, state: harness.state })),
  );
};

const executableContextFor = (
  services: CatalogPersistence,
): ActionHandlerContext<typeof reactivateProductAction.descriptor.domainEvents, CatalogPersistence> => ({
  actionInvocationId: invocationId,
  addDomainEvent: () => Effect.succeed(Object.create(null)),
  addOutboxMessage: () => Effect.void,
  recordAuditEvidence: () => Effect.void,
  recordDataAccess: () => Effect.void,
  scope,
  services,
});

const contextFor = <Events extends DomainEventContractMap>(
  _domainEvents: Events,
  services: Partial<CatalogPersistence>,
): ActionHandlerContext<Events, CatalogPersistence> => ({
  actionInvocationId: invocationId,
  addDomainEvent: () => Effect.die('Unused'),
  addOutboxMessage: () => Effect.die('Unused'),
  recordAuditEvidence: () => Effect.void,
  recordDataAccess: () => Effect.void,
  scope,
  services: {
    correct: () => Effect.die('Unused'),
    create: () => Effect.die('Unused'),
    getCreatedByInvocation: () => Effect.die('Unused'),
    getCurrent: () => Effect.die('Unused'),
    getHistory: () => Effect.die('Unused'),
    reactivate: () => Effect.die('Unused'),
    recoverCreateProduct: () => Effect.die('Unused'),
    recoverUpdateProduct: () => Effect.die('Unused'),
    retire: () => Effect.die('Unused'),
    update: () => Effect.die('Unused'),
    ...services,
  },
});

describe('Product lifecycle acceptance (#414)', () => {
  it.effect(
    'creation without every fact yields a draft Product and one working Variant that is not Catalog-ready',
    () =>
      Effect.gen(function* createDraft() {
        const { persistence, state } = yield* persistenceFor({ product: draftProduct(), variants: [] });
        const outcome = yield* persistence.create({
          actionInvocationId: invocationId,
          // oxlint-disable-next-line sonarjs/no-undefined-assignment -- Create input explicitly models absent optional facts.
          description: undefined,
          // oxlint-disable-next-line sonarjs/no-undefined-assignment -- Create input explicitly models absent optional facts.
          name: undefined,
          principalId,
          reason: 'Initial catalog record',
          tenantId,
          variantId,
        });
        const created = Match.value(outcome).pipe(
          Match.tag('created', (value) => value),
          Match.orElse(() => null),
        );
        expect(created).not.toBeNull();
        if (created === null) {
          return;
        }
        expect(created.variantId).toBe(variantId);
        expect(created.product.lifecycle).toBe('DRAFT');
        expect(created.product.catalogReady).toBe(false);
        expect(created.product.name).toBeUndefined();
        expect(created.product.variants).toHaveLength(1);
        expect(created.product.variants[0]?.lifecycle).toBe('WORK_IN_PROGRESS');
        expect(state.revisions[0]).toMatchObject({ changeKind: 'CREATED', lifecycleState: 'DRAFT', revision: 1 });
        expect(state.variantRevisions[0]).toMatchObject({
          changeKind: 'CREATED',
          lifecycleState: 'WORK_IN_PROGRESS',
          revision: 1,
          variantId,
        });
      }),
  );

  it('distinguishes one complete sibling Variant from an incomplete one without claiming Current proof', () => {
    const complete = productAggregate('ACTIVE', ['ACTIVE']);
    const mixed = productAggregate('ACTIVE', ['WORK_IN_PROGRESS', 'ACTIVE']);
    const incomplete = productAggregate('ACTIVE', ['WORK_IN_PROGRESS']);

    expect(productActivationBlockers(mixed, ['Kladivo'])).toEqual([]);
    expect(productActivationBlockers(complete, ['Kladivo'])).toEqual([]);
    expect(productActivationBlockers(incomplete, ['Kladivo'])).toEqual(['Product needs at least one ACTIVE Variant']);
    // Necessary row evidence is never the derived Current Catalog-readiness of a concrete use (#479).
    expect(catalogReadiness(mixed, ['Kladivo'])).toEqual({
      catalogReady: false,
      reasons: ['Current Product Type, required facts, Variant axes, Unit and dependent content are not verified'],
    });
    expect(catalogReadiness(complete, ['Kladivo'], [currentValidEvidence({ productRef, variantRef })])).toEqual({
      catalogReady: true,
      reasons: [],
    });
    expect(
      catalogReadiness(
        complete,
        ['Kladivo'],
        [
          currentValidEvidence({
            productRef,
            variantRef: { ...variantRef, resourceId: '00000000-0000-4000-8000-000000000099' },
          }),
        ],
      ),
    ).toEqual({
      catalogReady: false,
      reasons: ['Current Product Type, required facts, Variant axes, Unit and dependent content are not verified'],
    });
  });

  it.effect('activates a documented Product only after the necessary row evidence is present', () =>
    Effect.gen(function* activateProduct() {
      const { persistence, state } = yield* persistenceFor({
        localizedNames: [{ name: 'Kladivo', state: 'SET' }],
        product: draftProduct(),
        variants: [variant('ACTIVE')],
      });
      const outcome = yield* persistence.update({
        actionInvocationId: invocationId,
        activateVariantId: variantId,
        expectedRevision: 1,
        principalId,
        productId,
        reason: 'Ready for Catalog use',
        targetLifecycle: 'ACTIVE',
        tenantId,
      });
      const updated = Match.value(outcome).pipe(
        Match.tag('updated', (value) => value),
        Match.orElse(() => null),
      );
      expect(updated).not.toBeNull();
      if (updated === null) {
        return;
      }
      expect(updated.changed).toBe(true);
      expect(updated.product.lifecycle).toBe('ACTIVE');
      // An ACTIVE Product can still be Catalog-incomplete.
      expect(updated.product.catalogReady).toBe(false);
      expect(state.product.currentRevision).toBe(2);
      expect(state.revisions[0]).toMatchObject({
        changeKind: 'LIFECYCLE',
        lifecycleState: 'ACTIVE',
        revision: 2,
      });
      expect(state.lifecycleEvents[0]).toMatchObject({ event: 'ACTIVATED' });
    }),
  );

  it.effect('refuses activation when a current Catalog name is missing, without writing history', () =>
    Effect.gen(function* refuseUnnamedActivation() {
      const { persistence, state } = yield* persistenceFor({
        localizedNames: [],
        product: draftProduct(),
        variants: [variant('ACTIVE')],
      });
      const outcome = yield* persistence.update({
        actionInvocationId: invocationId,
        // oxlint-disable-next-line sonarjs/no-undefined-assignment -- Update input explicitly models an absent target Variant.
        activateVariantId: undefined,
        expectedRevision: 1,
        principalId,
        productId,
        reason: 'Activate unnamed draft',
        targetLifecycle: 'ACTIVE',
        tenantId,
      });
      const refused = Match.value(outcome).pipe(
        Match.tag('not_catalog_ready', (value) => value),
        Match.orElse(() => null),
      );
      expect(refused?.reasons).toEqual(['Product needs a current localized Catalog name']);
      expect(state.product.lifecycleState).toBe('DRAFT');
      expect(state.revisions).toHaveLength(0);
      expect(state.lifecycleEvents).toHaveLength(0);
    }),
  );

  it.effect('retirement preserves identity and Variants while appending immutable lifecycle history', () =>
    Effect.gen(function* retireProduct() {
      const { persistence, state } = yield* persistenceFor({
        localizedNames: [{ name: 'Kladivo', state: 'SET' }],
        product: activeProduct(2),
        variants: [variant('ACTIVE')],
      });
      const outcome = yield* persistence.retire({
        actionInvocationId: invocationId,
        effectiveAt: now,
        expectedRevision: 2,
        principalId,
        productId,
        reason: 'Discontinued',
        tenantId,
      });
      const retired = Match.value(outcome).pipe(
        Match.tag('retired', (value) => value),
        Match.orElse(() => null),
      );
      expect(retired).not.toBeNull();
      if (retired === null) {
        return;
      }
      expect(retired.product.productRef.resourceId).toBe(productId);
      expect(retired.product.lifecycle).toBe('RETIRED');
      expect(retired.product.variants[0]).toMatchObject({ variantId });
      expect(state.product.retiredReason).toBe('Discontinued');
      expect(state.revisions[0]).toMatchObject({
        changeKind: 'LIFECYCLE',
        lifecycleState: 'RETIRED',
        name: 'Kladivo',
        revision: 3,
      });
      expect(state.lifecycleEvents[0]).toMatchObject({ event: 'RETIRED' });

      const repeated = yield* persistence.retire({
        actionInvocationId: '00000000-0000-4000-8000-000000000007',
        effectiveAt: now,
        expectedRevision: 3,
        principalId,
        productId,
        reason: 'Discontinued again',
        tenantId,
      });
      const repeatedOutcome = Match.value(repeated).pipe(
        Match.tag('already_retired', (value) => value),
        Match.orElse(() => null),
      );
      expect(repeatedOutcome).not.toBeNull();
      expect(state.revisions).toHaveLength(1);
    }),
  );

  it.effect('retirement blocks a new Current acceptance while exact references stay readable', () =>
    Effect.gen(function* retiredSelection() {
      const transaction = {
        select: () => ({
          from: (table: unknown) => ({
            where: () => {
              const rows =
                table === products
                  ? [{ lifecycleState: 'RETIRED', revision: 4 }]
                  : [{ lifecycleState: 'ACTIVE', productId, revision: 7 }];
              return Object.assign(Effect.succeed(rows), { limit: () => Effect.succeed(rows) });
            },
          }),
        }),
      };
      const selection = { productRef, variantRef };
      // @ts-expect-error Only the early Product/Variant owner reads are mocked.
      const result = yield* catalogSelectionCurrentBasisForScope(transaction, scope).read({
        purpose: 'PURCHASE_ACCEPTANCE',
        selection,
      });
      expect(result.status).toBe('INVALID');
      if (result.status === 'OBSERVED') {
        return;
      }
      expect(result.reason).toBe('Selected Product or Variant is retired');
      expect(result.basis.map(({ role, source }) => [role, source.revision])).toEqual([
        ['PRODUCT', 4],
        ['VARIANT', 7],
      ]);
    }),
  );

  it.effect('reactivation keeps the same identity, re-assesses, and never restores a retired Variant', () =>
    Effect.gen(function* reactivateProduct() {
      const { persistence, state } = yield* persistenceFor(
        {
          localizedNames: [{ name: 'Kladivo', state: 'SET' }],
          product: retiredProduct(3),
          variants: [variant('ACTIVE')],
        },
        currentValidEvidenceReader,
      );
      const outcome = yield* persistence.reactivate({
        actionInvocationId: invocationId,
        expectedRevision: 3,
        principalId,
        productId,
        reason: 'Product verified again',
        tenantId,
      });
      const reactivated = Match.value(outcome).pipe(
        Match.tag('reactivated', (value) => value),
        Match.orElse(() => null),
      );
      expect(reactivated).not.toBeNull();
      if (reactivated === null) {
        return;
      }
      expect(reactivated.product.productRef.resourceId).toBe(productId);
      expect(reactivated.product.lifecycle).toBe('ACTIVE');
      expect(reactivated.product.catalogReady).toBe(true);
      expect(reactivated.product.variants[0]).toMatchObject({ lifecycle: 'ACTIVE', variantId });
      expect(state.product.retiredReason).toBeNull();
      expect(state.revisions[0]).toMatchObject({ changeKind: 'LIFECYCLE', lifecycleState: 'ACTIVE', revision: 4 });
      expect(state.lifecycleEvents[0]).toMatchObject({ event: 'ACTIVATED' });
    }),
  );

  it.effect('reactivation fails closed when no exact-selection Current evidence reader is bound', () =>
    Effect.gen(function* refuseUnverifiedReactivation() {
      const { persistence, state } = yield* persistenceFor({
        localizedNames: [{ name: 'Kladivo', state: 'SET' }],
        product: retiredProduct(3),
        variants: [variant('ACTIVE')],
      });
      const outcome = yield* persistence.reactivate({
        actionInvocationId: invocationId,
        expectedRevision: 3,
        principalId,
        productId,
        reason: 'Product lacks Current evidence',
        tenantId,
      });
      const refused = Match.value(outcome).pipe(
        Match.tag('not_catalog_ready', (value) => value),
        Match.orElse(() => null),
      );
      expect(refused?.reasons).toEqual([
        'Current Product Type, required facts, Variant axes, Unit and dependent content are not verified',
      ]);
      expect(state.product.lifecycleState).toBe('RETIRED');
      expect(state.revisions).toHaveLength(0);
      expect(state.lifecycleEvents).toHaveLength(0);
    }),
  );

  it.effect('the Reactivate Product Action succeeds through transaction-bound exact-selection evidence', () =>
    Effect.gen(function* actionReactivation() {
      const { persistence, state } = yield* persistenceFor(
        {
          localizedNames: [{ name: 'Kladivo', state: 'SET' }],
          product: retiredProduct(3),
          variants: [variant('ACTIVE')],
        },
        currentValidEvidenceReader,
      );
      const result = yield* handleReactivateProduct(
        { expectedRevision: 3, productRef, reason: 'Product verified through Current evidence' },
        executableContextFor(persistence),
      );
      expect(result.product).toMatchObject({ catalogReady: true, lifecycle: 'ACTIVE', productRef, revision: 4 });
      expect(state.product.lifecycleState).toBe('ACTIVE');
      expect(state.revisions).toHaveLength(1);
      expect(state.lifecycleEvents).toHaveLength(1);
    }),
  );

  it.effect('the Reactivate Product Action reports unavailable Current evidence without lifecycle history', () =>
    Effect.gen(function* unavailableActionReactivation() {
      const { persistence, state } = yield* persistenceFor(
        {
          localizedNames: [{ name: 'Kladivo', state: 'SET' }],
          product: retiredProduct(3),
          variants: [variant('ACTIVE')],
        },
        unavailableEvidenceReader,
      );
      const error = yield* handleReactivateProduct(
        { expectedRevision: 3, productRef, reason: 'Product cannot be verified' },
        executableContextFor(persistence),
      ).pipe(Effect.flip);
      expect(Schema.is(ProductNotCatalogReady)(error)).toBe(true);
      expect(state.product.lifecycleState).toBe('RETIRED');
      expect(state.product.currentRevision).toBe(3);
      expect(state.revisions).toHaveLength(0);
      expect(state.lifecycleEvents).toHaveLength(0);
    }),
  );

  it.effect('reactivation refuses a Product whose Variant was retired instead of resurrecting it', () =>
    Effect.gen(function* refuseRetiredVariant() {
      const { persistence, state } = yield* persistenceFor({
        localizedNames: [{ name: 'Kladivo', state: 'SET' }],
        product: retiredProduct(3),
        variants: [variant('RETIRED')],
      });
      const outcome = yield* persistence.reactivate({
        actionInvocationId: invocationId,
        expectedRevision: 3,
        principalId,
        productId,
        reason: 'Reactivate without Variant',
        tenantId,
      });
      const refused = Match.value(outcome).pipe(
        Match.tag('not_catalog_ready', (value) => value),
        Match.orElse(() => null),
      );
      expect(refused?.reasons).toEqual(['Product needs at least one ACTIVE Variant']);
      expect(state.product.lifecycleState).toBe('RETIRED');
      expect(state.revisions).toHaveLength(0);
    }),
  );

  it.effect('a stale editor cannot silently overwrite a newer Product change', () =>
    Effect.gen(function* staleEditor() {
      const { persistence, state } = yield* persistenceFor({
        localizedNames: [{ name: 'Kladivo', state: 'SET' }],
        product: activeProduct(5),
        variants: [variant('ACTIVE')],
      });
      const update = yield* persistence.update({
        actionInvocationId: invocationId,
        activateVariantId: variantId,
        expectedRevision: 2,
        principalId,
        productId,
        reason: 'Old editor',
        targetLifecycle: 'ACTIVE',
        tenantId,
      });
      const conflict = Match.value(update).pipe(
        Match.tag('revision_conflict', (value) => value),
        Match.orElse(() => null),
      );
      expect(conflict?.actualRevision).toBe(5);

      const retire = yield* persistence.retire({
        actionInvocationId: invocationId,
        effectiveAt: now,
        expectedRevision: 2,
        principalId,
        productId,
        reason: 'Old editor',
        tenantId,
      });
      const retireConflict = Match.value(retire).pipe(
        Match.tag('revision_conflict', (value) => value),
        Match.orElse(() => null),
      );
      expect(retireConflict?.actualRevision).toBe(5);

      const reactivate = yield* persistence.reactivate({
        actionInvocationId: invocationId,
        expectedRevision: 2,
        principalId,
        productId,
        reason: 'Old editor',
        tenantId,
      });
      const reactivateConflict = Match.value(reactivate).pipe(
        Match.tag('revision_conflict', (value) => value),
        Match.orElse(() => null),
      );
      expect(reactivateConflict?.actualRevision).toBe(5);
      expect(state.revisions).toHaveLength(0);
      expect(state.lifecycleEvents).toHaveLength(0);
    }),
  );

  it.effect('maps stale, cross-tenant, missing, and illegal lifecycle edits to typed failures', () =>
    Effect.gen(function* typedFailures() {
      const stale = contextFor(updateProductAction.descriptor.domainEvents, {
        update: () => Effect.succeed({ _tag: 'revision_conflict', actualRevision: 5 }),
      });
      const revisionError = yield* handleUpdateProduct(
        { expectedRevision: 1, productRef, reason: 'Stale edit' },
        stale,
      ).pipe(Effect.flip);
      expect(Schema.is(ProductRevisionConflict)(revisionError)).toBe(true);

      const foreign = contextFor(updateProductAction.descriptor.domainEvents, {});
      const foreignError = yield* handleUpdateProduct(
        { expectedRevision: 1, productRef: { ...productRef, tenantId: foreignTenantId }, reason: 'Foreign edit' },
        foreign,
      ).pipe(Effect.flip);
      expect(Schema.is(ProductNotFound)(foreignError)).toBe(true);

      const missing = contextFor(retireProductAction.descriptor.domainEvents, {
        retire: () => Effect.succeed({ _tag: 'not_found' }),
      });
      const missingError = yield* handleRetireProduct(
        { expectedRevision: 1, productRef, reason: 'Retire missing' },
        missing,
      ).pipe(Effect.flip);
      expect(Schema.is(ProductNotFound)(missingError)).toBe(true);

      const notRetired = contextFor(reactivateProductAction.descriptor.domainEvents, {
        reactivate: () =>
          Effect.succeed({ _tag: 'lifecycle_conflict', product: productAggregate('ACTIVE', ['ACTIVE'], 2) }),
      });
      const lifecycleError = yield* handleReactivateProduct(
        { expectedRevision: 2, productRef, reason: 'Reactivate active Product' },
        notRetired,
      ).pipe(Effect.flip);
      expect(Schema.is(ProductLifecycleConflict)(lifecycleError)).toBe(true);
    }),
  );
});
