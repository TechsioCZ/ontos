import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { DateTime, Effect, Option, Schema } from 'effect';
import { and, asc, eq, inArray } from 'drizzle-orm';

import { ReviseProductTypeResultSchema } from '../../shared/actions/revise-product-type.ts';
import type { CartOpenSelectionPopulationPort } from '../../shared/domain/catalog-open-selection-population.ts';
import { canonicalizeProductTypeMeaning } from '../../shared/domain/product-type-meaning.ts';
import type { ProductTypeAttributeRule } from '../../shared/domain/product-type-rules.ts';
import type { CatalogRevisionNumber } from '../../shared/domain/catalog-revision-reference.ts';
import { CatalogRevisionNumberSchema } from '../../shared/domain/catalog-revision-reference.ts';
import type { ProductRef } from '../../shared/resources/product.ts';
import type { ProductTypeRef } from '../../shared/resources/product-type.ts';
import {
  attributeDefinitions,
  productTypeRevisionAttributes,
  productTypeRevisions,
  productTypes,
} from '../database/schema.ts';
import { validProductTypeRuleDefinitions } from './product-type-create-persistence.ts';
import type { ProductTypeImpactScanIncomplete } from './product-type-impact-scan.ts';
import { productTypeImpactScanForScope } from './product-type-impact-scan.ts';
import { CatalogPersistenceUnavailable } from './errors.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];

interface ReviseProductTypePersistenceInput {
  readonly actionInvocationId: string;
  readonly effectiveFrom: string;
  readonly expectedCurrentRevision: number;
  readonly impactBasisToken: string;
  readonly principalId: string;
  readonly productTypeRef: ProductTypeRef;
  readonly proposedRules: readonly ProductTypeAttributeRule[];
  readonly unresolvedProductRefs: readonly ProductRef[];
}

const ReviseProductTypePersistenceOutcomeSchema = Schema.Union([
  Schema.TaggedStruct('revised', { result: ReviseProductTypeResultSchema }),
  Schema.TaggedStruct('not_found', {}),
  Schema.TaggedStruct('stale_basis', { reason: Schema.String }),
]);
export type ReviseProductTypePersistenceOutcome = typeof ReviseProductTypePersistenceOutcomeSchema.Type;

/** The complete Catalog and Cart owner basis cannot currently be established. */
export class ProductTypeImpactBasisUnavailable extends Schema.TaggedError<ProductTypeImpactBasisUnavailable>()(
  'ProductTypeImpactBasisUnavailable',
  {
    code: Schema.Literal('product_type_impact_basis_unavailable'),
    reason: Schema.String,
  },
) {}

export interface ProductTypeRevisePersistence {
  readonly revise: (
    input: ReviseProductTypePersistenceInput,
  ) => Effect.Effect<
    ReviseProductTypePersistenceOutcome,
    ProductTypeImpactBasisUnavailable | CatalogPersistenceUnavailable
  >;
}

const unavailable = (cause: unknown): CatalogPersistenceUnavailable => {
  const failure = new CatalogPersistenceUnavailable({
    code: 'catalog_persistence_unavailable',
    reason: 'Catalog persistence is temporarily unavailable',
  });
  Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  return failure;
};

const impactUnavailable = (failure: ProductTypeImpactScanIncomplete): ProductTypeImpactBasisUnavailable => {
  const unavailableBasis = new ProductTypeImpactBasisUnavailable({
    code: 'product_type_impact_basis_unavailable',
    reason: failure.reason,
  });
  Object.defineProperty(unavailableBasis, 'cause', { configurable: true, value: failure });
  return unavailableBasis;
};

const sameIds = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

/**
 * Resolves one canonical Product Type meaning for the proposed revision. Category, channel,
 * Package and Set facts are absent by construction and are never used to infer these rules.
 */
export const canonicalProductTypeRevision = (
  productTypeRef: ProductTypeRef,
  revision: CatalogRevisionNumber,
  rules: readonly ProductTypeAttributeRule[],
) => canonicalizeProductTypeMeaning({ productTypeRef, revision, rules });

/**
 * Rechecks the complete impact basis inside Core's transaction, then appends one immutable rules
 * revision and advances the Product Type pointer with compare-and-swap semantics. The Cart owner
 * population is an injected public port; absence or owner failure remains typed and fail-closed.
 */
export const productTypeRevisePersistenceForScope = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
  authoritativeBasis: { readonly openSelections?: CartOpenSelectionPopulationPort } = {},
): Effect.Effect<ProductTypeRevisePersistence> => {
  const { tenantId } = scope;
  const impactScan = productTypeImpactScanForScope(transaction, scope, authoritativeBasis);

  const revise: ProductTypeRevisePersistence['revise'] = Effect.fn('ProductTypeRevisePersistence.revise')(
    function* revise(input) {
      if (input.productTypeRef.tenantId !== tenantId) {
        return { _tag: 'stale_basis', reason: 'Product Type is outside the trusted Tenant' };
      }

      const nextRevision = input.expectedCurrentRevision + 1;
      if (!Number.isSafeInteger(nextRevision)) {
        return { _tag: 'stale_basis', reason: 'The next Product Type revision cannot be represented safely' };
      }
      const decodedNextRevision = yield* Schema.decodeEffect(CatalogRevisionNumberSchema)(nextRevision).pipe(
        Effect.mapError(unavailable),
      );
      const meaning = canonicalProductTypeRevision(input.productTypeRef, decodedNextRevision, input.proposedRules);
      const candidateRules = meaning.rules.map((rule) => ({
        attributeDefinitionId: rule.attributeDefinitionRef.resourceId,
        level: rule.level,
        required: rule.required,
      }));
      const impact = yield* impactScan
        .scan({
          candidateRules,
          expectedCurrentRevision: input.expectedCurrentRevision,
          productTypeId: input.productTypeRef.resourceId,
        })
        .pipe(Effect.catchTag('ProductTypeImpactScanIncomplete', (failure) => Effect.fail(impactUnavailable(failure))));

      const unresolvedProductIds = input.unresolvedProductRefs
        .map((ref) => ref.resourceId)
        .toSorted((left, right) => left.localeCompare(right, 'en'));
      if (
        impact.token !== input.impactBasisToken ||
        !sameIds(unresolvedProductIds, impact.preview.affectedProductIds)
      ) {
        return {
          _tag: 'stale_basis',
          reason: 'The impact preview no longer matches the complete Current Product population',
        };
      }

      const [current] = yield* transaction
        .select({ currentRevision: productTypes.currentRevision })
        .from(productTypes)
        .where(
          and(eq(productTypes.tenantId, tenantId), eq(productTypes.productTypeId, input.productTypeRef.resourceId)),
        )
        .for('update')
        .limit(1)
        .pipe(Effect.mapError(unavailable));
      if (current === undefined) {
        return { _tag: 'not_found' };
      }
      if (
        current.currentRevision !== input.expectedCurrentRevision ||
        impact.sourceRevision !== current.currentRevision
      ) {
        return { _tag: 'stale_basis', reason: 'The Product Type Current revision changed' };
      }

      if (meaning.rules.length > 0) {
        const definitionIds = [
          ...new Set(meaning.rules.map((rule) => rule.attributeDefinitionRef.resourceId)),
        ].toSorted();
        const definitions = yield* transaction
          .select({
            applicableLevels: attributeDefinitions.applicableLevels,
            attributeDefinitionId: attributeDefinitions.attributeDefinitionId,
            tenantId: attributeDefinitions.tenantId,
          })
          .from(attributeDefinitions)
          .where(
            and(
              eq(attributeDefinitions.tenantId, tenantId),
              inArray(attributeDefinitions.attributeDefinitionId, definitionIds),
            ),
          )
          .orderBy(asc(attributeDefinitions.attributeDefinitionId))
          .for('share')
          .pipe(Effect.mapError(unavailable));
        if (!validProductTypeRuleDefinitions(meaning.rules, definitions, tenantId)) {
          return {
            _tag: 'stale_basis',
            reason: 'Referenced Attribute Definitions are absent or no longer permit the requested levels',
          };
        }
      }

      const effectiveAt = DateTime.make(input.effectiveFrom);
      if (Option.isNone(effectiveAt)) {
        return { _tag: 'stale_basis', reason: 'The Product Type effective instant is invalid' };
      }
      const recordedAt = yield* DateTime.now;
      if (DateTime.toEpochMillis(effectiveAt.value) > DateTime.toEpochMillis(recordedAt)) {
        return {
          _tag: 'stale_basis',
          reason: 'A future Product Type revision cannot become Current before its effective instant',
        };
      }
      yield* transaction
        .insert(productTypeRevisions)
        .values({
          actingPrincipalId: input.principalId,
          actionInvocationId: input.actionInvocationId,
          effectiveAt: DateTime.toDateUtc(effectiveAt.value),
          productTypeId: input.productTypeRef.resourceId,
          reason:
            unresolvedProductIds.length === 0
              ? 'Product Type rules revised'
              : 'Product Type rules revised with unresolved remediation',
          revision: nextRevision,
          tenantId,
        })
        .pipe(Effect.mapError(unavailable));
      if (meaning.rules.length > 0) {
        yield* transaction
          .insert(productTypeRevisionAttributes)
          .values(
            meaning.rules.map((rule) => ({
              attributeDefinitionId: rule.attributeDefinitionRef.resourceId,
              level: rule.level,
              productTypeId: input.productTypeRef.resourceId,
              requirement: rule.required ? 'REQUIRED' : 'OPTIONAL',
              revision: nextRevision,
              tenantId,
            })),
          )
          .pipe(Effect.mapError(unavailable));
      }
      const [updated] = yield* transaction
        .update(productTypes)
        .set({ currentRevision: nextRevision, updatedAt: DateTime.toDateUtc(recordedAt) })
        .where(
          and(
            eq(productTypes.tenantId, tenantId),
            eq(productTypes.productTypeId, input.productTypeRef.resourceId),
            eq(productTypes.currentRevision, input.expectedCurrentRevision),
          ),
        )
        .returning({ currentRevision: productTypes.currentRevision })
        .pipe(Effect.mapError(unavailable));
      if (updated?.currentRevision !== nextRevision) {
        return { _tag: 'stale_basis', reason: 'The Product Type Current revision changed' };
      }

      const result = yield* Schema.decodeEffect(ReviseProductTypeResultSchema)({
        effectiveFrom: input.effectiveFrom,
        productTypeRef: input.productTypeRef,
        revision: nextRevision,
        unresolvedProductRefs: input.unresolvedProductRefs,
      }).pipe(Effect.mapError(unavailable));
      return { _tag: 'revised', result };
    },
  );

  return Effect.succeed({ revise });
};
