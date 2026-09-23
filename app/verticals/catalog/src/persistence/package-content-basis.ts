import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { and, eq } from 'drizzle-orm';
import { DateTime, Effect, Match, Option, Schema } from 'effect';

import { resolvePackageContent } from '../../shared/domain/package-content.ts';
import type { PackageContentRevision } from '../../shared/domain/package-content.ts';
import type { PackageDefinitionContentInputSchema } from '../../shared/actions/package-definition-contract.ts';
import { CatalogSelectionRevisionSchema } from '../../shared/domain/catalog-selection-evidence.ts';
import type { CatalogSelectionRevision } from '../../shared/domain/catalog-selection-evidence.ts';
import {
  packageContentRevisions,
  packageDefinitions,
  productUnitRuleRevisions,
  productUnits,
  productVariants,
  products,
  setCompositionRevisions,
  setCompositions,
} from '../database/schema.ts';
import { PackagePersistenceUnavailable, resolveEffectiveRevision } from './package-persistence.ts';
import { setCompositionPersistenceForScope } from './set-composition-persistence.ts';
import { setCompositionComponentCurrentBasisForScope } from './set-composition-component-current-basis.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];
const packageType = 'commerce.catalog.package-definition';
const moduleId = 'commerce.catalog';
const productUnitType = 'commerce.catalog.product-unit';
const setCompositionType = 'commerce.catalog.set-composition';
const unavailable = (cause?: unknown) => {
  const failure = new PackagePersistenceUnavailable({
    code: 'package_persistence_unavailable',
    reason: 'Authoritative Package Definition basis is unavailable',
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

type Content = typeof PackageDefinitionContentInputSchema.Type;
const hasIncompleteSetReference = (row: typeof packageContentRevisions.$inferSelect): boolean =>
  (row.setCompositionResourceId === null) !== (row.setCompositionRevision === null);

const setCompositionFromRow = Effect.fn('PackageContentBasis.setCompositionFromRow')(function* decodeSetComposition(
  row: typeof packageContentRevisions.$inferSelect,
  tenantId: string,
) {
  if (row.setCompositionResourceId === null || row.setCompositionRevision === null) {
    return Option.none();
  }
  return Option.some(
    yield* Schema.decodeEffect(CatalogSelectionRevisionSchema)({
      resourceRef: { moduleId, resourceId: row.setCompositionResourceId, resourceType: setCompositionType, tenantId },
      revision: row.setCompositionRevision,
    }),
  );
});
const currentSetComposition = Effect.fn('PackageContentBasis.currentSetComposition')(
  function* currentSetCompositionRows(
    transaction: ScopedTransaction,
    content: Pick<Content, 'form' | 'setComposition'>,
    scope: OperationalScope,
  ) {
    const { tenantId } = scope;
    const composition = content.setComposition;
    if (composition === undefined) {
      const [setTarget] = yield* transaction
        .select({ compositionId: setCompositions.compositionId })
        .from(setCompositions)
        .where(
          and(
            eq(setCompositions.tenantId, tenantId),
            eq(setCompositions.productId, content.form.productRef.resourceId),
            eq(setCompositions.variantId, content.form.variantRef.resourceId),
          ),
        )
        .for('update')
        .limit(1);
      return setTarget === undefined;
    }
    const { resourceRef, revision } = composition;
    if (
      resourceRef.moduleId !== moduleId ||
      resourceRef.resourceType !== setCompositionType ||
      resourceRef.tenantId !== tenantId ||
      composition.revisionId !== undefined
    ) {
      return false;
    }
    const productId = content.form.productRef.resourceId;
    const variantId = content.form.variantRef.resourceId;
    const [current] = yield* transaction
      .select()
      .from(setCompositions)
      .where(
        and(
          eq(setCompositions.tenantId, tenantId),
          eq(setCompositions.compositionId, resourceRef.resourceId),
          eq(setCompositions.productId, productId),
          eq(setCompositions.variantId, variantId),
        ),
      )
      .for('update')
      .limit(1);
    if (current === undefined || current.currentRevision < revision) {
      return false;
    }
    const [issued] = yield* transaction
      .select()
      .from(setCompositionRevisions)
      .where(
        and(
          eq(setCompositionRevisions.tenantId, tenantId),
          eq(setCompositionRevisions.compositionId, resourceRef.resourceId),
          eq(setCompositionRevisions.productId, productId),
          eq(setCompositionRevisions.variantId, variantId),
          eq(setCompositionRevisions.revision, revision),
        ),
      )
      .for('update')
      .limit(1);
    const now = DateTime.toDateUtc(yield* DateTime.now);
    if (
      issued === undefined ||
      issued.lifecycleState !== 'ACTIVE' ||
      issued.effectiveFrom > now ||
      (issued.effectiveTo !== null && issued.effectiveTo <= now)
    ) {
      return false;
    }
    const stored = yield* setCompositionPersistenceForScope(transaction, scope).readCurrent({
      at: now,
      compositionId: resourceRef.resourceId,
    });
    if (Option.isNone(stored) || stored.value.revision.reference.revision !== revision) {
      return false;
    }
    const exact = stored.value.revision;
    if (
      exact.productRef.resourceId !== productId ||
      exact.variantRef.resourceId !== variantId ||
      exact.reference.revision !== revision ||
      exact.components.length === 0
    ) {
      return false;
    }
    const proof = yield* setCompositionComponentCurrentBasisForScope(transaction, scope).read(exact, now);
    return proof.status === 'VALID';
  },
  Effect.mapError(unavailable),
);
const currentSubject = Effect.fn('PackageContentBasis.currentSubject')(function* currentSubjectRows(
  transaction: ScopedTransaction,
  content: Content,
  tenantId: string,
) {
  const productId = content.form.productRef.resourceId;
  const variantId = content.form.variantRef.resourceId;
  const unitId = content.unitRef.resourceId;
  const [product] = yield* transaction
    .select()
    .from(products)
    .where(and(eq(products.tenantId, tenantId), eq(products.productId, productId)))
    .for('update')
    .limit(1);
  if (product === undefined || product.lifecycleState === 'RETIRED') {
    return false;
  }
  const [variant] = yield* transaction
    .select()
    .from(productVariants)
    .where(
      and(
        eq(productVariants.tenantId, tenantId),
        eq(productVariants.productId, productId),
        eq(productVariants.variantId, variantId),
      ),
    )
    .for('update')
    .limit(1);
  if (variant === undefined || variant.lifecycleState === 'RETIRED') {
    return false;
  }
  const [unit] = yield* transaction
    .select()
    .from(productUnits)
    .where(and(eq(productUnits.tenantId, tenantId), eq(productUnits.unitId, unitId)))
    .for('update')
    .limit(1);
  if (unit === undefined || unit.lifecycleState !== 'ACTIVE') {
    return false;
  }
  const [rule] = yield* transaction
    .select()
    .from(productUnitRuleRevisions)
    .where(
      and(
        eq(productUnitRuleRevisions.tenantId, tenantId),
        eq(productUnitRuleRevisions.unitId, unitId),
        eq(productUnitRuleRevisions.revision, unit.currentRuleRevision),
      ),
    )
    .for('update')
    .limit(1);
  return rule !== undefined && rule.lifecycleState === 'ACTIVE';
});

const effectiveLowerRow = Effect.fn('PackageContentBasis.effectiveLowerRow')(function* readEffectiveLowerRow(
  transaction: ScopedTransaction,
  tenantId: string,
  lower: CatalogSelectionRevision,
  at: Date,
) {
  const rows = yield* transaction
    .select()
    .from(packageContentRevisions)
    .where(
      and(
        eq(packageContentRevisions.tenantId, tenantId),
        eq(packageContentRevisions.packageDefinitionId, lower.resourceRef.resourceId),
      ),
    )
    .for('update')
    .pipe(Effect.mapError(unavailable));
  return Match.value(resolveEffectiveRevision(rows, at)).pipe(
    Match.tag('resolved', ({ revision }) =>
      revision === lower.revision ? Option.fromNullishOr(rows.find((row) => row.revision === revision)) : Option.none(),
    ),
    Match.tag('invalid', () => Option.none()),
    Match.exhaustive,
  );
}, Effect.mapError(unavailable));

const loadLower: (
  transaction: ScopedTransaction,
  content: Content,
  scope: OperationalScope,
  lower: CatalogSelectionRevision,
  seen: ReadonlySet<string>,
  at: Date,
) => Effect.Effect<Option.Option<readonly PackageContentRevision[]>, PackagePersistenceUnavailable> = Effect.fn(
  'PackageContentBasis.loadLower',
)(function* loadLowerRows(
  transaction: ScopedTransaction,
  content: Content,
  scope: OperationalScope,
  lower: CatalogSelectionRevision,
  seen: ReadonlySet<string>,
  at: Date,
) {
  const { tenantId } = scope;
  const lowerId = lower.resourceRef.resourceId;
  if (lower.resourceRef.tenantId !== tenantId || lower.resourceRef.resourceType !== packageType || seen.has(lowerId)) {
    return Option.none();
  }
  const [definition] = yield* transaction
    .select()
    .from(packageDefinitions)
    .where(and(eq(packageDefinitions.tenantId, tenantId), eq(packageDefinitions.packageDefinitionId, lowerId)))
    .for('update')
    .limit(1);
  if (
    definition === undefined ||
    definition.productId !== content.form.productRef.resourceId ||
    definition.variantId !== content.form.variantRef.resourceId
  ) {
    return Option.none();
  }
  const row = Option.getOrUndefined(yield* effectiveLowerRow(transaction, tenantId, lower, at));
  if (
    row === undefined ||
    row.productId !== definition.productId ||
    row.variantId !== definition.variantId ||
    hasIncompleteSetReference(row)
  ) {
    return Option.none();
  }
  const next =
    row.lowerPackageDefinitionId === null || row.lowerRevision === null || row.lowerCount === null
      ? undefined
      : {
          count: row.lowerCount,
          revision: yield* Schema.decodeEffect(CatalogSelectionRevisionSchema)({
            resourceRef: { moduleId, resourceId: row.lowerPackageDefinitionId, resourceType: packageType, tenantId },
            revision: row.lowerRevision,
          }),
        };
  const base = {
    amount: row.amount,
    form: content.form,
    reference: yield* Schema.decodeEffect(CatalogSelectionRevisionSchema)(lower),
    unitRef: { moduleId, resourceId: row.unitResourceId, resourceType: row.unitResourceType, tenantId } as const,
  };
  const configured = row.configurationKey === null ? base : { ...base, configurationKey: row.configurationKey };
  const setComposition = yield* setCompositionFromRow(row, tenantId);
  const withSet = Option.isNone(setComposition) ? configured : { ...configured, setComposition: setComposition.value };
  const revision: PackageContentRevision = next === undefined ? withSet : { ...withSet, lower: next };
  if (!(yield* currentSetComposition(transaction, revision, scope))) {
    return Option.none();
  }
  if (next === undefined) {
    return Option.some([revision]);
  }
  const tail = yield* loadLower(transaction, content, scope, next.revision, new Set([...seen, lowerId]), at);
  return Option.isNone(tail) ? Option.none() : Option.some([revision, ...tail.value]);
}, Effect.mapError(unavailable));

/** All reads share Core's transaction and carry the trusted Tenant predicate. */
export const packageContentBasisForTransaction = (transaction: ScopedTransaction, scope: OperationalScope) => ({
  verify: Effect.fn('PackageContentBasis.verify')(function* verify({
    content,
    definitionId,
    tenantId,
  }: {
    readonly content: Content;
    readonly definitionId: string;
    readonly tenantId: string;
  }) {
    if (
      tenantId !== scope.tenantId ||
      content.form.productRef.tenantId !== tenantId ||
      content.form.variantRef.tenantId !== tenantId ||
      content.unitRef.tenantId !== tenantId ||
      content.unitRef.resourceType !== productUnitType
    ) {
      return false;
    }
    if (!(yield* currentSubject(transaction, content, tenantId))) {
      return false;
    }
    if (!(yield* currentSetComposition(transaction, content, scope))) {
      return false;
    }
    if (content.lower === undefined) {
      return true;
    }
    const at = DateTime.toDateUtc(DateTime.makeUnsafe(content.effectiveAt));
    const revisions = yield* loadLower(
      transaction,
      content,
      scope,
      content.lower.revision,
      new Set([definitionId]),
      at,
    );
    if (Option.isNone(revisions)) {
      return false;
    }
    const base = {
      amount: content.amount,
      form: content.form,
      lower: content.lower,
      reference: yield* Schema.decodeEffect(CatalogSelectionRevisionSchema)({
        resourceRef: { moduleId, resourceId: definitionId, resourceType: packageType, tenantId },
        revision: 1,
      }),
      unitRef: content.unitRef,
    };
    const withConfiguration =
      content.configurationKey === undefined ? base : { ...base, configurationKey: content.configurationKey };
    const proposed: PackageContentRevision =
      content.setComposition === undefined
        ? withConfiguration
        : { ...withConfiguration, setComposition: content.setComposition };
    return resolvePackageContent(proposed.reference, [proposed, ...revisions.value], '1').status === 'VALID';
  }, Effect.mapError(unavailable)),
});
