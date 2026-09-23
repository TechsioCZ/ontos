import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { and, eq } from 'drizzle-orm';
import { Effect, Option, Schema } from 'effect';

import type { ProductRef } from '../../shared/resources/product.ts';
import type { ProductHistoryResponse } from '../../shared/apis/product-history.ts';
import type { VariantRef } from '../../shared/resources/variant.ts';
import {
  productLocalizedFactRevisions,
  productLocalizedFacts,
  products,
  productVariants,
  variantLocalizedFactRevisions,
  variantLocalizedFacts,
} from '../database/schema.ts';
import { LocalizedFactsPersistenceUnavailable } from './localized-product-facts-persistence.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];
type FactRow = typeof productLocalizedFacts.$inferSelect | typeof variantLocalizedFacts.$inferSelect;
type RevisionRow =
  | typeof productLocalizedFactRevisions.$inferSelect
  | typeof variantLocalizedFactRevisions.$inferSelect;

type LocalizedFactRead =
  | { readonly kind: 'MISSING_TRANSLATION'; readonly locale: string; readonly revision: number }
  | {
      readonly description?: string;
      readonly kind: 'PRESENT';
      readonly locale: string;
      readonly name?: string;
      readonly provenance?: {
        readonly actingPrincipalId: string;
        readonly actionInvocationId: string;
        readonly evidenceRefs: readonly string[];
        readonly reason: string;
        readonly recordedAt: Date;
      };
      readonly revision: number;
    };

export interface LocalizedFactsReads {
  readonly activeNameStatus: (
    productRef: ProductRef,
  ) => Effect.Effect<'NOT_FOUND' | 'NOT_ACTIVE' | 'HAS_NAME' | 'MISSING_NAME', LocalizedFactsPersistenceUnavailable>;
  readonly currentProduct: (
    productRef: ProductRef,
    locale: string,
  ) => Effect.Effect<LocalizedFactRead, LocalizedFactsPersistenceUnavailable>;
  readonly currentVariant: (
    productRef: ProductRef,
    variantRef: VariantRef,
    locale: string,
  ) => Effect.Effect<LocalizedFactRead, LocalizedFactsPersistenceUnavailable>;
  readonly productHistory: (
    productRef: ProductRef,
    locale: string,
  ) => Effect.Effect<NonNullable<ProductHistoryResponse['localizedRevisions']>, LocalizedFactsPersistenceUnavailable>;
  readonly productRevision: (
    productRef: ProductRef,
    locale: string,
    revision: number,
  ) => Effect.Effect<Option.Option<LocalizedFactRead>, LocalizedFactsPersistenceUnavailable>;
  readonly variantRevision: (
    productRef: ProductRef,
    variantRef: VariantRef,
    locale: string,
    revision: number,
  ) => Effect.Effect<Option.Option<LocalizedFactRead>, LocalizedFactsPersistenceUnavailable>;
}

const unavailable = (cause?: unknown) => {
  const failure = new LocalizedFactsPersistenceUnavailable({
    code: 'localized_facts_persistence_unavailable',
    reason: 'Localized Catalog facts are temporarily unavailable',
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};
const uuid = (value: string) => Schema.is(Schema.String.check(Schema.isUUID()))(value);
const validLocale = (value: string) => {
  if (value.length < 2 || value.length > 64 || value !== value.trim()) {
    return false;
  }
  try {
    return Intl.getCanonicalLocales(value)[0] === value;
  } catch {
    return false;
  }
};
const validProduct = (ref: ProductRef, tenantId: string) =>
  ref.tenantId === tenantId &&
  ref.moduleId === 'commerce.catalog' &&
  ref.resourceType === 'commerce.catalog.product' &&
  uuid(ref.resourceId);
const validVariant = (ref: VariantRef, tenantId: string) =>
  ref.tenantId === tenantId &&
  ref.moduleId === 'commerce.catalog' &&
  ref.resourceType === 'commerce.catalog.variant' &&
  uuid(ref.resourceId);
const validText = (text: string | null, max: number) =>
  text === null || (text.length > 0 && text.length <= max && text === text.trim());
const validProvenance = (row: RevisionRow) =>
  uuid(row.actionInvocationId) &&
  uuid(row.actingPrincipalId) &&
  validText(row.reason, 1000) &&
  Array.isArray(row.evidenceRefs) &&
  row.evidenceRefs.every((ref) => validText(ref, 300)) &&
  Number.isFinite(row.recordedAt.getTime());
const validFact = (
  row: FactRow | RevisionRow,
  tenantId: string,
  productId: string,
  variantId: string | null,
  locale: string,
) =>
  row.tenantId === tenantId &&
  row.productId === productId &&
  row.locale === locale &&
  ('variantId' in row ? row.variantId === variantId : variantId === null) &&
  (row.state === 'SET' || row.state === 'REMOVED') &&
  validText(row.name, 240) &&
  validText(row.description, 4000) &&
  (row.state === 'SET'
    ? row.name !== null || row.description !== null
    : row.name === null && row.description === null) &&
  Number.isSafeInteger('revision' in row ? row.revision : row.currentRevision) &&
  ('revision' in row ? row.revision : row.currentRevision) > 0 &&
  (!('reason' in row) || validProvenance(row));

const decode = (
  row: FactRow | RevisionRow | undefined,
  tenantId: string,
  productId: string,
  variantId: string | null,
  locale: string,
): LocalizedFactRead => {
  if (row === undefined) {
    return { kind: 'MISSING_TRANSLATION', locale, revision: 0 };
  }
  if (!validFact(row, tenantId, productId, variantId, locale)) {
    throw unavailable();
  }
  const revision = 'revision' in row ? row.revision : row.currentRevision;
  if (row.state === 'REMOVED') {
    return { kind: 'MISSING_TRANSLATION', locale, revision };
  }
  const result: Extract<LocalizedFactRead, { readonly kind: 'PRESENT' }> = {
    kind: 'PRESENT',
    locale,
    revision,
  };
  if (row.name !== null) {
    Object.assign(result, { name: row.name });
  }
  if (row.description !== null) {
    Object.assign(result, { description: row.description });
  }
  if ('reason' in row) {
    Object.assign(result, {
      provenance: {
        actingPrincipalId: row.actingPrincipalId,
        actionInvocationId: row.actionInvocationId,
        evidenceRefs: row.evidenceRefs,
        reason: row.reason,
        recordedAt: row.recordedAt,
      },
    });
  }
  return result;
};

/** Private owner service. Core has already installed and verified tenant scope on this transaction. */
export const localizedFactsReadsForScope = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
): LocalizedFactsReads => {
  const { tenantId } = scope;
  const owner = Effect.fn('LocalizedFactsReads.owner')(function* owner(
    productRef: ProductRef,
    variantRef?: VariantRef,
  ) {
    if (!validProduct(productRef, tenantId) || (variantRef !== undefined && !validVariant(variantRef, tenantId))) {
      return yield* unavailable();
    }
    const rows =
      variantRef === undefined
        ? yield* transaction
            .select({ id: products.productId })
            .from(products)
            .where(and(eq(products.tenantId, tenantId), eq(products.productId, productRef.resourceId)))
            .limit(2)
            .pipe(Effect.mapError(unavailable))
        : yield* transaction
            .select({ id: productVariants.variantId })
            .from(productVariants)
            .where(
              and(
                eq(productVariants.tenantId, tenantId),
                eq(productVariants.productId, productRef.resourceId),
                eq(productVariants.variantId, variantRef.resourceId),
              ),
            )
            .limit(2)
            .pipe(Effect.mapError(unavailable));
    if (rows.length > 1) {
      return yield* unavailable();
    }
    return rows.length === 1;
  });
  const productRevision: LocalizedFactsReads['productRevision'] = Effect.fn('LocalizedFactsReads.productRevision')(
    function* productRevision(ref, locale, revision) {
      if (!validLocale(locale) || !Number.isSafeInteger(revision) || revision < 1) {
        return yield* unavailable();
      }
      if (!(yield* owner(ref))) {
        return Option.none();
      }
      const rows = yield* transaction
        .select()
        .from(productLocalizedFactRevisions)
        .where(
          and(
            eq(productLocalizedFactRevisions.tenantId, tenantId),
            eq(productLocalizedFactRevisions.productId, ref.resourceId),
            eq(productLocalizedFactRevisions.locale, locale),
            eq(productLocalizedFactRevisions.revision, revision),
          ),
        )
        .limit(2)
        .pipe(Effect.mapError(unavailable));
      if (rows.length > 1) {
        return yield* unavailable();
      }
      return rows[0] === undefined
        ? Option.none()
        : Option.some(
            yield* Effect.try({
              catch: unavailable,
              try: () => decode(rows[0], tenantId, ref.resourceId, null, locale),
            }),
          );
    },
  );
  const productHistory: LocalizedFactsReads['productHistory'] = Effect.fn('LocalizedFactsReads.productHistory')(
    function* productHistory(ref, locale) {
      if (!validLocale(locale) || !(yield* owner(ref))) {
        return yield* unavailable();
      }
      const rows = yield* transaction
        .select()
        .from(productLocalizedFactRevisions)
        .where(
          and(
            eq(productLocalizedFactRevisions.tenantId, tenantId),
            eq(productLocalizedFactRevisions.productId, ref.resourceId),
            eq(productLocalizedFactRevisions.locale, locale),
          ),
        )
        .orderBy(productLocalizedFactRevisions.revision)
        .pipe(Effect.mapError(unavailable));
      return yield* Effect.forEach(
        rows,
        (row) => {
          if (!validFact(row, tenantId, ref.resourceId, null, locale)) {
            return unavailable();
          }
          const result: NonNullable<ProductHistoryResponse['localizedRevisions']>[number] = {
            evidenceRefs: row.evidenceRefs,
            historical: true,
            kind: row.state === 'REMOVED' ? 'REMOVED' : 'SET',
            locale,
            reason: row.reason,
            recordedAt: row.recordedAt.toISOString(),
            revision: row.revision,
          };
          if (row.name !== null) {
            Object.assign(result, { name: row.name });
          }
          if (row.description !== null) {
            Object.assign(result, { description: row.description });
          }
          return Effect.succeed(result);
        },
        { concurrency: 1 },
      );
    },
  );
  const variantRevision: LocalizedFactsReads['variantRevision'] = Effect.fn('LocalizedFactsReads.variantRevision')(
    function* variantRevision(productRef, variantRef, locale, revision) {
      if (!validLocale(locale) || !Number.isSafeInteger(revision) || revision < 1) {
        return yield* unavailable();
      }
      if (!(yield* owner(productRef, variantRef))) {
        return Option.none();
      }
      const rows = yield* transaction
        .select()
        .from(variantLocalizedFactRevisions)
        .where(
          and(
            eq(variantLocalizedFactRevisions.tenantId, tenantId),
            eq(variantLocalizedFactRevisions.productId, productRef.resourceId),
            eq(variantLocalizedFactRevisions.variantId, variantRef.resourceId),
            eq(variantLocalizedFactRevisions.locale, locale),
            eq(variantLocalizedFactRevisions.revision, revision),
          ),
        )
        .limit(2)
        .pipe(Effect.mapError(unavailable));
      if (rows.length > 1) {
        return yield* unavailable();
      }
      return rows[0] === undefined
        ? Option.none()
        : Option.some(
            yield* Effect.try({
              catch: unavailable,
              try: () => decode(rows[0], tenantId, productRef.resourceId, variantRef.resourceId, locale),
            }),
          );
    },
  );
  const currentProduct: LocalizedFactsReads['currentProduct'] = Effect.fn('LocalizedFactsReads.currentProduct')(
    function* currentProduct(ref, locale) {
      if (!validLocale(locale)) {
        return yield* unavailable();
      }
      if (!(yield* owner(ref))) {
        return { kind: 'MISSING_TRANSLATION', locale, revision: 0 };
      }
      const rows = yield* transaction
        .select()
        .from(productLocalizedFacts)
        .where(
          and(
            eq(productLocalizedFacts.tenantId, tenantId),
            eq(productLocalizedFacts.productId, ref.resourceId),
            eq(productLocalizedFacts.locale, locale),
          ),
        )
        .limit(2)
        .pipe(Effect.mapError(unavailable));
      if (rows.length > 1) {
        return yield* unavailable();
      }
      const current = yield* Effect.try({
        catch: unavailable,
        try: () => decode(rows[0], tenantId, ref.resourceId, null, locale),
      });
      if (rows[0] === undefined) {
        return current;
      }
      const historical = yield* productRevision(ref, locale, rows[0].currentRevision);
      if (
        Option.isNone(historical) ||
        historical.value.kind !== current.kind ||
        ('name' in historical.value ? historical.value.name : undefined) !==
          ('name' in current ? current.name : undefined) ||
        ('description' in historical.value ? historical.value.description : undefined) !==
          ('description' in current ? current.description : undefined)
      ) {
        return yield* unavailable();
      }
      return historical.value;
    },
  );
  const currentVariant: LocalizedFactsReads['currentVariant'] = Effect.fn('LocalizedFactsReads.currentVariant')(
    function* currentVariant(productRef, variantRef, locale) {
      if (!validLocale(locale)) {
        return yield* unavailable();
      }
      if (!(yield* owner(productRef, variantRef))) {
        return { kind: 'MISSING_TRANSLATION', locale, revision: 0 };
      }
      const rows = yield* transaction
        .select()
        .from(variantLocalizedFacts)
        .where(
          and(
            eq(variantLocalizedFacts.tenantId, tenantId),
            eq(variantLocalizedFacts.productId, productRef.resourceId),
            eq(variantLocalizedFacts.variantId, variantRef.resourceId),
            eq(variantLocalizedFacts.locale, locale),
          ),
        )
        .limit(2)
        .pipe(Effect.mapError(unavailable));
      if (rows.length > 1) {
        return yield* unavailable();
      }
      const current = yield* Effect.try({
        catch: unavailable,
        try: () => decode(rows[0], tenantId, productRef.resourceId, variantRef.resourceId, locale),
      });
      if (rows[0] === undefined) {
        return current;
      }
      const historical = yield* variantRevision(productRef, variantRef, locale, rows[0].currentRevision);
      if (
        Option.isNone(historical) ||
        historical.value.kind !== current.kind ||
        ('name' in historical.value ? historical.value.name : undefined) !==
          ('name' in current ? current.name : undefined) ||
        ('description' in historical.value ? historical.value.description : undefined) !==
          ('description' in current ? current.description : undefined)
      ) {
        return yield* unavailable();
      }
      return historical.value;
    },
  );
  const activeNameStatus: LocalizedFactsReads['activeNameStatus'] = Effect.fn('LocalizedFactsReads.activeNameStatus')(
    function* activeNameStatus(ref) {
      if (!validProduct(ref, tenantId)) {
        return yield* unavailable();
      }
      const rows = yield* transaction
        .select({ lifecycleState: products.lifecycleState })
        .from(products)
        .where(and(eq(products.tenantId, tenantId), eq(products.productId, ref.resourceId)))
        .limit(2)
        .pipe(Effect.mapError(unavailable));
      if (rows.length > 1) {
        return yield* unavailable();
      }
      if (rows[0] === undefined) {
        return 'NOT_FOUND';
      }
      if (rows[0].lifecycleState !== 'ACTIVE') {
        return 'NOT_ACTIVE';
      }
      const facts = yield* transaction
        .select()
        .from(productLocalizedFacts)
        .where(and(eq(productLocalizedFacts.tenantId, tenantId), eq(productLocalizedFacts.productId, ref.resourceId)))
        .pipe(Effect.mapError(unavailable));
      if (
        facts.some((row) => !validLocale(row.locale) || !validFact(row, tenantId, ref.resourceId, null, row.locale))
      ) {
        return yield* unavailable();
      }
      return facts.some((row) => row.state === 'SET' && row.name !== null && row.name.trim().length > 0)
        ? 'HAS_NAME'
        : 'MISSING_NAME';
    },
  );
  return { activeNameStatus, currentProduct, currentVariant, productHistory, productRevision, variantRevision };
};
