import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { and, eq } from 'drizzle-orm';
import { DateTime, Effect, Option, Schema } from 'effect';

import { assessGtinAssignment, validateGtin } from '../../shared/domain/commercial-code.ts';
import type { GtinTarget } from '../../shared/domain/commercial-code.ts';
import {
  commercialGtinAssignmentRevisions,
  commercialGtinAssignments,
  packageDefinitions,
  productVariants,
  products,
} from '../database/schema.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];

export class GtinPersistenceUnavailable extends Schema.TaggedError<GtinPersistenceUnavailable>()(
  'GtinPersistenceUnavailable',
  { code: Schema.Literal('gtin_persistence_unavailable'), reason: Schema.String },
) {}

interface GtinChangeEvidence {
  readonly actionInvocationId: string;
  readonly attributionEvidenceRef: string;
  readonly code: string;
  readonly effectiveAt: Date;
  /** Zero is reserved for a first assignment. Existing codes require an explicit transition. */
  readonly expectedRevision: number;
  readonly principalId: string;
  readonly reason: string;
}

interface ConfirmGtinInput extends GtinChangeEvidence {
  readonly target: GtinTarget;
}

interface CorrectGtinInput extends GtinChangeEvidence {
  /** The exact currently recorded attribution, not an inferred Product match. */
  readonly previousTarget: GtinTarget;
  /** The evidence reference recorded on the current revision being superseded. */
  readonly supersededEvidenceRef: string;
  readonly target: GtinTarget;
}

interface GtinLifecycleInput extends GtinChangeEvidence {
  readonly previousTarget: GtinTarget;
  readonly supersededEvidenceRef: string;
}

const GtinPersistenceOutcomeSchema = Schema.Union([
  Schema.TaggedStruct('confirmed', { revision: Schema.Int }),
  Schema.TaggedStruct('corrected', { revision: Schema.Int }),
  Schema.TaggedStruct('invalid', { reason: Schema.String }),
  Schema.TaggedStruct('not_found', {}),
  Schema.TaggedStruct('retired', { revision: Schema.Int }),
  Schema.TaggedStruct('stale', { actualRevision: Schema.Int }),
  Schema.TaggedStruct('unresolved', { revision: Schema.Int }),
]);
export type GtinPersistenceOutcome = typeof GtinPersistenceOutcomeSchema.Type;

export interface GtinPersistence {
  readonly confirm: (input: ConfirmGtinInput) => Effect.Effect<GtinPersistenceOutcome, GtinPersistenceUnavailable>;
  readonly correct: (input: CorrectGtinInput) => Effect.Effect<GtinPersistenceOutcome, GtinPersistenceUnavailable>;
  readonly markUnresolved: (
    input: GtinLifecycleInput,
  ) => Effect.Effect<GtinPersistenceOutcome, GtinPersistenceUnavailable>;
  readonly retire: (input: GtinLifecycleInput) => Effect.Effect<GtinPersistenceOutcome, GtinPersistenceUnavailable>;
}

const unavailable = (cause?: unknown): GtinPersistenceUnavailable => {
  const failure = new GtinPersistenceUnavailable({
    code: 'gtin_persistence_unavailable',
    reason: 'Authoritative GTIN attribution or persistence is unavailable',
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

const validText = (value: string): boolean => value.length > 0 && value.length <= 1000 && value === value.trim();
const invocationConflict = 'Action invocation already records different GTIN evidence';

const stateForTransition = (transition: 'confirmed' | 'corrected' | 'retired' | 'unresolved') => {
  if (transition === 'retired') {
    return 'RETIRED';
  }
  if (transition === 'unresolved') {
    return 'UNRESOLVED';
  }
  return 'CONFIRMED';
};

const evidenceProblem = (input: GtinChangeEvidence, tenantId: string): string | undefined => {
  const format = validateGtin(input.code);
  if (format.status !== 'VALID') {
    return format.reason;
  }
  if (
    tenantId.length === 0 ||
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 0 ||
    !validText(input.attributionEvidenceRef) ||
    !validText(input.reason) ||
    input.actionInvocationId.length === 0 ||
    input.principalId.length === 0 ||
    Option.isNone(DateTime.make(input.effectiveAt))
  ) {
    return 'Invalid GTIN attribution evidence or revision';
  }
  return undefined;
};

const inputProblem = (input: ConfirmGtinInput, tenantId: string): string | undefined => {
  const decision = assessGtinAssignment({ attribution: 'CONFIRMED', code: input.code, target: input.target });
  if (decision.status !== 'VALID') {
    return decision.reason;
  }
  if (input.target.tenantId !== tenantId || evidenceProblem(input, tenantId) !== undefined) {
    return 'Invalid GTIN attribution evidence or scope';
  }
  return undefined;
};

const replayMatches = (
  prior: typeof commercialGtinAssignmentRevisions.$inferSelect,
  input: ConfirmGtinInput,
): boolean =>
  prior.gtin === input.code &&
  prior.revision === input.expectedRevision + 1 &&
  (input.target.kind !== 'VARIANT' || prior.variantId === input.target.variantId) &&
  prior.packageDefinitionId === (input.target.kind === 'PACKAGE_LEVEL' ? input.target.packageDefinitionId : null) &&
  prior.attributionEvidenceRef === input.attributionEvidenceRef &&
  prior.reason === input.reason &&
  DateTime.toEpochMillis(DateTime.makeUnsafe(prior.effectiveAt)) ===
    DateTime.toEpochMillis(DateTime.makeUnsafe(input.effectiveAt)) &&
  prior.actingPrincipalId === input.principalId &&
  prior.state === 'CONFIRMED';

const storedTargetMatches = (
  row: Pick<typeof commercialGtinAssignments.$inferSelect, 'packageDefinitionId' | 'variantId'>,
  target: GtinTarget,
): boolean =>
  target.kind === 'VARIANT'
    ? row.packageDefinitionId === null && row.variantId === target.variantId
    : row.packageDefinitionId === target.packageDefinitionId;

const replayLifecycleMatches = (
  prior: typeof commercialGtinAssignmentRevisions.$inferSelect,
  input: GtinLifecycleInput,
  state: 'RETIRED' | 'UNRESOLVED',
): boolean =>
  prior.gtin === input.code &&
  prior.revision === input.expectedRevision + 1 &&
  prior.state === state &&
  prior.attributionEvidenceRef === input.attributionEvidenceRef &&
  prior.reason === input.reason &&
  prior.actingPrincipalId === input.principalId &&
  DateTime.toEpochMillis(DateTime.makeUnsafe(prior.effectiveAt)) ===
    DateTime.toEpochMillis(DateTime.makeUnsafe(input.effectiveAt));

const correctionHeadMatches = (
  head: typeof commercialGtinAssignmentRevisions.$inferSelect | undefined,
  existing: typeof commercialGtinAssignments.$inferSelect,
  input: Pick<CorrectGtinInput, 'previousTarget' | 'supersededEvidenceRef'>,
): boolean =>
  head !== undefined &&
  head.attributionEvidenceRef === input.supersededEvidenceRef &&
  head.state === existing.state &&
  head.productId === existing.productId &&
  head.variantId === existing.variantId &&
  head.packageDefinitionId === existing.packageDefinitionId &&
  storedTargetMatches(head, input.previousTarget);

/** Core owns the scoped transaction and rollback. This service never infers attribution from a code or name. */
export const gtinPersistenceForScope = (transaction: ScopedTransaction, scope: OperationalScope): GtinPersistence => {
  const { tenantId } = scope;
  const loadPrior = (actionInvocationId: string) =>
    transaction
      .select()
      .from(commercialGtinAssignmentRevisions)
      .where(
        and(
          eq(commercialGtinAssignmentRevisions.tenantId, tenantId),
          eq(commercialGtinAssignmentRevisions.actionInvocationId, actionInvocationId),
        ),
      )
      .limit(1)
      .pipe(Effect.mapError(unavailable));
  const loadAssignment = (code: string) =>
    transaction
      .select()
      .from(commercialGtinAssignments)
      .where(and(eq(commercialGtinAssignments.tenantId, tenantId), eq(commercialGtinAssignments.gtin, code)))
      .for('update')
      .limit(1)
      .pipe(Effect.mapError(unavailable));
  const loadRevision = (code: string, revision: number) =>
    transaction
      .select()
      .from(commercialGtinAssignmentRevisions)
      .where(
        and(
          eq(commercialGtinAssignmentRevisions.tenantId, tenantId),
          eq(commercialGtinAssignmentRevisions.gtin, code),
          eq(commercialGtinAssignmentRevisions.revision, revision),
        ),
      )
      .limit(1)
      .pipe(Effect.mapError(unavailable));
  const resolveTarget = Effect.fn('GtinPersistence.resolveTarget')(function* resolveTarget(target: GtinTarget) {
    const [pack] =
      target.kind === 'PACKAGE_LEVEL'
        ? yield* transaction
            .select()
            .from(packageDefinitions)
            .where(
              and(
                eq(packageDefinitions.tenantId, tenantId),
                eq(packageDefinitions.packageDefinitionId, target.packageDefinitionId),
              ),
            )
            .for('update')
            .limit(1)
        : [undefined];
    const variantId = target.kind === 'VARIANT' ? target.variantId : pack?.variantId;
    if (variantId === undefined || (pack !== undefined && pack.lifecycleState !== 'ACTIVE')) {
      return null;
    }
    const variants = yield* transaction
      .select()
      .from(productVariants)
      .where(and(eq(productVariants.tenantId, tenantId), eq(productVariants.variantId, variantId)))
      .for('update')
      .limit(2);
    const [variant] = variants;
    if (
      variants.length !== 1 ||
      variant === undefined ||
      (pack !== undefined && pack.productId !== variant.productId)
    ) {
      return null;
    }
    const [product] = yield* transaction
      .select()
      .from(products)
      .where(and(eq(products.tenantId, tenantId), eq(products.productId, variant.productId)))
      .for('update')
      .limit(1);
    if (variant.lifecycleState !== 'ACTIVE' || product?.lifecycleState !== 'ACTIVE') {
      return null;
    }
    return { packageDefinitionId: pack?.packageDefinitionId ?? null, productId: variant.productId, variantId };
  }, Effect.mapError(unavailable));

  const persist = Effect.fn('GtinPersistence.persist')(function* persist(
    input: GtinChangeEvidence,
    target: { readonly packageDefinitionId: string | null; readonly productId: string; readonly variantId: string },
    existing: typeof commercialGtinAssignments.$inferSelect | undefined,
    transition: 'confirmed' | 'corrected' | 'retired' | 'unresolved',
  ) {
    const revision = (existing?.currentRevision ?? 0) + 1;
    const state = stateForTransition(transition);
    if (existing === undefined) {
      yield* transaction
        .insert(commercialGtinAssignments)
        .values({
          currentRevision: revision,
          gtin: input.code,
          packageDefinitionId: target.packageDefinitionId,
          productId: target.productId,
          state,
          tenantId,
          variantId: target.variantId,
        })
        .pipe(Effect.mapError(unavailable));
    } else {
      const [updated] = yield* transaction
        .update(commercialGtinAssignments)
        .set({
          currentRevision: revision,
          packageDefinitionId: target.packageDefinitionId,
          productId: target.productId,
          state,
          updatedAt: DateTime.toDateUtc(yield* DateTime.now),
          variantId: target.variantId,
        })
        .where(
          and(
            eq(commercialGtinAssignments.tenantId, tenantId),
            eq(commercialGtinAssignments.gtin, input.code),
            eq(commercialGtinAssignments.currentRevision, input.expectedRevision),
          ),
        )
        .returning()
        .pipe(Effect.mapError(unavailable));
      if (updated === undefined) {
        return { _tag: 'stale', actualRevision: existing.currentRevision } as const;
      }
    }
    yield* transaction
      .insert(commercialGtinAssignmentRevisions)
      .values({
        actingPrincipalId: input.principalId,
        actionInvocationId: input.actionInvocationId,
        attributionEvidenceRef: input.attributionEvidenceRef,
        effectiveAt: input.effectiveAt,
        gtin: input.code,
        packageDefinitionId: target.packageDefinitionId,
        productId: target.productId,
        reason: input.reason,
        revision,
        state,
        tenantId,
        variantId: target.variantId,
      })
      .pipe(Effect.mapError(unavailable));
    return { _tag: transition, revision } as const;
  });
  const confirm: GtinPersistence['confirm'] = Effect.fn('GtinPersistence.confirm')(function* confirm(input) {
    const problem = inputProblem(input, tenantId);
    if (problem !== undefined) {
      return { _tag: 'invalid', reason: problem };
    }
    const [priorInvocation] = yield* loadPrior(input.actionInvocationId);
    if (priorInvocation !== undefined) {
      if (priorInvocation.revision !== 1 || !replayMatches(priorInvocation, input)) {
        return { _tag: 'invalid', reason: invocationConflict };
      }
      return { _tag: 'confirmed', revision: priorInvocation.revision };
    }
    const [existing] = yield* loadAssignment(input.code);
    if (existing === undefined && input.expectedRevision !== 0) {
      return { _tag: 'not_found' };
    }
    if (existing !== undefined && existing.currentRevision !== input.expectedRevision) {
      return { _tag: 'stale', actualRevision: existing.currentRevision };
    }
    if (existing !== undefined) {
      return {
        _tag: 'invalid',
        reason: 'GTIN already exists; use an explicit evidenced correction or lifecycle transition',
      };
    }
    const target = yield* resolveTarget(input.target);
    if (target === null) {
      return { _tag: 'invalid', reason: 'Exact Current GTIN target is unavailable' };
    }
    return yield* persist(input, target, existing, 'confirmed');
  });

  const correct: GtinPersistence['correct'] = Effect.fn('GtinPersistence.correct')(function* correct(input) {
    const problem = inputProblem(input, tenantId);
    if (
      problem !== undefined ||
      input.previousTarget.tenantId !== tenantId ||
      !validText(input.supersededEvidenceRef)
    ) {
      return { _tag: 'invalid', reason: problem ?? 'Invalid correction provenance or previous target' };
    }
    const [priorInvocation] = yield* loadPrior(input.actionInvocationId);
    if (priorInvocation !== undefined) {
      if (!replayMatches(priorInvocation, input) || priorInvocation.revision < 2) {
        return { _tag: 'invalid', reason: invocationConflict };
      }
      const [before] = yield* loadRevision(input.code, priorInvocation.revision - 1);
      if (
        before === undefined ||
        before.attributionEvidenceRef !== input.supersededEvidenceRef ||
        !storedTargetMatches(before, input.previousTarget)
      ) {
        return { _tag: 'invalid', reason: invocationConflict };
      }
      return { _tag: 'corrected', revision: priorInvocation.revision };
    }
    const [existing] = yield* loadAssignment(input.code);
    if (existing === undefined) {
      return { _tag: 'not_found' };
    }
    if (existing.currentRevision !== input.expectedRevision) {
      return { _tag: 'stale', actualRevision: existing.currentRevision };
    }
    if (existing.state === 'RETIRED' || !storedTargetMatches(existing, input.previousTarget)) {
      return { _tag: 'invalid', reason: 'Correction must cite the retained exact target of a non-retired GTIN' };
    }
    const [head] = yield* loadRevision(input.code, existing.currentRevision);
    if (!correctionHeadMatches(head, existing, input)) {
      return { _tag: 'invalid', reason: 'Correction must cite the current attribution evidence' };
    }
    const target = yield* resolveTarget(input.target);
    if (target === null || storedTargetMatches(existing, input.target)) {
      return { _tag: 'invalid', reason: 'Correction requires a distinct confirmed Current exact target' };
    }
    return yield* persist(input, target, existing, 'corrected');
  });

  const changeState = Effect.fn('GtinPersistence.changeState')(function* changeState(
    transition: 'retired' | 'unresolved',
    input: GtinLifecycleInput,
  ) {
    const problem = evidenceProblem(input, tenantId);
    if (
      problem !== undefined ||
      input.expectedRevision === 0 ||
      input.previousTarget.tenantId !== tenantId ||
      !validText(input.supersededEvidenceRef)
    ) {
      return {
        _tag: 'invalid',
        reason: problem ?? 'Lifecycle transition requires exact prior attribution evidence',
      } as const;
    }
    const state = transition === 'retired' ? 'RETIRED' : 'UNRESOLVED';
    const [priorInvocation] = yield* loadPrior(input.actionInvocationId);
    if (priorInvocation !== undefined) {
      const [before] = yield* loadRevision(input.code, priorInvocation.revision - 1);
      if (
        !replayLifecycleMatches(priorInvocation, input, state) ||
        before === undefined ||
        before.attributionEvidenceRef !== input.supersededEvidenceRef ||
        !storedTargetMatches(before, input.previousTarget)
      ) {
        return { _tag: 'invalid', reason: invocationConflict } as const;
      }
      return { _tag: transition, revision: priorInvocation.revision } as const;
    }
    const [existing] = yield* loadAssignment(input.code);
    if (existing === undefined) {
      return { _tag: 'not_found' } as const;
    }
    if (existing.currentRevision !== input.expectedRevision) {
      return { _tag: 'stale', actualRevision: existing.currentRevision } as const;
    }
    if (existing.state === 'RETIRED' || (transition === 'unresolved' && existing.state !== 'CONFIRMED')) {
      return { _tag: 'invalid', reason: 'GTIN lifecycle transition is not valid from its current state' } as const;
    }
    const [head] = yield* loadRevision(input.code, existing.currentRevision);
    if (!correctionHeadMatches(head, existing, input)) {
      return {
        _tag: 'invalid',
        reason: 'Lifecycle transition must cite the retained exact target and current evidence',
      } as const;
    }
    return yield* persist(
      input,
      {
        packageDefinitionId: existing.packageDefinitionId,
        productId: existing.productId,
        variantId: existing.variantId,
      },
      existing,
      transition,
    );
  });
  const markUnresolved: GtinPersistence['markUnresolved'] = (input) => changeState('unresolved', input);
  const retire: GtinPersistence['retire'] = (input) => changeState('retired', input);
  return { confirm, correct, markUnresolved, retire };
};
