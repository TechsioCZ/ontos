import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { and, eq } from 'drizzle-orm';
import { DateTime, Effect, Equal, Schema } from 'effect';

/* oxlint-disable perfectionist/sort-objects, anti-slop/no-conditional-empty-object-spread -- Typed Drizzle insert order follows relational keys; optional result fields are omitted to preserve absence. expires: 2027-03-31. */

import type { ProductRef } from '../../shared/resources/product.ts';
import type { VariantRef } from '../../shared/resources/variant.ts';
import {
  productLocalizedFactRevisions,
  productLocalizedFacts,
  products,
  productVariants,
  variantLocalizedFactRevisions,
  variantLocalizedFacts,
} from '../database/schema.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];
interface Facts {
  readonly description?: string;
  readonly name?: string;
}
interface Change {
  readonly actionInvocationId: string;
  readonly evidenceRefs: readonly string[];
  readonly expectedRevision: number;
  readonly locale: string;
  readonly principalId: string;
  readonly reason: string;
  readonly value: { readonly kind: 'REMOVE' } | { readonly facts: Facts; readonly kind: 'SET' };
}
export type ProductLocalizedChange = Change & { readonly productRef: ProductRef };
export type VariantLocalizedChange = Change & { readonly productRef: ProductRef; readonly variantRef: VariantRef };
export type LocalizedFactOutcome =
  | { readonly kind: 'CHANGED' | 'REPLAYED'; readonly revision: number }
  | { readonly kind: 'NOT_FOUND' | 'INVALID' | 'TEXT_MINIMUM_CONFLICT' }
  | { readonly actualRevision: number; readonly kind: 'STALE' };
export type LocalizedFactLookup =
  | { readonly kind: 'MISSING_TRANSLATION'; readonly locale: string; readonly revision: number }
  | {
      readonly description?: string;
      readonly kind: 'PRESENT';
      readonly locale: string;
      readonly name?: string;
      readonly revision: number;
    };

export class LocalizedFactsPersistenceUnavailable extends Schema.TaggedError<LocalizedFactsPersistenceUnavailable>()(
  'LocalizedFactsPersistenceUnavailable',
  { code: Schema.Literal('localized_facts_persistence_unavailable'), reason: Schema.String },
) {}

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
const canonicalLocale = (value: string) => {
  if (value.length < 2 || value.length > 64 || value !== value.trim()) {
    return false;
  }
  try {
    return Intl.getCanonicalLocales(value)[0] === value;
  } catch {
    return false;
  }
};
const validText = (value: string | undefined, limit: number) =>
  value === undefined || (value.length > 0 && value.length <= limit && value === value.trim());
const validChange = (input: Change) => {
  const facts = input.value.kind === 'SET' ? input.value.facts : undefined;
  return (
    uuid(input.actionInvocationId) &&
    uuid(input.principalId) &&
    Number.isSafeInteger(input.expectedRevision) &&
    input.expectedRevision >= 0 &&
    canonicalLocale(input.locale) &&
    input.reason.length > 0 &&
    validText(input.reason, 1000) &&
    input.evidenceRefs.every((ref) => validText(ref, 300)) &&
    (facts === undefined ||
      ((facts.name !== undefined || facts.description !== undefined) &&
        validText(facts.name, 240) &&
        validText(facts.description, 4000)))
  );
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
const rowValue = (input: Change) => ({
  description: input.value.kind === 'SET' ? (input.value.facts.description ?? null) : null,
  name: input.value.kind === 'SET' ? (input.value.facts.name ?? null) : null,
  state: input.value.kind === 'SET' ? 'SET' : 'REMOVED',
});
const hasOtherName = (
  rows: readonly { readonly locale: string; readonly name: string | null; readonly state: string }[],
  locale: string,
) =>
  rows.some((row) => row.locale !== locale && row.state === 'SET' && row.name !== null && row.name.trim().length > 0);
const lookup = (
  row:
    | {
        readonly currentRevision: number;
        readonly description: string | null;
        readonly name: string | null;
        readonly state: string;
      }
    | undefined,
  locale: string,
): LocalizedFactLookup =>
  row === undefined || row.state === 'REMOVED'
    ? { kind: 'MISSING_TRANSLATION', locale, revision: row?.currentRevision ?? 0 }
    : {
        kind: 'PRESENT',
        locale,
        revision: row.currentRevision,
        ...(row.name === null ? {} : { name: row.name }),
        ...(row.description === null ? {} : { description: row.description }),
      };

/** Core installs tenant scope before constructing this transaction-bound owner service. */
export const localizedProductFactsPersistenceForScope = (transaction: ScopedTransaction, scope: OperationalScope) => {
  const { tenantId } = scope;
  const productWhere = (productId: string, locale: string) =>
    and(
      eq(productLocalizedFacts.tenantId, tenantId),
      eq(productLocalizedFacts.productId, productId),
      eq(productLocalizedFacts.locale, locale),
    );
  const variantWhere = (productId: string, variantId: string, locale: string) =>
    and(
      eq(variantLocalizedFacts.tenantId, tenantId),
      eq(variantLocalizedFacts.productId, productId),
      eq(variantLocalizedFacts.variantId, variantId),
      eq(variantLocalizedFacts.locale, locale),
    );
  const readProduct = Effect.fn('LocalizedFacts.readProduct')(function* readProduct(ref: ProductRef, locale: string) {
    if (!validProduct(ref, tenantId) || !canonicalLocale(locale)) {
      return { kind: 'MISSING_TRANSLATION', locale, revision: 0 } as const;
    }
    const [owner] = yield* transaction
      .select({ productId: products.productId })
      .from(products)
      .where(and(eq(products.tenantId, tenantId), eq(products.productId, ref.resourceId)))
      .limit(1);
    if (owner === undefined) {
      return { kind: 'MISSING_TRANSLATION', locale, revision: 0 } as const;
    }
    const [row] = yield* transaction
      .select()
      .from(productLocalizedFacts)
      .where(productWhere(ref.resourceId, locale))
      .limit(1);
    return lookup(row, locale);
  }, Effect.mapError(unavailable));
  const readVariant = Effect.fn('LocalizedFacts.readVariant')(function* readVariant(
    productRef: ProductRef,
    variantRef: VariantRef,
    locale: string,
  ) {
    if (!validProduct(productRef, tenantId) || !validVariant(variantRef, tenantId) || !canonicalLocale(locale)) {
      return { kind: 'MISSING_TRANSLATION', locale, revision: 0 } as const;
    }
    const [owner] = yield* transaction
      .select({ variantId: productVariants.variantId })
      .from(productVariants)
      .where(
        and(
          eq(productVariants.tenantId, tenantId),
          eq(productVariants.productId, productRef.resourceId),
          eq(productVariants.variantId, variantRef.resourceId),
        ),
      )
      .limit(1);
    if (owner === undefined) {
      return { kind: 'MISSING_TRANSLATION', locale, revision: 0 } as const;
    }
    const [row] = yield* transaction
      .select()
      .from(variantLocalizedFacts)
      .where(variantWhere(productRef.resourceId, variantRef.resourceId, locale))
      .limit(1);
    return lookup(row, locale);
  }, Effect.mapError(unavailable));
  /* oxlint-disable eslint/complexity -- One transactional CAS includes owner lock, invocation replay, ACTIVE-name invariant and append-only evidence; one point over advisory threshold. expires: 2027-03-31. */
  const changeProduct = Effect.fn('LocalizedFacts.changeProduct')(function* changeProduct(
    input: ProductLocalizedChange,
  ): Effect.fn.Return<LocalizedFactOutcome, LocalizedFactsPersistenceUnavailable> {
    if (!validProduct(input.productRef, tenantId) || !validChange(input)) {
      return { kind: 'INVALID' };
    }
    const productId = input.productRef.resourceId;
    const [owner] = yield* transaction
      .select({ lifecycleState: products.lifecycleState, productId: products.productId })
      .from(products)
      .where(and(eq(products.tenantId, tenantId), eq(products.productId, productId)))
      .for('update')
      .limit(1)
      .pipe(Effect.mapError(unavailable));
    if (owner === undefined) {
      return { kind: 'NOT_FOUND' };
    }
    const [prior] = yield* transaction
      .select()
      .from(productLocalizedFactRevisions)
      .where(
        and(
          eq(productLocalizedFactRevisions.tenantId, tenantId),
          eq(productLocalizedFactRevisions.actionInvocationId, input.actionInvocationId),
        ),
      )
      .limit(1)
      .pipe(Effect.mapError(unavailable));
    const value = rowValue(input);
    if (prior !== undefined) {
      return prior.productId === productId &&
        prior.locale === input.locale &&
        prior.state === value.state &&
        prior.name === value.name &&
        prior.description === value.description &&
        prior.actingPrincipalId === input.principalId &&
        prior.revision === input.expectedRevision + 1 &&
        prior.reason === input.reason &&
        Equal.equals(prior.evidenceRefs, input.evidenceRefs)
        ? { kind: 'REPLAYED', revision: prior.revision }
        : { kind: 'INVALID' };
    }
    const [current] = yield* transaction
      .select()
      .from(productLocalizedFacts)
      .where(productWhere(productId, input.locale))
      .for('update')
      .limit(1)
      .pipe(Effect.mapError(unavailable));
    const actualRevision = current?.currentRevision ?? 0;
    if (actualRevision !== input.expectedRevision) {
      return { kind: 'STALE', actualRevision };
    }
    if (owner.lifecycleState === 'ACTIVE') {
      const locales = yield* transaction
        .select({
          locale: productLocalizedFacts.locale,
          name: productLocalizedFacts.name,
          state: productLocalizedFacts.state,
        })
        .from(productLocalizedFacts)
        .where(and(eq(productLocalizedFacts.tenantId, tenantId), eq(productLocalizedFacts.productId, productId)))
        .pipe(Effect.mapError(unavailable));
      const otherUsableName = hasOtherName(locales, input.locale);
      if (!otherUsableName && value.name === null) {
        return { kind: 'TEXT_MINIMUM_CONFLICT' };
      }
    }
    const revision = actualRevision + 1;
    if (current === undefined) {
      yield* transaction
        .insert(productLocalizedFacts)
        .values({ tenantId, productId, locale: input.locale, currentRevision: revision, ...value })
        .pipe(Effect.mapError(unavailable));
    } else {
      const updatedAt = DateTime.toDate(yield* DateTime.now);
      yield* transaction
        .update(productLocalizedFacts)
        .set({ currentRevision: revision, updatedAt, ...value })
        .where(productWhere(productId, input.locale))
        .pipe(Effect.mapError(unavailable));
    }
    yield* transaction
      .insert(productLocalizedFactRevisions)
      .values({
        locale: input.locale,
        productId,
        revision,
        tenantId,
        ...value,
        actingPrincipalId: input.principalId,
        actionInvocationId: input.actionInvocationId,
        evidenceRefs: [...input.evidenceRefs],
        reason: input.reason,
      })
      .pipe(Effect.mapError(unavailable));
    return { kind: 'CHANGED', revision };
  });
  /* oxlint-enable eslint/complexity */
  const changeVariant = Effect.fn('LocalizedFacts.changeVariant')(function* changeVariant(
    input: VariantLocalizedChange,
  ): Effect.fn.Return<LocalizedFactOutcome, LocalizedFactsPersistenceUnavailable> {
    if (!validProduct(input.productRef, tenantId) || !validVariant(input.variantRef, tenantId) || !validChange(input)) {
      return { kind: 'INVALID' };
    }
    const productId = input.productRef.resourceId;
    const variantId = input.variantRef.resourceId;
    const [owner] = yield* transaction
      .select({ variantId: productVariants.variantId })
      .from(productVariants)
      .where(
        and(
          eq(productVariants.tenantId, tenantId),
          eq(productVariants.productId, productId),
          eq(productVariants.variantId, variantId),
        ),
      )
      .for('update')
      .limit(1)
      .pipe(Effect.mapError(unavailable));
    if (owner === undefined) {
      return { kind: 'NOT_FOUND' };
    }
    const [prior] = yield* transaction
      .select()
      .from(variantLocalizedFactRevisions)
      .where(
        and(
          eq(variantLocalizedFactRevisions.tenantId, tenantId),
          eq(variantLocalizedFactRevisions.actionInvocationId, input.actionInvocationId),
        ),
      )
      .limit(1)
      .pipe(Effect.mapError(unavailable));
    const value = rowValue(input);
    if (prior !== undefined) {
      return prior.productId === productId &&
        prior.variantId === variantId &&
        prior.locale === input.locale &&
        prior.state === value.state &&
        prior.name === value.name &&
        prior.description === value.description &&
        prior.actingPrincipalId === input.principalId &&
        prior.revision === input.expectedRevision + 1 &&
        prior.reason === input.reason &&
        Equal.equals(prior.evidenceRefs, input.evidenceRefs)
        ? { kind: 'REPLAYED', revision: prior.revision }
        : { kind: 'INVALID' };
    }
    const [current] = yield* transaction
      .select()
      .from(variantLocalizedFacts)
      .where(variantWhere(productId, variantId, input.locale))
      .for('update')
      .limit(1)
      .pipe(Effect.mapError(unavailable));
    const actualRevision = current?.currentRevision ?? 0;
    if (actualRevision !== input.expectedRevision) {
      return { kind: 'STALE', actualRevision };
    }
    const revision = actualRevision + 1;
    if (current === undefined) {
      yield* transaction
        .insert(variantLocalizedFacts)
        .values({ tenantId, productId, variantId, locale: input.locale, currentRevision: revision, ...value })
        .pipe(Effect.mapError(unavailable));
    } else {
      const updatedAt = DateTime.toDate(yield* DateTime.now);
      yield* transaction
        .update(variantLocalizedFacts)
        .set({ currentRevision: revision, updatedAt, ...value })
        .where(variantWhere(productId, variantId, input.locale))
        .pipe(Effect.mapError(unavailable));
    }
    yield* transaction
      .insert(variantLocalizedFactRevisions)
      .values({
        locale: input.locale,
        productId,
        revision,
        tenantId,
        variantId,
        ...value,
        actingPrincipalId: input.principalId,
        actionInvocationId: input.actionInvocationId,
        evidenceRefs: [...input.evidenceRefs],
        reason: input.reason,
      })
      .pipe(Effect.mapError(unavailable));
    return { kind: 'CHANGED', revision };
  });
  return { changeProduct, changeVariant, readProduct, readVariant };
};
