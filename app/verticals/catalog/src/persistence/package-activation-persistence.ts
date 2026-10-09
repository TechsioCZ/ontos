import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { and, eq } from 'drizzle-orm';
import { DateTime, Effect, Match, Option, Schema } from 'effect';

import { PackageDefinitionContentInputSchema } from '../../shared/actions/package-definition-contract.ts';
import {
  packageContentRevisions,
  packageDefinitions,
  packageOptionRoleRevisions,
  productVariants,
  products,
} from '../database/schema.ts';
import { validPackageOptionRoleFinding } from './package-option-persistence.ts';
import type { PackageOptionRoleBasis, PackageOptionRoleFinding } from './package-option-persistence.ts';
import { resolveEffectiveRevision } from './package-persistence.ts';
import type { PackageContentBasis } from './package-persistence.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];

export class PackageActivationUnavailable extends Schema.TaggedError<PackageActivationUnavailable>()(
  'PackageActivationUnavailable',
  { code: Schema.Literal('package_activation_unavailable'), reason: Schema.String },
) {}

/** An owner-issued proof that this transition preserves every already-issued selection. */
export interface PackageActivationSelectionImpact {
  readonly verify: (input: {
    readonly packageDefinitionId: string;
    readonly revision: number;
    readonly tenantId: string;
  }) => Effect.Effect<boolean, PackageActivationUnavailable>;
}

export interface PackageActivationInput {
  readonly actionInvocationId: string;
  readonly evidenceRefs: readonly string[];
  readonly expectedRevision: number;
  readonly packageDefinitionId: string;
  readonly principalId: string;
  readonly reason: string;
}

/** Promotion is a separate governed operation, never Draft activation. */
export interface PackagePromotionInput extends PackageActivationInput {
  readonly expectedOptionRevision: number;
  readonly successorRevision: number;
}

export interface PackagePromotionSelectionImpact {
  readonly verify: (input: {
    readonly packageDefinitionId: string;
    readonly priorRevision: number;
    readonly successorRevision: number;
    readonly tenantId: string;
  }) => Effect.Effect<boolean, PackageActivationUnavailable>;
}

const unavailable = (cause?: unknown): PackageActivationUnavailable => {
  const failure = new PackageActivationUnavailable({
    code: 'package_activation_unavailable',
    reason: 'Authoritative Package activation basis or persistence is unavailable',
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

const validEvidence = (input: PackageActivationInput): boolean =>
  input.actionInvocationId.length > 0 &&
  input.principalId.length > 0 &&
  Number.isSafeInteger(input.expectedRevision) &&
  input.expectedRevision > 0 &&
  input.reason.length > 0 &&
  input.reason.length <= 1000 &&
  input.reason === input.reason.trim() &&
  input.evidenceRefs.length > 0 &&
  input.evidenceRefs.every((ref) => ref.length > 0 && ref.length <= 300 && ref === ref.trim());
const validPromotionInput = (input: PackagePromotionInput): boolean =>
  validEvidence(input) &&
  Number.isSafeInteger(input.expectedOptionRevision) &&
  input.expectedOptionRevision >= 0 &&
  Number.isSafeInteger(input.successorRevision) &&
  input.successorRevision === input.expectedRevision + 1;

type Definition = typeof packageDefinitions.$inferSelect;
type Content = typeof packageContentRevisions.$inferSelect;
const stalePromotion = (definition: Definition, input: PackagePromotionInput): boolean =>
  definition.currentRevision !== input.expectedRevision ||
  definition.currentOptionRevision !== input.expectedOptionRevision;
const activeParents = (productState: string | undefined, variantState: string | undefined): boolean =>
  productState === 'ACTIVE' && variantState === 'ACTIVE';
const validDraftContent = (content: Content, definition: Definition): boolean =>
  content.lifecycleState === 'DRAFT' &&
  content.productId === definition.productId &&
  content.variantId === definition.variantId &&
  content.unitResourceType === 'commerce.catalog.product-unit' &&
  (content.lowerPackageDefinitionId === null) === (content.lowerRevision === null) &&
  (content.lowerPackageDefinitionId === null) === (content.lowerCount === null);
const validSuccessorContent = (content: Content, definition: Definition): boolean =>
  content.lifecycleState === 'ACTIVE' &&
  content.productId === definition.productId &&
  content.variantId === definition.variantId &&
  content.unitResourceType === 'commerce.catalog.product-unit' &&
  (content.lowerPackageDefinitionId === null) === (content.lowerRevision === null) &&
  (content.lowerPackageDefinitionId === null) === (content.lowerCount === null);
const ref = (tenantId: string, resourceType: string, resourceId: string) => ({
  moduleId: 'commerce.catalog',
  resourceId,
  resourceType: `commerce.catalog.${resourceType}`,
  tenantId,
});
const decodeContent = (content: Content, definition: Definition) => {
  const { tenantId } = definition;
  const raw = {
    amount: content.amount,
    effectiveAt: content.effectiveAt.toISOString(),
    form: {
      productRef: ref(tenantId, 'product', definition.productId),
      variantRef: ref(tenantId, 'variant', definition.variantId),
    },
    unitRef: ref(tenantId, 'product-unit', content.unitResourceId),
  };
  const withConfiguration =
    content.configurationKey === null ? raw : { ...raw, configurationKey: content.configurationKey };
  const withLower =
    content.lowerPackageDefinitionId === null
      ? withConfiguration
      : {
          ...withConfiguration,
          lower: {
            count: content.lowerCount,
            revision: {
              resourceRef: ref(tenantId, 'package-definition', content.lowerPackageDefinitionId),
              revision: content.lowerRevision,
            },
          },
        };
  const withSet =
    content.setCompositionResourceId === null
      ? withLower
      : {
          ...withLower,
          setComposition: {
            resourceRef: ref(tenantId, 'set-composition', content.setCompositionResourceId),
            revision: content.setCompositionRevision,
          },
        };
  return Schema.decodeUnknownEffect(PackageDefinitionContentInputSchema)(withSet).pipe(Effect.mapError(unavailable));
};

const pinnedLowerActive = (
  transaction: ScopedTransaction,
  definition: Definition,
  lowerId: string | null,
  lowerRevision: number | null,
  seen: ReadonlySet<string>,
): Effect.Effect<boolean, PackageActivationUnavailable> =>
  Effect.suspend(() =>
    Effect.gen(function* pinnedLowerActiveStep() {
      if (lowerId === null && lowerRevision === null) {
        return true;
      }
      if (lowerId === null || lowerRevision === null || seen.has(lowerId)) {
        return false;
      }
      const { tenantId } = definition;
      const [[lowerDefinition], [lowerContent]] = yield* Effect.all(
        [
          transaction
            .select()
            .from(packageDefinitions)
            .where(and(eq(packageDefinitions.tenantId, tenantId), eq(packageDefinitions.packageDefinitionId, lowerId)))
            .for('update')
            .limit(1),
          transaction
            .select()
            .from(packageContentRevisions)
            .where(
              and(
                eq(packageContentRevisions.tenantId, tenantId),
                eq(packageContentRevisions.packageDefinitionId, lowerId),
                eq(packageContentRevisions.revision, lowerRevision),
              ),
            )
            .for('update')
            .limit(1),
        ] as const,
        { concurrency: 1 },
      ).pipe(Effect.mapError(unavailable));
      if (
        lowerDefinition?.lifecycleState !== 'ACTIVE' ||
        lowerContent?.lifecycleState !== 'ACTIVE' ||
        lowerDefinition.productId !== definition.productId ||
        lowerDefinition.variantId !== definition.variantId ||
        lowerContent.productId !== definition.productId ||
        lowerContent.variantId !== definition.variantId
      ) {
        return false;
      }
      return yield* pinnedLowerActive(
        transaction,
        definition,
        lowerContent.lowerPackageDefinitionId,
        lowerContent.lowerRevision,
        new Set([...seen, lowerId]),
      );
    }).pipe(Effect.withSpan('PackageActivationPersistence.pinnedLowerActive')),
  );

const promotionRoleFinding = Effect.fn('PackageActivationPersistence.promotionRoleFinding')(
  function* promotionRoleFinding(
    transaction: ScopedTransaction,
    definition: Definition,
    successorRevision: number,
    roleBasis: PackageOptionRoleBasis | undefined,
  ) {
    if (definition.optionState === 'RETIRED' && definition.currentOptionRevision < 1) {
      return yield* unavailable();
    }
    if (definition.optionState !== 'ACTIVE') {
      return Option.none<PackageOptionRoleFinding>();
    }
    if (roleBasis === undefined || definition.currentOptionRevision < 1) {
      return yield* unavailable();
    }
    const [priorRole] = yield* transaction
      .select()
      .from(packageOptionRoleRevisions)
      .where(
        and(
          eq(packageOptionRoleRevisions.tenantId, definition.tenantId),
          eq(packageOptionRoleRevisions.packageDefinitionId, definition.packageDefinitionId),
          eq(packageOptionRoleRevisions.revision, definition.currentOptionRevision),
        ),
      )
      .for('update')
      .limit(1)
      .pipe(Effect.mapError(unavailable));
    if (
      priorRole?.state !== 'ACTIVE' ||
      priorRole.contentRevision !== definition.currentRevision ||
      priorRole.productId !== definition.productId ||
      priorRole.variantId !== definition.variantId
    ) {
      return yield* unavailable();
    }
    const finding = yield* roleBasis
      .verify({
        contentRevision: successorRevision,
        packageDefinitionId: definition.packageDefinitionId,
        productId: definition.productId,
        tenantId: definition.tenantId,
        variantId: definition.variantId,
      })
      .pipe(Effect.mapError(unavailable));
    if (
      Option.isNone(finding) ||
      !validPackageOptionRoleFinding(finding.value) ||
      !finding.value.independentlyRequested ||
      finding.value.looseUnitsSubstitutable
    ) {
      return yield* unavailable();
    }
    return finding;
  },
);

/** Core supplies the scoped transaction; this service never opens or commits one. */
export const packageActivationPersistenceForScope = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
  contentBasis?: PackageContentBasis,
  selectionImpact?: PackageActivationSelectionImpact,
  promotionImpact?: PackagePromotionSelectionImpact,
  roleBasis?: PackageOptionRoleBasis,
) => ({
  activate: Effect.fn('PackageActivationPersistence.activate')(function* activate(input: PackageActivationInput) {
    const { tenantId } = scope;
    if (!validEvidence(input)) {
      return { _tag: 'invalid', reason: 'Invalid Package activation evidence or revision' } as const;
    }
    const [definition] = yield* transaction
      .select()
      .from(packageDefinitions)
      .where(
        and(
          eq(packageDefinitions.tenantId, tenantId),
          eq(packageDefinitions.packageDefinitionId, input.packageDefinitionId),
        ),
      )
      .for('update')
      .limit(1)
      .pipe(Effect.mapError(unavailable));
    if (definition === undefined) {
      return { _tag: 'not_found' } as const;
    }
    if (definition.currentRevision !== input.expectedRevision) {
      return { _tag: 'stale', actualRevision: definition.currentRevision } as const;
    }
    if (definition.lifecycleState !== 'DRAFT' || definition.optionState !== 'NOT_SELECTABLE') {
      return { _tag: 'invalid', reason: 'Only a non-selectable Draft Package Definition can activate' } as const;
    }
    if (contentBasis === undefined || selectionImpact === undefined) {
      return yield* unavailable();
    }
    const now = DateTime.toDateUtc(yield* DateTime.now);
    const revisions = yield* transaction
      .select()
      .from(packageContentRevisions)
      .where(
        and(
          eq(packageContentRevisions.tenantId, tenantId),
          eq(packageContentRevisions.packageDefinitionId, definition.packageDefinitionId),
        ),
      )
      .for('update')
      .pipe(Effect.mapError(unavailable));
    const effectiveRevision = yield* Match.value(resolveEffectiveRevision(revisions, now)).pipe(
      Match.tag('invalid', () => Effect.fail(unavailable())),
      Match.tag('resolved', ({ revision }) => Effect.succeed(revision)),
      Match.exhaustive,
    );
    if (effectiveRevision !== definition.currentRevision) {
      return { _tag: 'stale', actualRevision: effectiveRevision } as const;
    }
    // Activation appends an immutable Active snapshot at currentRevision + 1.
    // A scheduled successor already owns that slot and cannot be replaced or skipped.
    if (revisions.length !== definition.currentRevision) {
      return { _tag: 'invalid', reason: 'Scheduled successor content prevents activation' } as const;
    }
    const content = revisions.find((row) => row.revision === effectiveRevision);
    if (content === undefined || !validDraftContent(content, definition)) {
      return yield* unavailable();
    }
    if (
      !(yield* pinnedLowerActive(
        transaction,
        definition,
        content.lowerPackageDefinitionId,
        content.lowerRevision,
        new Set([definition.packageDefinitionId]),
      ))
    ) {
      return {
        _tag: 'invalid',
        reason: 'Pinned lower content must be Current, active, homogeneous, and acyclic',
      } as const;
    }
    const [[product], [variant]] = yield* Effect.all(
      [
        transaction
          .select()
          .from(products)
          .where(and(eq(products.tenantId, tenantId), eq(products.productId, definition.productId)))
          .for('update')
          .limit(1),
        transaction
          .select()
          .from(productVariants)
          .where(
            and(
              eq(productVariants.tenantId, tenantId),
              eq(productVariants.productId, definition.productId),
              eq(productVariants.variantId, definition.variantId),
            ),
          )
          .for('update')
          .limit(1),
      ] as const,
      { concurrency: 1 },
    ).pipe(Effect.mapError(unavailable));
    if (product?.lifecycleState !== 'ACTIVE' || variant?.lifecycleState !== 'ACTIVE') {
      return { _tag: 'invalid', reason: 'Product and Variant must both be Current and active' } as const;
    }
    const candidate = yield* decodeContent(content, definition);
    if (
      !(yield* contentBasis
        .verify({ content: candidate, definitionId: definition.packageDefinitionId, tenantId })
        .pipe(Effect.mapError(unavailable)))
    ) {
      return { _tag: 'invalid', reason: 'Current Package content or Unit basis is invalid' } as const;
    }
    if (
      !(yield* selectionImpact.verify({
        packageDefinitionId: definition.packageDefinitionId,
        revision: definition.currentRevision,
        tenantId,
      }))
    ) {
      return { _tag: 'invalid', reason: 'Issued selection impact is not proven safe' } as const;
    }
    const [updated] = yield* transaction
      .update(packageDefinitions)
      .set({ currentRevision: definition.currentRevision + 1, lifecycleState: 'ACTIVE', updatedAt: now })
      .where(
        and(
          eq(packageDefinitions.tenantId, tenantId),
          eq(packageDefinitions.packageDefinitionId, definition.packageDefinitionId),
          eq(packageDefinitions.currentRevision, definition.currentRevision),
          eq(packageDefinitions.lifecycleState, 'DRAFT'),
        ),
      )
      .returning()
      .pipe(Effect.mapError(unavailable));
    if (updated === undefined) {
      return { _tag: 'stale', actualRevision: definition.currentRevision } as const;
    }
    yield* transaction
      .insert(packageContentRevisions)
      .values({
        actingPrincipalId: input.principalId,
        actionInvocationId: input.actionInvocationId,
        amount: content.amount,
        changeKind: 'physical_change',
        configurationKey: content.configurationKey,
        effectiveAt: now,
        evidenceRefs: [...input.evidenceRefs],
        lifecycleState: 'ACTIVE',
        lowerCount: content.lowerCount,
        lowerPackageDefinitionId: content.lowerPackageDefinitionId,
        lowerRevision: content.lowerRevision,
        packageDefinitionId: definition.packageDefinitionId,
        priorErrorExplanation: null,
        productId: definition.productId,
        reason: input.reason,
        revision: updated.currentRevision,
        setCompositionResourceId: content.setCompositionResourceId,
        setCompositionRevision: content.setCompositionRevision,
        tenantId,
        unitResourceId: content.unitResourceId,
        unitResourceType: content.unitResourceType,
        variantId: definition.variantId,
      })
      .pipe(Effect.mapError(unavailable));
    return { _tag: 'activated', revision: updated.currentRevision } as const;
  }),
  promote: Effect.fn('PackageActivationPersistence.promote')(function* promote(input: PackagePromotionInput) {
    const { tenantId } = scope;
    if (!validPromotionInput(input)) {
      return { _tag: 'invalid', reason: 'Invalid Package promotion evidence or revision' } as const;
    }
    const [definition] = yield* transaction
      .select()
      .from(packageDefinitions)
      .where(
        and(
          eq(packageDefinitions.tenantId, tenantId),
          eq(packageDefinitions.packageDefinitionId, input.packageDefinitionId),
        ),
      )
      .for('update')
      .limit(1)
      .pipe(Effect.mapError(unavailable));
    if (definition === undefined) {
      return { _tag: 'not_found' } as const;
    }
    if (stalePromotion(definition, input)) {
      return {
        _tag: 'stale',
        actualOptionRevision: definition.currentOptionRevision,
        actualRevision: definition.currentRevision,
      } as const;
    }
    if (definition.lifecycleState !== 'ACTIVE') {
      return { _tag: 'invalid', reason: 'Only an Active Package Definition can promote a successor' } as const;
    }
    if (contentBasis === undefined || promotionImpact === undefined) {
      return yield* unavailable();
    }
    const now = DateTime.toDateUtc(yield* DateTime.now);
    const revisions = yield* transaction
      .select()
      .from(packageContentRevisions)
      .where(
        and(
          eq(packageContentRevisions.tenantId, tenantId),
          eq(packageContentRevisions.packageDefinitionId, definition.packageDefinitionId),
        ),
      )
      .for('update')
      .pipe(Effect.mapError(unavailable));
    const effectiveRevision = yield* Match.value(resolveEffectiveRevision(revisions, now)).pipe(
      Match.tag('invalid', () => Effect.fail(unavailable())),
      Match.tag('resolved', ({ revision }) => Effect.succeed(revision)),
      Match.exhaustive,
    );
    if (revisions.length !== definition.currentRevision + 1) {
      return yield* unavailable();
    }
    const successorRevision = definition.currentRevision + 1;
    if (effectiveRevision !== successorRevision) {
      return { _tag: 'invalid', reason: 'Scheduled successor is not yet effective' } as const;
    }
    const successor = revisions.find((row) => row.revision === successorRevision);
    if (successor === undefined || !validSuccessorContent(successor, definition)) {
      return yield* unavailable();
    }
    if (
      !(yield* pinnedLowerActive(
        transaction,
        definition,
        successor.lowerPackageDefinitionId,
        successor.lowerRevision,
        new Set([definition.packageDefinitionId]),
      ))
    ) {
      return { _tag: 'invalid', reason: 'Pinned lower content is not active, homogeneous, and acyclic' } as const;
    }
    const [[product], [variant]] = yield* Effect.all(
      [
        transaction
          .select()
          .from(products)
          .where(and(eq(products.tenantId, tenantId), eq(products.productId, definition.productId)))
          .for('update')
          .limit(1),
        transaction
          .select()
          .from(productVariants)
          .where(
            and(
              eq(productVariants.tenantId, tenantId),
              eq(productVariants.productId, definition.productId),
              eq(productVariants.variantId, definition.variantId),
            ),
          )
          .for('update')
          .limit(1),
      ] as const,
      { concurrency: 1 },
    ).pipe(Effect.mapError(unavailable));
    if (!activeParents(product?.lifecycleState, variant?.lifecycleState)) {
      return { _tag: 'invalid', reason: 'Product and Variant must remain active' } as const;
    }
    const candidate = yield* decodeContent(successor, definition);
    if (
      !(yield* contentBasis
        .verify({ content: candidate, definitionId: definition.packageDefinitionId, tenantId })
        .pipe(Effect.mapError(unavailable)))
    ) {
      return { _tag: 'invalid', reason: 'Scheduled Package content basis is invalid' } as const;
    }
    if (
      !(yield* promotionImpact.verify({
        packageDefinitionId: definition.packageDefinitionId,
        priorRevision: definition.currentRevision,
        successorRevision,
        tenantId,
      }))
    ) {
      return { _tag: 'invalid', reason: 'Issued selection impact is not proven safe' } as const;
    }
    const roleFinding = yield* promotionRoleFinding(transaction, definition, successorRevision, roleBasis);
    const nextOptionRevision =
      definition.optionState === 'ACTIVE' ? definition.currentOptionRevision + 1 : definition.currentOptionRevision;
    const [updated] = yield* transaction
      .update(packageDefinitions)
      .set({ currentOptionRevision: nextOptionRevision, currentRevision: successorRevision, updatedAt: now })
      .where(
        and(
          eq(packageDefinitions.tenantId, tenantId),
          eq(packageDefinitions.packageDefinitionId, definition.packageDefinitionId),
          eq(packageDefinitions.currentRevision, definition.currentRevision),
          eq(packageDefinitions.currentOptionRevision, definition.currentOptionRevision),
          eq(packageDefinitions.lifecycleState, 'ACTIVE'),
          eq(packageDefinitions.optionState, definition.optionState),
        ),
      )
      .returning()
      .pipe(Effect.mapError(unavailable));
    if (updated === undefined) {
      return {
        _tag: 'stale',
        actualOptionRevision: definition.currentOptionRevision,
        actualRevision: definition.currentRevision,
      } as const;
    }
    if (Option.isSome(roleFinding)) {
      yield* transaction
        .insert(packageOptionRoleRevisions)
        .values({
          actingPrincipalId: input.principalId,
          actionInvocationId: input.actionInvocationId,
          contentRevision: successorRevision,
          effectiveAt: now,
          evidenceRefs: [...roleFinding.value.evidenceRefs],
          independentlyRequested: roleFinding.value.independentlyRequested,
          looseUnitsSubstitutable: roleFinding.value.looseUnitsSubstitutable,
          packageDefinitionId: definition.packageDefinitionId,
          productId: definition.productId,
          revision: nextOptionRevision,
          state: 'ACTIVE',
          tenantId,
          validationReason: roleFinding.value.validationReason,
          variantId: definition.variantId,
        })
        .pipe(Effect.mapError(unavailable));
    }
    return { _tag: 'promoted', optionRevision: nextOptionRevision, revision: successorRevision } as const;
  }),
});
export type PackageActivationPersistence = ReturnType<typeof packageActivationPersistenceForScope>;
