import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { and, desc, eq, isNull, ne } from 'drizzle-orm';
import { DateTime, Effect, Match, Schema } from 'effect';

import { normalizeSku } from '../../shared/domain/commercial-code.ts';
import type { SkuTarget } from '../../shared/domain/commercial-code.ts';
import { SkuTargetSchema } from '../../shared/actions/assign-sku.ts';
import { resolveEffectiveRevision } from './package-persistence.ts';
import {
  commercialSkuAssignmentRevisions,
  commercialSkuReservations,
  packageContentRevisions,
  packageDefinitions,
  packageOptionRoleRevisions,
  productVariants,
  productUnits,
  products,
} from '../database/schema.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];
/* oxlint-disable effect-native/no-nullable-schema-field, effect-native/no-unbranded-identifier-schema -- Exact scope: internal Drizzle result identity. Evidence: package_definition_id is nullable by target kind and these owner-local strings never cross a decode boundary. Owner/tracking: Catalog #398. Remove when SKU target reads return the approved branded owner value object; expires: 2027-03-31. */
const ResolvedTargetSchema = Schema.Struct({
  packageDefinitionId: Schema.NullOr(Schema.String),
  productId: Schema.String,
  variantId: Schema.String,
});
/* oxlint-enable effect-native/no-nullable-schema-field, effect-native/no-unbranded-identifier-schema */
type ResolvedTarget = typeof ResolvedTargetSchema.Type;

const SkuTargetResolutionSchema = Schema.Union([
  Schema.TaggedStruct('RESOLVED', { target: ResolvedTargetSchema }),
  Schema.TaggedStruct('NOT_FOUND', { reason: Schema.Literals(['PACKAGE_OPTION_NOT_FOUND', 'VARIANT_NOT_FOUND']) }),
  Schema.TaggedStruct('INVALID_CURRENT', {
    reason: Schema.Literals([
      'CONTENT_NOT_ACTIVE',
      'PACKAGE_DEFINITION_NOT_ACTIVE',
      'PACKAGE_OPTION_NOT_ACTIVE',
      'PACKAGE_OPTION_NOT_INDEPENDENT',
      'PRODUCT_NOT_ACTIVE',
      'UNIT_NOT_ACTIVE',
      'VARIANT_NOT_ACTIVE',
    ]),
  }),
  Schema.TaggedStruct('INDETERMINATE', {
    reason: Schema.Literals([
      'CONTENT_PROOF_INCOMPLETE',
      'CURRENT_SNAPSHOT_CONTRADICTORY',
      'PRODUCT_PROOF_INCOMPLETE',
      'ROLE_PROOF_INCOMPLETE',
      'UNIT_PROOF_INCOMPLETE',
      'VARIANT_PROOF_INCOMPLETE',
    ]),
  }),
]);
type SkuTargetResolution = typeof SkuTargetResolutionSchema.Type;

const resolvedTarget = (target: ResolvedTarget): SkuTargetResolution => ({ _tag: 'RESOLVED', target });

export interface SkuCurrentOptionSnapshot {
  readonly content: Pick<
    typeof packageContentRevisions.$inferSelect,
    'effectiveAt' | 'lifecycleState' | 'productId' | 'unitResourceType' | 'variantId'
  >;
  readonly contentRevision: number;
  readonly definition: Pick<
    typeof packageDefinitions.$inferSelect,
    | 'currentOptionRevision'
    | 'currentRevision'
    | 'lifecycleState'
    | 'optionState'
    | 'packageDefinitionId'
    | 'productId'
    | 'variantId'
  >;
  readonly effectiveContentRevision: number;
  readonly now: Date;
  readonly productLifecycle: string;
  readonly role: Pick<
    typeof packageOptionRoleRevisions.$inferSelect,
    | 'contentRevision'
    | 'effectiveAt'
    | 'independentlyRequested'
    | 'looseUnitsSubstitutable'
    | 'productId'
    | 'revision'
    | 'state'
    | 'variantId'
  >;
  readonly unitLifecycle: string;
  readonly variantLifecycle: string;
}

/* oxlint-disable eslint/complexity -- Exact scope: package-option Current proof. Evidence: every branch preserves a distinct revision, lifecycle, or requestability outcome required by #398 tests. Owner/tracking: Catalog #398. Remove when the proof is represented by an approved owner value object without flattening outcomes; expires: 2027-03-31. */
export const assessCurrentPackageOptionSnapshot = (snapshot: SkuCurrentOptionSnapshot): SkuTargetResolution => {
  const { content, definition, now, role } = snapshot;
  if (
    definition.currentRevision < 1 ||
    definition.currentOptionRevision < 1 ||
    snapshot.effectiveContentRevision < 1 ||
    snapshot.effectiveContentRevision > definition.currentRevision ||
    snapshot.contentRevision !== snapshot.effectiveContentRevision ||
    content.productId !== definition.productId ||
    content.variantId !== definition.variantId ||
    content.unitResourceType !== 'commerce.catalog.product-unit' ||
    role.revision !== definition.currentOptionRevision ||
    role.contentRevision !== snapshot.effectiveContentRevision ||
    role.productId !== definition.productId ||
    role.variantId !== definition.variantId ||
    content.effectiveAt.getTime() > now.getTime() ||
    role.effectiveAt.getTime() > now.getTime()
  ) {
    return { _tag: 'INDETERMINATE', reason: 'CURRENT_SNAPSHOT_CONTRADICTORY' };
  }
  if (definition.lifecycleState !== 'ACTIVE') {
    return { _tag: 'INVALID_CURRENT', reason: 'PACKAGE_DEFINITION_NOT_ACTIVE' };
  }
  if (definition.optionState !== 'ACTIVE' || role.state !== 'ACTIVE') {
    return { _tag: 'INVALID_CURRENT', reason: 'PACKAGE_OPTION_NOT_ACTIVE' };
  }
  if (content.lifecycleState !== 'ACTIVE') {
    return { _tag: 'INVALID_CURRENT', reason: 'CONTENT_NOT_ACTIVE' };
  }
  if (!role.independentlyRequested || role.looseUnitsSubstitutable) {
    return { _tag: 'INVALID_CURRENT', reason: 'PACKAGE_OPTION_NOT_INDEPENDENT' };
  }
  if (snapshot.productLifecycle !== 'ACTIVE') {
    return { _tag: 'INVALID_CURRENT', reason: 'PRODUCT_NOT_ACTIVE' };
  }
  if (snapshot.variantLifecycle !== 'ACTIVE') {
    return { _tag: 'INVALID_CURRENT', reason: 'VARIANT_NOT_ACTIVE' };
  }
  if (snapshot.unitLifecycle !== 'ACTIVE') {
    return { _tag: 'INVALID_CURRENT', reason: 'UNIT_NOT_ACTIVE' };
  }
  return resolvedTarget({
    packageDefinitionId: definition.packageDefinitionId,
    productId: definition.productId,
    variantId: definition.variantId,
  });
};

export const currentPackageOptionSnapshotMatches = (snapshot: SkuCurrentOptionSnapshot): boolean =>
  Match.value(assessCurrentPackageOptionSnapshot(snapshot)).pipe(
    Match.tag('RESOLVED', () => true),
    Match.orElse(() => false),
  );
/* oxlint-enable eslint/complexity */

const invalidCurrentReason = (resolution: Extract<SkuTargetResolution, { _tag: 'INVALID_CURRENT' }>): string =>
  Match.value(resolution.reason).pipe(
    Match.when('CONTENT_NOT_ACTIVE', () => 'Package Option effective content is not Active'),
    Match.when('PACKAGE_DEFINITION_NOT_ACTIVE', () => 'Package Definition is not Active'),
    Match.when('PACKAGE_OPTION_NOT_ACTIVE', () => 'Package Option role is not Active'),
    Match.when('PACKAGE_OPTION_NOT_INDEPENDENT', () => 'Package Option is not independently requestable'),
    Match.when('PRODUCT_NOT_ACTIVE', () => 'Product is not Active'),
    Match.when('UNIT_NOT_ACTIVE', () => 'Product Unit is not Active'),
    Match.when('VARIANT_NOT_ACTIVE', () => 'Variant is not Active'),
    Match.exhaustive,
  );

export class SkuPersistenceUnavailable extends Schema.TaggedError<SkuPersistenceUnavailable>()(
  'SkuPersistenceUnavailable',
  { code: Schema.Literal('sku_persistence_unavailable'), reason: Schema.String },
) {}

export interface SkuChangeInput {
  readonly actionInvocationId: string;
  readonly code: string;
  readonly evidenceRefs: readonly string[];
  /** Zero means this is a new tenant-wide reservation. */
  readonly expectedRevision: number;
  readonly principalId: string;
  readonly reason: string;
  readonly target: SkuTarget;
}

export interface SkuCorrectionInput extends SkuChangeInput {
  /** The original mistaken target is preserved in the preceding revision. */
  readonly previousTarget: SkuTarget;
}

export interface SkuRenameInput extends SkuChangeInput {
  readonly oldCode: string;
}

const SkuChangeOutcomeSchema = Schema.Union([
  Schema.TaggedStruct('applied', { revision: Schema.Int }),
  Schema.TaggedStruct('conflict', {}),
  Schema.TaggedStruct('invalid', { reason: Schema.String }),
  Schema.TaggedStruct('not_found', {}),
  Schema.TaggedStruct('stale', { actualRevision: Schema.Int }),
]);
export type SkuChangeOutcome = typeof SkuChangeOutcomeSchema.Type;

type SkuReservation = Pick<
  typeof commercialSkuReservations.$inferSelect,
  'currentRevision' | 'displayCode' | 'normalizedCode' | 'packageDefinitionId' | 'state' | 'tenantId' | 'variantId'
>;
type SkuRevision = Pick<
  typeof commercialSkuAssignmentRevisions.$inferSelect,
  'normalizedCode' | 'packageDefinitionId' | 'revision' | 'state' | 'tenantId' | 'variantId'
>;

const SkuLookupOutcomeSchema = Schema.Union([
  Schema.TaggedStruct('found', {
    displayCode: Schema.String,
    revision: Schema.Int,
    state: Schema.Literals(['CURRENT', 'HISTORICAL']),
    target: SkuTargetSchema,
  }),
  Schema.TaggedStruct('ambiguous', {}),
  Schema.TaggedStruct('not_found', {}),
  Schema.TaggedStruct('invalid', {}),
]);
export type SkuLookupOutcome = typeof SkuLookupOutcomeSchema.Type;

const validSkuLookupCode = (normalizedCode: string): boolean =>
  normalizedCode.length > 0 && normalizedCode.length <= 240;

const unavailable = (cause?: unknown): SkuPersistenceUnavailable => {
  const failure = new SkuPersistenceUnavailable({
    code: 'sku_persistence_unavailable',
    reason: 'Authoritative SKU target or persistence is unavailable',
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

/** A bare code cannot disambiguate pre-correction occurrences without source/time context. */
export const assessSkuLookupSnapshot = (
  tenantId: string,
  code: string,
  reservation: SkuReservation | undefined,
  revisions: readonly SkuRevision[],
): SkuLookupOutcome | SkuPersistenceUnavailable => {
  const normalizedCode = normalizeSku(code);
  if (!validSkuLookupCode(normalizedCode)) {
    return { _tag: 'invalid' };
  }
  if (reservation === undefined) {
    return revisions.length === 0 ? { _tag: 'not_found' } : unavailable();
  }
  if (
    reservation.tenantId !== tenantId ||
    reservation.normalizedCode !== normalizedCode ||
    revisions.length === 0 ||
    revisions.some((revision) => revision.tenantId !== tenantId || revision.normalizedCode !== normalizedCode)
  ) {
    return unavailable();
  }
  if (reservation.state === 'UNRESOLVED') {
    return { _tag: 'ambiguous' };
  }
  if (reservation.state !== 'CURRENT' && reservation.state !== 'HISTORICAL') {
    return unavailable();
  }
  const [latest] = revisions;
  if (
    latest === undefined ||
    latest.revision !== reservation.currentRevision ||
    latest.state !== reservation.state ||
    latest.variantId !== reservation.variantId ||
    latest.packageDefinitionId !== reservation.packageDefinitionId ||
    revisions.length !== reservation.currentRevision ||
    revisions.some((revision) => revision.revision < 1 || revision.revision > reservation.currentRevision)
  ) {
    return unavailable();
  }
  if (
    revisions.some(
      (revision) =>
        revision.variantId !== reservation.variantId ||
        revision.packageDefinitionId !== reservation.packageDefinitionId,
    )
  ) {
    return { _tag: 'ambiguous' };
  }
  const target: SkuTarget =
    reservation.packageDefinitionId === null
      ? { kind: 'VARIANT', tenantId, variantId: reservation.variantId }
      : { kind: 'PACKAGE_OPTION', packageDefinitionId: reservation.packageDefinitionId, tenantId };
  return {
    _tag: 'found',
    displayCode: reservation.displayCode,
    revision: reservation.currentRevision,
    state: reservation.state,
    target,
  };
};

export const validSkuChangeInput = (input: SkuChangeInput, tenantId: string): boolean =>
  input.target.tenantId === tenantId &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(input.actionInvocationId) &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(input.principalId) &&
  (input.target.kind === 'VARIANT'
    ? /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(input.target.variantId)
    : /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(input.target.packageDefinitionId)) &&
  Number.isSafeInteger(input.expectedRevision) &&
  input.expectedRevision >= 0 &&
  normalizeSku(input.code).length > 0 &&
  normalizeSku(input.code).length <= 240 &&
  input.reason === input.reason.trim() &&
  input.reason.length > 0 &&
  input.reason.length <= 1000 &&
  input.evidenceRefs.length > 0 &&
  input.evidenceRefs.every((ref) => ref.length > 0 && ref.length <= 300 && ref === ref.trim());

const sameEvidence = (row: typeof commercialSkuAssignmentRevisions.$inferSelect, input: SkuChangeInput) =>
  row.reason === input.reason &&
  row.evidenceRefs.length === input.evidenceRefs.length &&
  row.evidenceRefs.every((ref, index) => ref === input.evidenceRefs[index]);

const sameTarget = (row: typeof commercialSkuReservations.$inferSelect, target: SkuTarget) =>
  target.kind === 'VARIANT'
    ? row.variantId === target.variantId && row.packageDefinitionId === null
    : row.packageDefinitionId === target.packageDefinitionId;

const unchangedCorrection = (row: typeof commercialSkuReservations.$inferSelect, input: SkuCorrectionInput) =>
  sameTarget(row, input.target) && row.displayCode === input.code;

/** Core owns the transaction and permissions. This owner service cannot open or commit one. */
export const skuPersistenceForScope = (transaction: ScopedTransaction, scope: OperationalScope) => {
  const { tenantId } = scope;
  const reservationWhere = (normalizedCode: string) =>
    and(eq(commercialSkuReservations.tenantId, tenantId), eq(commercialSkuReservations.normalizedCode, normalizedCode));
  const lookup = Effect.fn('SkuPersistence.lookup')(function* lookup(code: string) {
    const normalizedCode = normalizeSku(code);
    if (!validSkuLookupCode(normalizedCode)) {
      return { _tag: 'invalid' } as const;
    }
    const [reservations, revisions] = yield* Effect.all(
      [
        transaction
          .select({
            currentRevision: commercialSkuReservations.currentRevision,
            displayCode: commercialSkuReservations.displayCode,
            normalizedCode: commercialSkuReservations.normalizedCode,
            packageDefinitionId: commercialSkuReservations.packageDefinitionId,
            state: commercialSkuReservations.state,
            tenantId: commercialSkuReservations.tenantId,
            variantId: commercialSkuReservations.variantId,
          })
          .from(commercialSkuReservations)
          .where(reservationWhere(normalizedCode))
          .limit(2),
        transaction
          .select({
            normalizedCode: commercialSkuAssignmentRevisions.normalizedCode,
            packageDefinitionId: commercialSkuAssignmentRevisions.packageDefinitionId,
            revision: commercialSkuAssignmentRevisions.revision,
            state: commercialSkuAssignmentRevisions.state,
            tenantId: commercialSkuAssignmentRevisions.tenantId,
            variantId: commercialSkuAssignmentRevisions.variantId,
          })
          .from(commercialSkuAssignmentRevisions)
          .where(
            and(
              eq(commercialSkuAssignmentRevisions.tenantId, tenantId),
              eq(commercialSkuAssignmentRevisions.normalizedCode, normalizedCode),
            ),
          )
          .orderBy(desc(commercialSkuAssignmentRevisions.revision)),
      ],
      { concurrency: 1 },
    ).pipe(Effect.mapError(unavailable));
    if (reservations.length > 1) {
      return { _tag: 'ambiguous' } as const;
    }
    const outcome = assessSkuLookupSnapshot(tenantId, code, reservations[0], revisions);
    return Schema.is(SkuPersistenceUnavailable)(outcome) ? yield* outcome : outcome;
  });
  const readInvocation = (actionInvocationId: string, normalizedCode: string) =>
    transaction
      .select()
      .from(commercialSkuAssignmentRevisions)
      .where(
        and(
          eq(commercialSkuAssignmentRevisions.tenantId, tenantId),
          eq(commercialSkuAssignmentRevisions.actionInvocationId, actionInvocationId),
          eq(commercialSkuAssignmentRevisions.normalizedCode, normalizedCode),
        ),
      )
      .limit(1)
      .pipe(Effect.mapError(unavailable));
  const readAnyInvocation = (actionInvocationId: string) =>
    transaction
      .select()
      .from(commercialSkuAssignmentRevisions)
      .where(
        and(
          eq(commercialSkuAssignmentRevisions.tenantId, tenantId),
          eq(commercialSkuAssignmentRevisions.actionInvocationId, actionInvocationId),
        ),
      )
      .limit(1)
      .pipe(Effect.mapError(unavailable));
  /* oxlint-disable eslint/complexity -- Exact scope: authoritative SKU target resolution. Evidence: focused #398 outcome tests require separate missing, invalid, and indeterminate branches. Owner/tracking: Catalog #398. Remove when Variant and Package Option expose one approved typed Current-read contract; expires: 2027-03-31. */
  const resolveTarget = Effect.fn('SkuPersistence.resolveTarget')(function* resolveTarget(target: SkuTarget) {
    if (target.kind === 'PACKAGE_OPTION') {
      const [definition] = yield* transaction
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
        .pipe(Effect.mapError(unavailable));
      if (definition === undefined) {
        return { _tag: 'NOT_FOUND', reason: 'PACKAGE_OPTION_NOT_FOUND' } as const;
      }
      if (definition.lifecycleState !== 'ACTIVE') {
        return { _tag: 'INVALID_CURRENT', reason: 'PACKAGE_DEFINITION_NOT_ACTIVE' } as const;
      }
      if (definition.optionState !== 'ACTIVE') {
        return { _tag: 'INVALID_CURRENT', reason: 'PACKAGE_OPTION_NOT_ACTIVE' } as const;
      }
      const now = DateTime.toDateUtc(yield* DateTime.now);
      const [contents, [role], [variant], [product]] = yield* Effect.all(
        [
          transaction
            .select()
            .from(packageContentRevisions)
            .where(
              and(
                eq(packageContentRevisions.tenantId, tenantId),
                eq(packageContentRevisions.packageDefinitionId, definition.packageDefinitionId),
              ),
            )
            .for('update'),
          transaction
            .select()
            .from(packageOptionRoleRevisions)
            .where(
              and(
                eq(packageOptionRoleRevisions.tenantId, tenantId),
                eq(packageOptionRoleRevisions.packageDefinitionId, definition.packageDefinitionId),
                eq(packageOptionRoleRevisions.revision, definition.currentOptionRevision),
              ),
            )
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
          transaction
            .select()
            .from(products)
            .where(and(eq(products.tenantId, tenantId), eq(products.productId, definition.productId)))
            .for('update')
            .limit(1),
        ] as const,
        { concurrency: 1 },
      ).pipe(Effect.mapError(unavailable));
      const effective = resolveEffectiveRevision(contents, now);
      const effectiveRevision = Match.value(effective).pipe(
        Match.tag('resolved', (resolved) => resolved.revision),
        Match.tag('invalid', () => null),
        Match.exhaustive,
      );
      const content = contents.find((row) => row.revision === effectiveRevision);
      if (content === undefined || contents.length !== definition.currentRevision) {
        return { _tag: 'INDETERMINATE', reason: 'CONTENT_PROOF_INCOMPLETE' } as const;
      }
      if (role === undefined) {
        return { _tag: 'INDETERMINATE', reason: 'ROLE_PROOF_INCOMPLETE' } as const;
      }
      if (variant === undefined) {
        return { _tag: 'INDETERMINATE', reason: 'VARIANT_PROOF_INCOMPLETE' } as const;
      }
      if (product === undefined) {
        return { _tag: 'INDETERMINATE', reason: 'PRODUCT_PROOF_INCOMPLETE' } as const;
      }
      if (content.lifecycleState !== 'ACTIVE') {
        return { _tag: 'INVALID_CURRENT', reason: 'CONTENT_NOT_ACTIVE' } as const;
      }
      if (role.state !== 'ACTIVE') {
        return { _tag: 'INVALID_CURRENT', reason: 'PACKAGE_OPTION_NOT_ACTIVE' } as const;
      }
      if (!role.independentlyRequested || role.looseUnitsSubstitutable) {
        return { _tag: 'INVALID_CURRENT', reason: 'PACKAGE_OPTION_NOT_INDEPENDENT' } as const;
      }
      if (product.lifecycleState !== 'ACTIVE') {
        return { _tag: 'INVALID_CURRENT', reason: 'PRODUCT_NOT_ACTIVE' } as const;
      }
      if (variant.lifecycleState !== 'ACTIVE') {
        return { _tag: 'INVALID_CURRENT', reason: 'VARIANT_NOT_ACTIVE' } as const;
      }
      const [unit] = yield* transaction
        .select()
        .from(productUnits)
        .where(and(eq(productUnits.tenantId, tenantId), eq(productUnits.unitId, content.unitResourceId)))
        .for('update')
        .limit(1)
        .pipe(Effect.mapError(unavailable));
      if (unit === undefined) {
        return { _tag: 'INDETERMINATE', reason: 'UNIT_PROOF_INCOMPLETE' } as const;
      }
      if (unit.lifecycleState !== 'ACTIVE') {
        return { _tag: 'INVALID_CURRENT', reason: 'UNIT_NOT_ACTIVE' } as const;
      }
      return assessCurrentPackageOptionSnapshot({
        content,
        contentRevision: content.revision,
        definition,
        effectiveContentRevision: effectiveRevision ?? 0,
        now,
        productLifecycle: product.lifecycleState,
        role,
        unitLifecycle: unit.lifecycleState,
        variantLifecycle: variant.lifecycleState,
      });
    }
    const [variant] = yield* transaction
      .select()
      .from(productVariants)
      .where(and(eq(productVariants.tenantId, tenantId), eq(productVariants.variantId, target.variantId)))
      .for('update')
      .limit(1)
      .pipe(Effect.mapError(unavailable));
    if (variant === undefined) {
      return { _tag: 'NOT_FOUND', reason: 'VARIANT_NOT_FOUND' } as const;
    }
    const [product] = yield* transaction
      .select()
      .from(products)
      .where(and(eq(products.tenantId, tenantId), eq(products.productId, variant.productId)))
      .limit(1)
      .pipe(Effect.mapError(unavailable));
    if (product === undefined) {
      return { _tag: 'INDETERMINATE', reason: 'PRODUCT_PROOF_INCOMPLETE' } as const;
    }
    if (product.lifecycleState !== 'ACTIVE') {
      return { _tag: 'INVALID_CURRENT', reason: 'PRODUCT_NOT_ACTIVE' } as const;
    }
    if (variant.lifecycleState !== 'ACTIVE') {
      return { _tag: 'INVALID_CURRENT', reason: 'VARIANT_NOT_ACTIVE' } as const;
    }
    return resolvedTarget({
      packageDefinitionId: null,
      productId: variant.productId,
      variantId: variant.variantId,
    });
  });
  /* oxlint-enable eslint/complexity */
  const resolveChangeTarget = (target: SkuTarget) =>
    resolveTarget(target).pipe(
      Effect.flatMap((resolution) =>
        Match.value(resolution).pipe(
          Match.tag('RESOLVED', ({ target: resolvedValue }) => Effect.succeed({ target: resolvedValue })),
          Match.tag('NOT_FOUND', () => Effect.succeed({ outcome: { _tag: 'not_found' as const }, target: null })),
          Match.tag('INVALID_CURRENT', (invalid) =>
            Effect.succeed({
              outcome: { _tag: 'invalid' as const, reason: invalidCurrentReason(invalid) },
              target: null,
            }),
          ),
          Match.tag('INDETERMINATE', () => Effect.fail(unavailable())),
          Match.exhaustive,
        ),
      ),
    );
  const appendRevision = (
    input: SkuChangeInput,
    target: ResolvedTarget,
    revision: number,
    changeKind: string,
    now: Date,
    code = input.code,
    state = 'CURRENT',
  ) =>
    transaction.insert(commercialSkuAssignmentRevisions).values({
      actingPrincipalId: input.principalId,
      actionInvocationId: input.actionInvocationId,
      changeKind,
      displayCode: code,
      effectiveAt: now,
      evidenceRefs: [...input.evidenceRefs],
      normalizedCode: normalizeSku(code),
      packageDefinitionId: target.packageDefinitionId,
      productId: target.productId,
      reason: input.reason,
      revision,
      state,
      tenantId,
      variantId: target.variantId,
    });

  const assign = Effect.fn('SkuPersistence.assign')(function* assign(input: SkuChangeInput) {
    if (!validSkuChangeInput(input, tenantId) || input.expectedRevision !== 0) {
      return { _tag: 'invalid', reason: 'Invalid SKU assignment or initial revision' } as const;
    }
    const targetDecision = yield* resolveChangeTarget(input.target);
    const { target } = targetDecision;
    if (target === null) {
      return targetDecision.outcome;
    }
    const [priorInvocation] = yield* readAnyInvocation(input.actionInvocationId);
    if (priorInvocation !== undefined) {
      return priorInvocation.changeKind === 'ASSIGN' &&
        priorInvocation.normalizedCode === normalizeSku(input.code) &&
        priorInvocation.displayCode === input.code &&
        priorInvocation.variantId === target.variantId &&
        priorInvocation.packageDefinitionId === target.packageDefinitionId &&
        priorInvocation.actingPrincipalId === input.principalId &&
        sameEvidence(priorInvocation, input)
        ? ({ _tag: 'applied', revision: priorInvocation.revision } as const)
        : ({ _tag: 'conflict' } as const);
    }
    const [existing] = yield* transaction
      .select()
      .from(commercialSkuReservations)
      .where(reservationWhere(normalizeSku(input.code)))
      .limit(1)
      .pipe(Effect.mapError(unavailable));
    if (existing !== undefined) {
      return { _tag: 'conflict' } as const;
    }
    const [targetCurrent] = yield* transaction
      .select({ normalizedCode: commercialSkuReservations.normalizedCode })
      .from(commercialSkuReservations)
      .where(
        and(
          eq(commercialSkuReservations.tenantId, tenantId),
          ...(target.packageDefinitionId === null
            ? [
                eq(commercialSkuReservations.variantId, target.variantId),
                isNull(commercialSkuReservations.packageDefinitionId),
              ]
            : [eq(commercialSkuReservations.packageDefinitionId, target.packageDefinitionId)]),
          eq(commercialSkuReservations.state, 'CURRENT'),
        ),
      )
      .limit(1)
      .pipe(Effect.mapError(unavailable));
    if (targetCurrent !== undefined) {
      return { _tag: 'conflict' } as const;
    }
    const now = DateTime.toDateUtc(yield* DateTime.now);
    const [inserted] = yield* transaction
      .insert(commercialSkuReservations)
      .values({
        currentRevision: 1,
        displayCode: input.code,
        normalizedCode: normalizeSku(input.code),
        packageDefinitionId: target.packageDefinitionId,
        productId: target.productId,
        state: 'CURRENT',
        tenantId,
        updatedAt: now,
        variantId: target.variantId,
      })
      .onConflictDoNothing()
      .returning()
      .pipe(Effect.mapError(unavailable));
    if (inserted === undefined) {
      return { _tag: 'conflict' } as const;
    }
    yield* appendRevision(input, target, 1, 'ASSIGN', now).pipe(Effect.mapError(unavailable));
    return { _tag: 'applied', revision: 1 } as const;
  });

  const correct = Effect.fn('SkuPersistence.correct')(function* correct(input: SkuCorrectionInput) {
    if (
      !validSkuChangeInput(input, tenantId) ||
      input.expectedRevision < 1 ||
      input.previousTarget.tenantId !== tenantId
    ) {
      return { _tag: 'invalid', reason: 'Invalid documented SKU correction' } as const;
    }
    const targetDecision = yield* resolveChangeTarget(input.target);
    const { target } = targetDecision;
    if (target === null) {
      return targetDecision.outcome;
    }
    const [priorInvocation] = yield* readAnyInvocation(input.actionInvocationId);
    if (priorInvocation !== undefined) {
      return priorInvocation.changeKind === 'CORRECT' &&
        priorInvocation.normalizedCode === normalizeSku(input.code) &&
        priorInvocation.variantId === target.variantId &&
        priorInvocation.packageDefinitionId === target.packageDefinitionId &&
        priorInvocation.actingPrincipalId === input.principalId &&
        sameEvidence(priorInvocation, input)
        ? ({ _tag: 'applied', revision: priorInvocation.revision } as const)
        : ({ _tag: 'conflict' } as const);
    }
    const [existing] = yield* transaction
      .select()
      .from(commercialSkuReservations)
      .where(reservationWhere(normalizeSku(input.code)))
      .for('update')
      .limit(1)
      .pipe(Effect.mapError(unavailable));
    if (existing === undefined) {
      return { _tag: 'not_found' } as const;
    }
    if (existing.currentRevision !== input.expectedRevision) {
      return { _tag: 'stale', actualRevision: existing.currentRevision } as const;
    }
    if (!sameTarget(existing, input.previousTarget) || existing.state !== 'CURRENT') {
      return { _tag: 'conflict' } as const;
    }
    if (unchangedCorrection(existing, input)) {
      return { _tag: 'invalid', reason: 'Correction requires a changed exact target or display code' } as const;
    }
    // The reservation being corrected is the expected Current row for a display-only correction.
    const [targetCurrent] = yield* transaction
      .select({ normalizedCode: commercialSkuReservations.normalizedCode })
      .from(commercialSkuReservations)
      .where(
        and(
          eq(commercialSkuReservations.tenantId, tenantId),
          ...(target.packageDefinitionId === null
            ? [
                eq(commercialSkuReservations.variantId, target.variantId),
                isNull(commercialSkuReservations.packageDefinitionId),
              ]
            : [eq(commercialSkuReservations.packageDefinitionId, target.packageDefinitionId)]),
          ne(commercialSkuReservations.normalizedCode, normalizeSku(input.code)),
          eq(commercialSkuReservations.state, 'CURRENT'),
        ),
      )
      .limit(1)
      .pipe(Effect.mapError(unavailable));
    if (targetCurrent !== undefined) {
      return { _tag: 'conflict' } as const;
    }
    const now = DateTime.toDateUtc(yield* DateTime.now);
    const [updated] = yield* transaction
      .update(commercialSkuReservations)
      .set({
        currentRevision: existing.currentRevision + 1,
        displayCode: input.code,
        packageDefinitionId: target.packageDefinitionId,
        productId: target.productId,
        updatedAt: now,
        variantId: target.variantId,
      })
      .where(
        and(
          reservationWhere(normalizeSku(input.code)),
          eq(commercialSkuReservations.currentRevision, input.expectedRevision),
        ),
      )
      .returning()
      .pipe(Effect.mapError(unavailable));
    if (updated === undefined) {
      return { _tag: 'stale', actualRevision: existing.currentRevision } as const;
    }
    yield* appendRevision(input, target, updated.currentRevision, 'CORRECT', now).pipe(Effect.mapError(unavailable));
    return { _tag: 'applied', revision: updated.currentRevision } as const;
  });

  /* oxlint-disable eslint/complexity -- One transaction coordinates two reservations, CAS, and two append-only revisions. expires: 2027-03-31. */
  const rename = Effect.fn('SkuPersistence.rename')(function* rename(input: SkuRenameInput) {
    const oldNormalized = normalizeSku(input.oldCode);
    const newNormalized = normalizeSku(input.code);
    if (
      !validSkuChangeInput(input, tenantId) ||
      input.expectedRevision < 1 ||
      oldNormalized.length === 0 ||
      oldNormalized === newNormalized
    ) {
      return { _tag: 'invalid', reason: 'Invalid SKU rename or unchanged comparison code' } as const;
    }
    const targetDecision = yield* resolveChangeTarget(input.target);
    const { target } = targetDecision;
    if (target === null) {
      return targetDecision.outcome;
    }
    const [anyInvocation] = yield* readAnyInvocation(input.actionInvocationId);
    if (anyInvocation !== undefined) {
      const [[newRevision], [oldRevision]] = yield* Effect.all(
        [
          readInvocation(input.actionInvocationId, newNormalized),
          readInvocation(input.actionInvocationId, oldNormalized),
        ],
        { concurrency: 2 },
      );
      return newRevision?.changeKind === 'RENAME' &&
        oldRevision?.changeKind === 'RENAME' &&
        newRevision.displayCode === input.code &&
        oldRevision.normalizedCode === oldNormalized &&
        newRevision.variantId === target.variantId &&
        oldRevision.variantId === target.variantId &&
        newRevision.packageDefinitionId === target.packageDefinitionId &&
        oldRevision.packageDefinitionId === target.packageDefinitionId &&
        newRevision.actingPrincipalId === input.principalId &&
        sameEvidence(newRevision, input) &&
        sameEvidence(oldRevision, input)
        ? ({ _tag: 'applied', revision: newRevision.revision } as const)
        : ({ _tag: 'conflict' } as const);
    }
    const [old] = yield* transaction
      .select()
      .from(commercialSkuReservations)
      .where(reservationWhere(oldNormalized))
      .for('update')
      .limit(1)
      .pipe(Effect.mapError(unavailable));
    if (old === undefined) {
      return { _tag: 'not_found' } as const;
    }
    if (old.currentRevision !== input.expectedRevision) {
      return { _tag: 'stale', actualRevision: old.currentRevision } as const;
    }
    if (!sameTarget(old, input.target) || old.state !== 'CURRENT') {
      return { _tag: 'conflict' } as const;
    }
    const now = DateTime.toDateUtc(yield* DateTime.now);
    // Reserve the new code before changing the old one. A concurrent claimant
    // loses at the tenant-wide PK, leaving this transaction without partial changes.
    const [newReservation] = yield* transaction
      .insert(commercialSkuReservations)
      .values({
        currentRevision: 1,
        displayCode: input.code,
        normalizedCode: newNormalized,
        packageDefinitionId: target.packageDefinitionId,
        productId: target.productId,
        state: 'HISTORICAL',
        tenantId,
        updatedAt: now,
        variantId: target.variantId,
      })
      .onConflictDoNothing()
      .returning()
      .pipe(Effect.mapError(unavailable));
    if (newReservation === undefined) {
      return { _tag: 'conflict' } as const;
    }
    const [oldHistorical] = yield* transaction
      .update(commercialSkuReservations)
      .set({ currentRevision: old.currentRevision + 1, state: 'HISTORICAL', updatedAt: now })
      .where(
        and(reservationWhere(oldNormalized), eq(commercialSkuReservations.currentRevision, input.expectedRevision)),
      )
      .returning()
      .pipe(Effect.mapError(unavailable));
    if (oldHistorical === undefined) {
      return yield* unavailable();
    }
    const [newCurrent] = yield* transaction
      .update(commercialSkuReservations)
      .set({ state: 'CURRENT', updatedAt: now })
      .where(reservationWhere(newNormalized))
      .returning()
      .pipe(Effect.mapError(unavailable));
    if (newCurrent === undefined) {
      return yield* unavailable();
    }
    yield* appendRevision(
      input,
      target,
      oldHistorical.currentRevision,
      'RENAME',
      now,
      old.displayCode,
      'HISTORICAL',
    ).pipe(Effect.mapError(unavailable));
    yield* appendRevision(input, target, 1, 'RENAME', now).pipe(Effect.mapError(unavailable));
    return { _tag: 'applied', revision: 1 } as const;
  });
  /* oxlint-enable eslint/complexity */

  return { assign, correct, lookup, rename };
};
