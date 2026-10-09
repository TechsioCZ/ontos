import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { and, eq } from 'drizzle-orm';
import { Effect, Schema } from 'effect';

import type { CreateProductUnitPayload } from '../../shared/actions/create-product-unit.ts';
import type { RetireProductUnitPayload } from '../../shared/actions/retire-product-unit.ts';
import type { ReviseProductUnitPayload } from '../../shared/actions/revise-product-unit.ts';
import type { SetProductUnitTargetDivisibilityPayload } from '../../shared/actions/set-product-unit-target-divisibility.ts';
import { ProductUnitRuleInputSchema } from '../../shared/actions/product-unit-contract.ts';
import {
  ProductUnitRefSchema,
  ProductUnitRuleRevisionSchema,
  ProductUnitTargetDivisibilitySchema,
} from '../../shared/resources/product-unit.ts';
import {
  packageUnitDivisibility,
  packageUnitDivisibilityRevisions,
  productUnitRuleRevisions,
  productUnits,
  variantUnitDivisibility,
  variantUnitDivisibilityRevisions,
} from '../database/schema.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];
type UnitRow = typeof productUnits.$inferSelect;
interface Evidence {
  readonly actionInvocationId: string;
  readonly principalId: string;
}
type Input<Payload> = Evidence & { readonly payload: Payload };
type Target = SetProductUnitTargetDivisibilityPayload['target'];
type ExpectedSources = SetProductUnitTargetDivisibilityPayload['expectedSources'];
const unitType = 'commerce.catalog.product-unit';

export class ProductUnitPersistenceUnavailable extends Schema.TaggedError<ProductUnitPersistenceUnavailable>()(
  'ProductUnitPersistenceUnavailable',
  { code: Schema.Literal('product_unit_persistence_unavailable'), reason: Schema.String },
) {}

const ProductUnitMutationOutcomeSchema = Schema.Union([
  Schema.TaggedStruct('created', {
    ruleRevision: ProductUnitRuleRevisionSchema,
    targetDivisibility: Schema.optionalKey(ProductUnitTargetDivisibilitySchema),
    unit: ProductUnitRefSchema,
  }),
  Schema.TaggedStruct('revised', {
    ruleRevision: ProductUnitRuleRevisionSchema,
    targetDivisibility: Schema.optionalKey(ProductUnitTargetDivisibilitySchema),
    unit: ProductUnitRefSchema,
  }),
  Schema.TaggedStruct('retired', {
    ruleRevision: ProductUnitRuleRevisionSchema,
    targetDivisibility: Schema.optionalKey(ProductUnitTargetDivisibilitySchema),
    unit: ProductUnitRefSchema,
  }),
  Schema.TaggedStruct('divisibility_set', {
    ruleRevision: ProductUnitRuleRevisionSchema,
    targetDivisibility: ProductUnitTargetDivisibilitySchema,
    unit: ProductUnitRefSchema,
  }),
  Schema.TaggedStruct('invalid', { reason: Schema.String }),
  Schema.TaggedStruct('not_found', {}),
  Schema.TaggedStruct('stale', { actualRevision: Schema.Finite }),
]);
export type ProductUnitMutationOutcome = typeof ProductUnitMutationOutcomeSchema.Type;

export interface ProductUnitPersistence {
  readonly create: (
    input: Input<CreateProductUnitPayload>,
  ) => Effect.Effect<ProductUnitMutationOutcome, ProductUnitPersistenceUnavailable>;
  readonly retire: (
    input: Input<RetireProductUnitPayload>,
  ) => Effect.Effect<ProductUnitMutationOutcome, ProductUnitPersistenceUnavailable>;
  readonly revise: (
    input: Input<ReviseProductUnitPayload>,
  ) => Effect.Effect<ProductUnitMutationOutcome, ProductUnitPersistenceUnavailable>;
  readonly setTargetDivisibility: (
    input: Input<SetProductUnitTargetDivisibilityPayload>,
  ) => Effect.Effect<ProductUnitMutationOutcome, ProductUnitPersistenceUnavailable>;
}

/** Supplied by an owner-local Current-basis service; request metadata never proves Current. */
export interface ProductUnitTargetBasis {
  readonly verify: (
    target: Target,
    expectedSources: ExpectedSources,
  ) => Effect.Effect<'valid' | 'invalid' | 'stale', ProductUnitPersistenceUnavailable>;
}

const unavailable = (cause?: unknown) => {
  const failure = new ProductUnitPersistenceUnavailable({
    code: 'product_unit_persistence_unavailable',
    reason: 'Authoritative Product Unit basis or persistence is unavailable',
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

const validRef = (ref: typeof ProductUnitRefSchema.Type, tenantId: string) =>
  Schema.is(ProductUnitRefSchema)(ref) &&
  ref.moduleId === 'commerce.catalog' &&
  ref.resourceType === unitType &&
  ref.tenantId === tenantId;

const validRounding = Schema.is(Schema.Literals(['UP', 'DOWN', 'HALF_UP']));

const validEvidence = (
  input: Evidence & { readonly payload: { readonly evidenceRefs: readonly string[]; readonly reason: string } },
) =>
  input.payload.reason.length > 0 &&
  input.payload.reason.length <= 1000 &&
  input.payload.reason === input.payload.reason.trim() &&
  input.payload.evidenceRefs.length > 0 &&
  input.payload.evidenceRefs.every((ref) => ref.length > 0 && ref.length <= 300 && ref === ref.trim());

const validTargetInput = (input: Input<SetProductUnitTargetDivisibilityPayload>, tenantId: string) =>
  validRef(input.payload.target.unit, tenantId) && input.payload.target.tenantId === tenantId && validEvidence(input);

const targetCurrentConflict = (
  current: { readonly currentRevision: number; readonly unitId: string } | undefined,
  expectedCurrentRevision: number | undefined,
  unitId: string,
): ProductUnitMutationOutcome | undefined => {
  if (current === undefined && expectedCurrentRevision !== undefined) {
    return { _tag: 'stale', actualRevision: 0 };
  }
  if (current !== undefined && expectedCurrentRevision !== current.currentRevision) {
    return { _tag: 'stale', actualRevision: current.currentRevision };
  }
  if (current !== undefined && current.unitId !== unitId) {
    return { _tag: 'invalid', reason: 'Target Unit identity cannot be silently reassigned' };
  }
  return undefined;
};

const makeResult = Effect.fn('ProductUnitPersistence.makeResult')(function* makeResult(input: {
  readonly row: UnitRow;
  readonly rule: { readonly revision: number; readonly rounding: 'UP' | 'DOWN' | 'HALF_UP'; readonly step: string };
  readonly tag: 'created' | 'revised' | 'retired' | 'divisibility_set';
  readonly targetDivisibility?: typeof ProductUnitTargetDivisibilitySchema.Type;
}) {
  const { row, rule, tag, targetDivisibility } = input;
  const unit = yield* Schema.decodeEffect(ProductUnitRefSchema)({
    moduleId: 'commerce.catalog',
    resourceId: row.unitId,
    resourceType: unitType,
    tenantId: row.tenantId,
  });
  const ruleRevision = yield* Schema.decodeEffect(ProductUnitRuleRevisionSchema)({
    revision: rule.revision,
    rounding: rule.rounding,
    step: rule.step,
    unit,
  });
  if (tag === 'divisibility_set') {
    if (targetDivisibility === undefined) {
      return yield* unavailable();
    }
    return { _tag: tag, ruleRevision, targetDivisibility, unit };
  }
  return { _tag: tag, ruleRevision, unit };
}, Effect.mapError(unavailable));

/** Core owns transaction, scope verification and RLS setting; every query also predicates tenant. */
export const productUnitPersistenceForScope = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
  basis?: ProductUnitTargetBasis,
): ProductUnitPersistence => {
  const { tenantId } = scope;
  const getUnit = (unitId: string) =>
    transaction
      .select()
      .from(productUnits)
      .where(and(eq(productUnits.tenantId, tenantId), eq(productUnits.unitId, unitId)))
      .for('update')
      .limit(1)
      .pipe(Effect.mapError(unavailable));
  const getRule = (unitId: string, revision: number) =>
    transaction
      .select()
      .from(productUnitRuleRevisions)
      .where(
        and(
          eq(productUnitRuleRevisions.tenantId, tenantId),
          eq(productUnitRuleRevisions.unitId, unitId),
          eq(productUnitRuleRevisions.revision, revision),
        ),
      )
      .limit(1)
      .pipe(Effect.mapError(unavailable));
  const appendRule = (
    row: UnitRow,
    input: Evidence & { readonly payload: { readonly evidenceRefs: readonly string[]; readonly reason: string } },
    rule: { readonly rounding: 'UP' | 'DOWN' | 'HALF_UP'; readonly step: string },
    changeKind: string,
  ) =>
    transaction
      .insert(productUnitRuleRevisions)
      .values({
        actingPrincipalId: input.principalId,
        actionInvocationId: input.actionInvocationId,
        changeKind,
        evidenceRefs: [...input.payload.evidenceRefs],
        lifecycleState: row.lifecycleState,
        reason: input.payload.reason,
        revision: row.currentRuleRevision,
        rounding: rule.rounding,
        step: rule.step,
        tenantId,
        unitId: row.unitId,
      })
      .pipe(Effect.mapError(unavailable));

  const create: ProductUnitPersistence['create'] = Effect.fn('ProductUnitPersistence.create')(function* create(input) {
    const { code, label, rule, unitRef } = input.payload;
    if (
      !validRef(unitRef, tenantId) ||
      !validEvidence(input) ||
      !Schema.is(ProductUnitRuleInputSchema)(rule) ||
      code.length === 0 ||
      code.length > 80 ||
      code !== code.trim() ||
      label.length === 0 ||
      label.length > 240 ||
      label !== label.trim()
    ) {
      return { _tag: 'invalid', reason: 'Product Unit meaning, rule or evidence is invalid' };
    }
    const [existing] = yield* getUnit(unitRef.resourceId);
    if (existing !== undefined) {
      return { _tag: 'invalid', reason: 'Product Unit identity already exists' };
    }
    const [row] = yield* transaction
      .insert(productUnits)
      .values({ code, currentRuleRevision: 1, label, lifecycleState: 'ACTIVE', tenantId, unitId: unitRef.resourceId })
      .returning()
      .pipe(Effect.mapError(unavailable));
    if (row === undefined) {
      return yield* unavailable();
    }
    yield* appendRule(row, input, rule, 'CREATED');
    return yield* makeResult({ row, rule: { revision: 1, ...rule }, tag: 'created' });
  });

  const revise: ProductUnitPersistence['revise'] = Effect.fn('ProductUnitPersistence.revise')(function* revise(input) {
    const { expectedCurrent, rule } = input.payload;
    if (
      !validRef(expectedCurrent.unit, tenantId) ||
      !validEvidence(input) ||
      !Schema.is(ProductUnitRuleInputSchema)(rule)
    ) {
      return { _tag: 'invalid', reason: 'Product Unit rule or evidence is invalid' };
    }
    const [row] = yield* getUnit(expectedCurrent.unit.resourceId);
    if (row === undefined) {
      return { _tag: 'not_found' };
    }
    if (row.currentRuleRevision !== expectedCurrent.revision) {
      return { _tag: 'stale', actualRevision: row.currentRuleRevision };
    }
    if (row.lifecycleState !== 'ACTIVE') {
      return { _tag: 'invalid', reason: 'Retired Product Unit cannot be revised' };
    }
    const [prior] = yield* getRule(row.unitId, row.currentRuleRevision);
    if (prior === undefined) {
      return yield* unavailable();
    }
    const [updated] = yield* transaction
      .update(productUnits)
      .set({ currentRuleRevision: row.currentRuleRevision + 1 })
      .where(
        and(
          eq(productUnits.tenantId, tenantId),
          eq(productUnits.unitId, row.unitId),
          eq(productUnits.currentRuleRevision, row.currentRuleRevision),
          eq(productUnits.lifecycleState, 'ACTIVE'),
        ),
      )
      .returning()
      .pipe(Effect.mapError(unavailable));
    if (updated === undefined) {
      return { _tag: 'stale', actualRevision: row.currentRuleRevision };
    }
    yield* appendRule(updated, input, rule, 'REVISED');
    return yield* makeResult({
      row: updated,
      rule: { revision: updated.currentRuleRevision, ...rule },
      tag: 'revised',
    });
  });

  const retire: ProductUnitPersistence['retire'] = Effect.fn('ProductUnitPersistence.retire')(function* retire(input) {
    const { expectedCurrent } = input.payload;
    if (!validRef(expectedCurrent.unit, tenantId) || !validEvidence(input)) {
      return { _tag: 'invalid', reason: 'Product Unit reference or evidence is invalid' };
    }
    const [row] = yield* getUnit(expectedCurrent.unit.resourceId);
    if (row === undefined) {
      return { _tag: 'not_found' };
    }
    if (row.currentRuleRevision !== expectedCurrent.revision) {
      return { _tag: 'stale', actualRevision: row.currentRuleRevision };
    }
    if (row.lifecycleState !== 'ACTIVE') {
      return { _tag: 'invalid', reason: 'Product Unit is already retired' };
    }
    const [prior] = yield* getRule(row.unitId, row.currentRuleRevision);
    if (prior === undefined) {
      return yield* unavailable();
    }
    const [updated] = yield* transaction
      .update(productUnits)
      .set({ currentRuleRevision: row.currentRuleRevision + 1, lifecycleState: 'RETIRED' })
      .where(
        and(
          eq(productUnits.tenantId, tenantId),
          eq(productUnits.unitId, row.unitId),
          eq(productUnits.currentRuleRevision, row.currentRuleRevision),
          eq(productUnits.lifecycleState, 'ACTIVE'),
        ),
      )
      .returning()
      .pipe(Effect.mapError(unavailable));
    if (updated === undefined) {
      return { _tag: 'stale', actualRevision: row.currentRuleRevision };
    }
    if (prior.rounding !== 'UP' && prior.rounding !== 'DOWN' && prior.rounding !== 'HALF_UP') {
      return yield* unavailable();
    }
    yield* appendRule(updated, input, { rounding: prior.rounding, step: prior.step }, 'RETIRED');
    return yield* makeResult({
      row: updated,
      rule: {
        revision: updated.currentRuleRevision,
        rounding: prior.rounding,
        step: prior.step,
      },
      tag: 'retired',
    });
  });

  const writeTargetRevision = Effect.fn('ProductUnitPersistence.writeTargetRevision')(
    function* writeTargetRevision(input: {
      readonly action: Input<SetProductUnitTargetDivisibilityPayload>;
      readonly current: { readonly currentRevision: number } | undefined;
      readonly revision: number;
      readonly unit: UnitRow;
    }) {
      const { action, current, revision, unit } = input;
      const { divisible, target } = action.payload;
      if (target.targetType === 'commerce.catalog.variant') {
        if (current === undefined) {
          yield* transaction.insert(variantUnitDivisibility).values({
            currentRevision: revision,
            divisible,
            tenantId,
            unitId: unit.unitId,
            variantId: target.targetId,
          });
        } else {
          const [updated] = yield* transaction
            .update(variantUnitDivisibility)
            .set({ currentRevision: revision, divisible })
            .where(
              and(
                eq(variantUnitDivisibility.tenantId, tenantId),
                eq(variantUnitDivisibility.variantId, target.targetId),
                eq(variantUnitDivisibility.currentRevision, current.currentRevision),
              ),
            )
            .returning();
          if (updated === undefined) {
            return false;
          }
        }
        yield* transaction.insert(variantUnitDivisibilityRevisions).values({
          actingPrincipalId: action.principalId,
          actionInvocationId: action.actionInvocationId,
          divisible,
          evidenceRefs: [...action.payload.evidenceRefs],
          reason: action.payload.reason,
          revision,
          tenantId,
          unitId: unit.unitId,
          variantId: target.targetId,
        });
      } else {
        if (current === undefined) {
          yield* transaction.insert(packageUnitDivisibility).values({
            currentRevision: revision,
            divisible,
            packageDefinitionId: target.targetId,
            tenantId,
            unitId: unit.unitId,
          });
        } else {
          const [updated] = yield* transaction
            .update(packageUnitDivisibility)
            .set({ currentRevision: revision, divisible })
            .where(
              and(
                eq(packageUnitDivisibility.tenantId, tenantId),
                eq(packageUnitDivisibility.packageDefinitionId, target.targetId),
                eq(packageUnitDivisibility.currentRevision, current.currentRevision),
              ),
            )
            .returning();
          if (updated === undefined) {
            return false;
          }
        }
        yield* transaction.insert(packageUnitDivisibilityRevisions).values({
          actingPrincipalId: action.principalId,
          actionInvocationId: action.actionInvocationId,
          divisible,
          evidenceRefs: [...action.payload.evidenceRefs],
          packageDefinitionId: target.targetId,
          reason: action.payload.reason,
          revision,
          tenantId,
          unitId: unit.unitId,
        });
      }
      return true;
    },
    Effect.mapError(unavailable),
  );

  const setTargetDivisibility: ProductUnitPersistence['setTargetDivisibility'] = Effect.fn(
    'ProductUnitPersistence.setTargetDivisibility',
  )(function* setTargetDivisibility(input) {
    const { divisible, expectedCurrentRevision, expectedSources, target } = input.payload;
    if (!validTargetInput(input, tenantId)) {
      return { _tag: 'invalid', reason: 'Product Unit target or evidence is invalid' };
    }
    const [unit] = yield* getUnit(target.unit.resourceId);
    if (unit === undefined) {
      return { _tag: 'not_found' };
    }
    if (unit.lifecycleState !== 'ACTIVE') {
      return { _tag: 'invalid', reason: 'Retired Product Unit cannot be assigned' };
    }
    const [rule] = yield* getRule(unit.unitId, unit.currentRuleRevision);
    if (rule === undefined || !validRounding(rule.rounding)) {
      return yield* unavailable();
    }
    const currentRounding = rule.rounding;
    if (basis === undefined) {
      return yield* unavailable();
    }
    const basisResult = yield* basis.verify(target, expectedSources);
    if (basisResult === 'invalid') {
      return { _tag: 'invalid', reason: 'Product Unit target is not an active Tenant-owned purchase target' };
    }
    if (basisResult === 'stale') {
      return { _tag: 'stale', actualRevision: 0 };
    }
    const variant = target.targetType === 'commerce.catalog.variant';
    const currentTable = variant ? variantUnitDivisibility : packageUnitDivisibility;
    const targetColumn = variant ? variantUnitDivisibility.variantId : packageUnitDivisibility.packageDefinitionId;
    const [current] = yield* transaction
      .select()
      .from(currentTable)
      .where(and(eq(currentTable.tenantId, tenantId), eq(targetColumn, target.targetId)))
      .for('update')
      .limit(1)
      .pipe(Effect.mapError(unavailable));
    const conflict = targetCurrentConflict(current, expectedCurrentRevision, unit.unitId);
    if (conflict !== undefined) {
      return conflict;
    }
    const revision = (current?.currentRevision ?? 0) + 1;
    if (!(yield* writeTargetRevision({ action: input, current, revision, unit }))) {
      return { _tag: 'stale', actualRevision: current?.currentRevision ?? 0 };
    }
    const targetDivisibility = yield* Schema.decodeEffect(ProductUnitTargetDivisibilitySchema)({
      divisible,
      revision,
      targetId: target.targetId,
      targetType: target.targetType,
      tenantId,
      unit: target.unit,
    }).pipe(Effect.mapError(unavailable));
    return yield* makeResult({
      row: unit,
      rule: { revision: rule.revision, rounding: currentRounding, step: rule.step },
      tag: 'divisibility_set',
      targetDivisibility,
    });
  });
  return { create, retire, revise, setTargetDivisibility };
};
