import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { and, eq } from 'drizzle-orm';
import { DateTime, Effect, Option, Schema } from 'effect';

import type { SetCompositionRevision } from '../../shared/domain/set-composition.ts';
import { SetCompositionRevisionSchema, classifySetCompositionChange } from '../../shared/domain/set-composition.ts';
import {
  setCompositionComponents,
  setCompositionRevisions,
  setCompositions,
  productVariants,
  products,
} from '../database/schema.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];
type RevisionRow = typeof setCompositionRevisions.$inferSelect;
interface ComponentSelectionInput {
  configuration?: unknown;
  packageOption?: {
    contentRevision: { resourceRef: ReturnType<typeof refForRow>; revision: number };
    optionRef: ReturnType<typeof refForRow>;
  };
  productRef: ReturnType<typeof refForRow>;
  variantRef: ReturnType<typeof refForRow>;
}
interface ReconstructedRevision {
  components: unknown[];
  predecessor?: { resourceRef: ReturnType<typeof refForRow>; revision: number };
  productRef: ReturnType<typeof refForRow>;
  provenance: { changeKind: string; evidenceRefs: string[]; reason: string };
  reference: { resourceRef: ReturnType<typeof refForRow>; revision: number };
  variantRef: ReturnType<typeof refForRow>;
}
const refForRow = (tenantId: string, resourceType: string, resourceId: string) => ({
  moduleId: 'commerce.catalog' as const,
  resourceId,
  resourceType,
  tenantId,
});
const compositionType = 'commerce.catalog.set-composition';
const productType = 'commerce.catalog.product';
const variantType = 'commerce.catalog.variant';

export class SetCompositionPersistenceUnavailable extends Schema.TaggedError<SetCompositionPersistenceUnavailable>()(
  'SetCompositionPersistenceUnavailable',
  { code: Schema.Literal('set_composition_persistence_unavailable'), reason: Schema.String },
) {}

/** The owner-local Current-basis service must prove complete exact non-Set selections and Units. */
export interface SetCompositionBasis {
  readonly verify: (input: {
    readonly at: Date;
    readonly revision: SetCompositionRevision;
  }) => Effect.Effect<boolean, SetCompositionPersistenceUnavailable>;
}

/**
 * #479 open-selection impact authority for an original-data-error correction. It must prove the
 * complete owner-confirmed open-selection population and its Catalog Current evidence; absent
 * owner evidence is a typed failure, never an assumed-empty population.
 */
export interface SetCompositionSelectionImpact {
  readonly verify: (input: {
    readonly at: Date;
    readonly compositionId: string;
    readonly previousRevision: number;
    readonly tenantId: string;
  }) => Effect.Effect<boolean, SetCompositionPersistenceUnavailable>;
}

export interface PublishSetCompositionInput {
  readonly actingPrincipalId: string;
  readonly actionInvocationId: string;
  readonly effectiveFrom: Date;
  readonly effectiveTo?: Date;
  readonly expectedRevision: number;
  readonly lifecycleState: 'DRAFT' | 'ACTIVE' | 'RETIRED';
  readonly revision: SetCompositionRevision;
}

const PublishSetCompositionOutcomeSchema = Schema.Union([
  Schema.TaggedStruct('published', { revision: Schema.Int }),
  Schema.TaggedStruct('invalid', { reason: Schema.String }),
  Schema.TaggedStruct('not_found', {}),
  Schema.TaggedStruct('stale', { actualRevision: Schema.Int }),
]);
type PublishSetCompositionOutcome = typeof PublishSetCompositionOutcomeSchema.Type;

interface StoredSetCompositionRevision {
  readonly effectiveFrom: Date;
  readonly effectiveTo?: Date;
  readonly lifecycleState: 'DRAFT' | 'ACTIVE' | 'RETIRED';
  readonly revision: SetCompositionRevision;
}

export interface SetCompositionPersistence {
  readonly publish: (
    input: PublishSetCompositionInput,
  ) => Effect.Effect<PublishSetCompositionOutcome, SetCompositionPersistenceUnavailable>;
  readonly readCurrent: (input: {
    readonly at: Date;
    readonly compositionId: string;
  }) => Effect.Effect<Option.Option<StoredSetCompositionRevision>, SetCompositionPersistenceUnavailable>;
  readonly readRevision: (input: {
    readonly compositionId: string;
    readonly revision: number;
  }) => Effect.Effect<Option.Option<StoredSetCompositionRevision>, SetCompositionPersistenceUnavailable>;
}

const unavailable = (cause?: unknown): SetCompositionPersistenceUnavailable => {
  const failure = new SetCompositionPersistenceUnavailable({
    code: 'set_composition_persistence_unavailable',
    reason: 'Authoritative Set composition basis or persistence is unavailable',
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

const sameRef = (
  ref: { readonly moduleId: string; readonly resourceType: string; readonly tenantId: string },
  tenantId: string,
  type: string,
) => ref.moduleId === 'commerce.catalog' && ref.tenantId === tenantId && ref.resourceType === type;
const validDate = (date: Date) => Option.isSome(DateTime.make(date));
const sameInstant = (left: Date | undefined, right: Date | undefined) =>
  left === undefined
    ? right === undefined
    : right !== undefined &&
      DateTime.toEpochMillis(DateTime.makeUnsafe(left)) === DateTime.toEpochMillis(DateTime.makeUnsafe(right));
const validEvidence = (values: readonly string[]) =>
  values.length > 0 && values.every((value) => value.length > 0 && value.length <= 300 && value.trim() === value);
const classificationFailure = (previous: SetCompositionRevision, next: SetCompositionRevision): string | undefined => {
  const changed = classifySetCompositionChange(previous, next);
  return (changed === 'MATERIAL_CHANGE' && next.provenance.changeKind !== 'MATERIAL_CHANGE') ||
    (changed === 'SAME_CONTENT' && next.provenance.changeKind !== 'EVIDENCE_CORRECTION')
    ? 'Change kind does not match exact component content'
    : undefined;
};
/**
 * #479 must authoritatively assess already-open selections before an original-data-error
 * correction can advance Current. An absent authority fails closed; never assume an empty set.
 */
const correctionImpactOutcome = Effect.fn('SetCompositionPersistence.correctionImpactOutcome')(
  function* correctionImpact(
    classification: ReturnType<typeof classifySetCompositionChange> | undefined,
    input: PublishSetCompositionInput,
    tenantId: string,
    selectionImpact: SetCompositionSelectionImpact | undefined,
  ): Effect.fn.Return<Option.Option<PublishSetCompositionOutcome>, SetCompositionPersistenceUnavailable> {
    if (classification !== 'EVIDENCE_CORRECTION') {
      return Option.none();
    }
    if (selectionImpact === undefined) {
      return Option.some({
        _tag: 'invalid',
        reason: 'Original-data-error correction requires open-selection impact authority',
      } as const);
    }
    const preserved = yield* selectionImpact
      .verify({
        at: input.effectiveFrom,
        compositionId: input.revision.reference.resourceRef.resourceId,
        previousRevision: input.expectedRevision,
        tenantId,
      })
      .pipe(Effect.mapError(unavailable));
    return preserved
      ? Option.none()
      : Option.some({
          _tag: 'invalid',
          reason: 'Original-data-error correction requires open-selection impact authority',
        } as const);
  },
);

const validPublishLineage = (input: PublishSetCompositionInput): boolean => {
  const { revision } = input;
  return (
    (input.expectedRevision === 0) === (revision.predecessor === undefined) &&
    (input.expectedRevision === 0 || revision.predecessor?.revision === input.expectedRevision) &&
    (input.expectedRevision === 0
      ? revision.provenance.changeKind === 'INITIAL'
      : revision.provenance.changeKind !== 'INITIAL')
  );
};
const validPublishInput = (input: PublishSetCompositionInput, tenantId: string): boolean => {
  const { revision } = input;
  return (
    Schema.is(SetCompositionRevisionSchema)(revision) &&
    sameRef(revision.reference.resourceRef, tenantId, compositionType) &&
    sameRef(revision.productRef, tenantId, productType) &&
    sameRef(revision.variantRef, tenantId, variantType) &&
    revision.reference.revisionId === undefined &&
    revision.predecessor?.revisionId === undefined &&
    Number.isSafeInteger(input.expectedRevision) &&
    input.expectedRevision >= 0 &&
    (input.lifecycleState !== 'RETIRED' || input.expectedRevision > 0) &&
    revision.reference.revision === input.expectedRevision + 1 &&
    validDate(input.effectiveFrom) &&
    (input.effectiveTo === undefined || (validDate(input.effectiveTo) && input.effectiveTo > input.effectiveFrom)) &&
    validEvidence(revision.provenance.evidenceRefs) &&
    input.actionInvocationId.length > 0 &&
    input.actingPrincipalId.length > 0 &&
    validPublishLineage(input)
  );
};

/** Core owns the transaction. All reads and writes retain an explicit trusted Tenant predicate. */
export const setCompositionPersistenceForScope = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
  basis?: SetCompositionBasis,
  selectionImpact?: SetCompositionSelectionImpact,
): SetCompositionPersistence => {
  const { tenantId } = scope;
  const load = Effect.fn('SetCompositionPersistence.load')(function* load(compositionId: string, revision: number) {
    const [owner] = yield* transaction
      .select()
      .from(setCompositions)
      .where(and(eq(setCompositions.tenantId, tenantId), eq(setCompositions.compositionId, compositionId)))
      .limit(1)
      .pipe(Effect.mapError(unavailable));
    if (owner === undefined) {
      return Option.none<StoredSetCompositionRevision>();
    }
    const [row] = yield* transaction
      .select()
      .from(setCompositionRevisions)
      .where(
        and(
          eq(setCompositionRevisions.tenantId, tenantId),
          eq(setCompositionRevisions.compositionId, compositionId),
          eq(setCompositionRevisions.revision, revision),
        ),
      )
      .limit(1)
      .pipe(Effect.mapError(unavailable));
    if (row === undefined) {
      return Option.none<StoredSetCompositionRevision>();
    }
    if (
      row.productId !== owner.productId ||
      row.variantId !== owner.variantId ||
      !['DRAFT', 'ACTIVE', 'RETIRED'].includes(row.lifecycleState)
    ) {
      return yield* unavailable();
    }
    const components = yield* transaction
      .select()
      .from(setCompositionComponents)
      .where(
        and(
          eq(setCompositionComponents.tenantId, tenantId),
          eq(setCompositionComponents.compositionId, compositionId),
          eq(setCompositionComponents.revision, revision),
        ),
      )
      .pipe(Effect.mapError(unavailable));
    const ref = (resourceType: string, resourceId: string) => refForRow(tenantId, resourceType, resourceId);
    const reconstructed: ReconstructedRevision = {
      components: components.map((component) => {
        const selection: ComponentSelectionInput = {
          productRef: ref(productType, component.componentProductId),
          variantRef: ref(variantType, component.componentVariantId),
        };
        if (component.packageDefinitionId !== null && component.packageContentRevision !== null) {
          selection.packageOption = {
            contentRevision: {
              resourceRef: ref('commerce.catalog.package-definition', component.packageDefinitionId),
              revision: component.packageContentRevision,
            },
            optionRef: ref('commerce.catalog.package-definition', component.packageDefinitionId),
          };
        }
        if (component.configuration !== null) {
          selection.configuration = component.configuration;
        }
        return {
          componentId: component.componentId,
          quantity: {
            amount: component.quantityAmount,
            unitRef: ref('commerce.catalog.product-unit', component.quantityUnitId),
          },
          selection,
        };
      }),
      productRef: ref(productType, owner.productId),
      provenance: { changeKind: row.changeKind, evidenceRefs: row.evidenceRefs, reason: row.reason },
      reference: { resourceRef: ref(compositionType, compositionId), revision: row.revision },
      variantRef: ref(variantType, owner.variantId),
    };
    if (row.predecessorRevision !== null) {
      reconstructed.predecessor = {
        resourceRef: ref(compositionType, compositionId),
        revision: row.predecessorRevision,
      };
    }
    const decoded = yield* Schema.decodeUnknownEffect(SetCompositionRevisionSchema)(reconstructed).pipe(
      Effect.mapError(unavailable),
    );
    let lifecycleState: StoredSetCompositionRevision['lifecycleState'] = 'RETIRED';
    if (row.lifecycleState === 'ACTIVE') {
      lifecycleState = 'ACTIVE';
    }
    if (row.lifecycleState === 'DRAFT') {
      lifecycleState = 'DRAFT';
    }
    const stored: StoredSetCompositionRevision = {
      effectiveFrom: row.effectiveFrom,
      lifecycleState,
      revision: decoded,
    };
    return Option.some(row.effectiveTo === null ? stored : { ...stored, effectiveTo: row.effectiveTo });
  });

  const inspectTarget = Effect.fn('SetCompositionPersistence.inspectTarget')(function* inspectTarget(
    input: PublishSetCompositionInput,
  ) {
    const { revision } = input;
    const compositionId = revision.reference.resourceRef.resourceId;
    const productId = revision.productRef.resourceId;
    const variantId = revision.variantRef.resourceId;
    const [product] = yield* transaction
      .select()
      .from(products)
      .where(and(eq(products.tenantId, tenantId), eq(products.productId, productId)))
      .for('update')
      .limit(1)
      .pipe(Effect.mapError(unavailable));
    if (product === undefined) {
      return { outcome: { _tag: 'not_found' } satisfies PublishSetCompositionOutcome };
    }
    // The lock order is deliberate: Variant is locked after its Product on the same transaction.
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
      .limit(1)
      .pipe(Effect.mapError(unavailable));
    if (variant === undefined) {
      return { outcome: { _tag: 'not_found' } satisfies PublishSetCompositionOutcome };
    }
    if (product.lifecycleState === 'RETIRED' || variant.lifecycleState === 'RETIRED') {
      return {
        outcome: { _tag: 'invalid', reason: 'Retired Set Product or Variant' } satisfies PublishSetCompositionOutcome,
      };
    }
    const [existing] = yield* transaction
      .select()
      .from(setCompositions)
      .where(and(eq(setCompositions.tenantId, tenantId), eq(setCompositions.compositionId, compositionId)))
      .for('update')
      .limit(1)
      .pipe(Effect.mapError(unavailable));
    if (input.expectedRevision === 0 && existing !== undefined) {
      return {
        outcome: { _tag: 'stale', actualRevision: existing.currentRevision } satisfies PublishSetCompositionOutcome,
      };
    }
    if (input.expectedRevision > 0 && existing === undefined) {
      return { outcome: { _tag: 'not_found' } satisfies PublishSetCompositionOutcome };
    }
    if (existing !== undefined && (existing.productId !== productId || existing.variantId !== variantId)) {
      return {
        outcome: {
          _tag: 'invalid',
          reason: 'Composition belongs to another exact Variant',
        } satisfies PublishSetCompositionOutcome,
      };
    }
    if (existing !== undefined && existing.currentRevision !== input.expectedRevision) {
      return {
        outcome: { _tag: 'stale', actualRevision: existing.currentRevision } satisfies PublishSetCompositionOutcome,
      };
    }
    let classification: ReturnType<typeof classifySetCompositionChange> | undefined;
    if (existing !== undefined) {
      const previous = yield* load(compositionId, input.expectedRevision);
      if (Option.isNone(previous)) {
        return yield* unavailable();
      }
      classification = classifySetCompositionChange(previous.value.revision, revision);
      const failure = classificationFailure(previous.value.revision, revision);
      if (failure !== undefined) {
        return {
          outcome: {
            _tag: 'invalid',
            reason: failure,
          } satisfies PublishSetCompositionOutcome,
        };
      }
      if (input.effectiveFrom <= previous.value.effectiveFrom) {
        return {
          outcome: {
            _tag: 'invalid',
            reason: 'Successor effectiveness must advance',
          } satisfies PublishSetCompositionOutcome,
        };
      }
    }
    return { classification, existing };
  });

  const publish: SetCompositionPersistence['publish'] = Effect.fn('SetCompositionPersistence.publish')(
    function* publish(input) {
      const { revision } = input;
      const compositionId = revision.reference.resourceRef.resourceId;
      const productId = revision.productRef.resourceId;
      const variantId = revision.variantRef.resourceId;
      if (!validPublishInput(input, tenantId)) {
        return { _tag: 'invalid', reason: 'Invalid Set identity, revision, effectiveness, or evidence' };
      }
      if (basis === undefined) {
        return yield* unavailable();
      }
      const [priorInvocation] = yield* transaction
        .select()
        .from(setCompositionRevisions)
        .where(
          and(
            eq(setCompositionRevisions.tenantId, tenantId),
            eq(setCompositionRevisions.actionInvocationId, input.actionInvocationId),
          ),
        )
        .limit(1)
        .pipe(Effect.mapError(unavailable));
      if (priorInvocation !== undefined) {
        if (
          priorInvocation.compositionId !== compositionId ||
          priorInvocation.revision !== revision.reference.revision
        ) {
          return { _tag: 'invalid', reason: 'Action invocation already belongs to another Set revision' };
        }
        const retained = yield* load(compositionId, priorInvocation.revision);
        if (Option.isNone(retained)) {
          return yield* unavailable();
        }
        const same = Schema.toEquivalence(SetCompositionRevisionSchema)(retained.value.revision, revision);
        if (
          !same ||
          priorInvocation.actingPrincipalId !== input.actingPrincipalId ||
          !sameInstant(retained.value.effectiveFrom, input.effectiveFrom) ||
          !sameInstant(retained.value.effectiveTo, input.effectiveTo) ||
          retained.value.lifecycleState !== input.lifecycleState
        ) {
          return { _tag: 'invalid', reason: 'Action invocation payload differs from retained Set revision' };
        }
        return { _tag: 'published', revision: priorInvocation.revision };
      }
      const inspected = yield* inspectTarget(input);
      if ('outcome' in inspected) {
        return inspected.outcome;
      }
      const { classification, existing } = inspected;
      const impactOutcome = yield* correctionImpactOutcome(classification, input, tenantId, selectionImpact);
      if (Option.isSome(impactOutcome)) {
        return impactOutcome.value;
      }
      if (
        !(yield* basis.verify({
          at: input.effectiveFrom,
          revision,
        }))
      ) {
        return { _tag: 'invalid', reason: 'Component Current basis is invalid' };
      }
      if (existing === undefined) {
        yield* transaction
          .insert(setCompositions)
          .values({ compositionId, currentRevision: 1, productId, tenantId, variantId })
          .pipe(Effect.mapError(unavailable));
      } else {
        const updated = yield* transaction
          .update(setCompositions)
          .set({ currentRevision: revision.reference.revision, updatedAt: DateTime.toDateUtc(yield* DateTime.now) })
          .where(
            and(
              eq(setCompositions.tenantId, tenantId),
              eq(setCompositions.compositionId, compositionId),
              eq(setCompositions.currentRevision, input.expectedRevision),
            ),
          )
          .returning()
          .pipe(Effect.mapError(unavailable));
        if (updated.length !== 1) {
          return yield* unavailable();
        }
      }
      yield* transaction
        .insert(setCompositionRevisions)
        .values({
          actingPrincipalId: input.actingPrincipalId,
          actionInvocationId: input.actionInvocationId,
          changeKind: revision.provenance.changeKind,
          compositionId,
          effectiveFrom: input.effectiveFrom,
          effectiveTo: input.effectiveTo ?? null,
          evidenceRefs: [...revision.provenance.evidenceRefs],
          lifecycleState: input.lifecycleState,
          predecessorRevision: revision.predecessor?.revision ?? null,
          productId,
          reason: revision.provenance.reason,
          revision: revision.reference.revision,
          tenantId,
          variantId,
        })
        .pipe(Effect.mapError(unavailable));
      yield* Effect.forEach(
        revision.components,
        (component) =>
          transaction
            .insert(setCompositionComponents)
            .values({
              componentId: component.componentId,
              componentProductId: component.selection.productRef.resourceId,
              componentVariantId: component.selection.variantRef.resourceId,
              compositionId,
              configuration: component.selection.configuration ?? null,
              packageContentRevision: component.selection.packageOption?.contentRevision.revision ?? null,
              packageDefinitionId: component.selection.packageOption?.optionRef.resourceId ?? null,
              quantityAmount: component.quantity.amount,
              quantityUnitId: component.quantity.unitRef.resourceId,
              revision: revision.reference.revision,
              tenantId,
            })
            .pipe(Effect.mapError(unavailable)),
        { concurrency: 1 },
      );
      return { _tag: 'published', revision: revision.reference.revision };
    },
  );

  const readCurrent: SetCompositionPersistence['readCurrent'] = Effect.fn('SetCompositionPersistence.readCurrent')(
    function* readCurrent({ at, compositionId }) {
      if (!validDate(at)) {
        return yield* unavailable();
      }
      const [owner] = yield* transaction
        .select()
        .from(setCompositions)
        .where(and(eq(setCompositions.tenantId, tenantId), eq(setCompositions.compositionId, compositionId)))
        .limit(1)
        .pipe(Effect.mapError(unavailable));
      if (owner === undefined) {
        return Option.none<StoredSetCompositionRevision>();
      }
      const rows = yield* transaction
        .select()
        .from(setCompositionRevisions)
        .where(
          and(eq(setCompositionRevisions.tenantId, tenantId), eq(setCompositionRevisions.compositionId, compositionId)),
        )
        .pipe(Effect.mapError(unavailable));
      // The numbered CAS chain is the explicit successor order, not arrival order.
      // A later DRAFT/RETIRED revision cannot resurrect an older ACTIVE revision.
      const effective = rows.filter((row: RevisionRow) => row.effectiveFrom <= at);
      let latest: RevisionRow | undefined;
      for (const row of effective) {
        if (latest === undefined || row.revision > latest.revision) {
          latest = row;
        }
      }
      if (
        latest === undefined ||
        latest.lifecycleState !== 'ACTIVE' ||
        (latest.effectiveTo !== null && at >= latest.effectiveTo)
      ) {
        return Option.none<StoredSetCompositionRevision>();
      }
      if (latest.revision > owner.currentRevision) {
        return yield* unavailable();
      }
      return yield* load(compositionId, latest.revision);
    },
  );
  return { publish, readCurrent, readRevision: ({ compositionId, revision }) => load(compositionId, revision) };
};
