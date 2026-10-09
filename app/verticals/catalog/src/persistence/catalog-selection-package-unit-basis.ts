import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { and, eq } from 'drizzle-orm';
import { DateTime, Effect, Match, Option, Schema } from 'effect';

import type { CatalogSelection } from '../../shared/domain/catalog-selection-evidence.ts';
import { CatalogSelectionSchema } from '../../shared/domain/catalog-selection-evidence.ts';
import {
  packageContentRevisions,
  packageDefinitions,
  packageOptionRoleRevisions,
  packageUnitDivisibility,
  productUnitRuleRevisions,
  productUnits,
  productConfigurationDefinitions,
  productVariants,
  products,
  setCompositions,
  setCompositionRevisions,
  variantUnitDivisibility,
} from '../database/schema.ts';
import { CatalogPersistenceUnavailable } from './errors.ts';
import { resolveEffectiveRevision } from './package-persistence.ts';
import { productConfigurationPersistenceForScope } from './product-configuration-persistence.ts';
import { evaluateCurrentProductConfiguration } from './product-configuration-current-evaluator.ts';
import type {
  CurrentConfigurationAssessment,
  TrustedConfigurationTarget,
} from './product-configuration-current-evaluator.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];
type Content = typeof packageContentRevisions.$inferSelect;
type Definition = typeof packageDefinitions.$inferSelect;
type Role = typeof packageOptionRoleRevisions.$inferSelect;
interface Failure {
  readonly reason: string;
  readonly status: 'INVALID' | 'INDETERMINATE';
}

interface PackageContentStep {
  readonly amount: string;
  readonly configurationKey: string | null;
  readonly lowerCount: string | null;
  readonly packageDefinitionId: string;
  readonly revision: number;
  readonly unitId: string;
}

/** Product facts only. This never represents purchase-line quantity or an acceptance guarantee. */
type CatalogSelectionPackageUnitBasis =
  | {
      readonly configuration?: CurrentConfigurationAssessment;
      readonly contentPath: readonly PackageContentStep[];
      readonly optionRevision?: number;
      readonly productRevision: number;
      readonly setCompositionRevision?: number;
      readonly status: 'CURRENT';
      readonly unit: {
        readonly divisible: boolean;
        readonly id: string;
        readonly rounding: 'UP' | 'DOWN' | 'HALF_UP';
        readonly ruleRevision: number;
        readonly step: string;
        readonly targetDivisibilityRevision: number;
      };
      readonly variantRevision: number;
    }
  | Failure;

interface PackageWalkState {
  readonly failure?: Failure;
  readonly firstContent?: Content;
  readonly next: { readonly id: string; readonly revision: number } | null;
  readonly optionRevision?: number | undefined;
  readonly path: readonly PackageContentStep[];
  readonly previousContent?: Content;
  readonly visited: ReadonlySet<string>;
}

const positiveDecimal = (value: string): { readonly coefficient: bigint; readonly scale: number } | null => {
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) {
    return null;
  }
  const [whole = '', fraction = ''] = value.split('.');
  const coefficient = BigInt(`${whole}${fraction}`);
  return coefficient > 0n ? { coefficient, scale: fraction.length } : null;
};

const agreesWithLower = (upper: Content, lower: Content): boolean => {
  const amount = positiveDecimal(upper.amount);
  const lowerAmount = positiveDecimal(lower.amount);
  const count = upper.lowerCount === null ? null : positiveDecimal(upper.lowerCount);
  return (
    amount !== null &&
    lowerAmount !== null &&
    count !== null &&
    count.scale === 0 &&
    upper.unitResourceId === lower.unitResourceId &&
    upper.unitResourceType === lower.unitResourceType &&
    upper.configurationKey === lower.configurationKey &&
    upper.setCompositionResourceId === lower.setCompositionResourceId &&
    upper.setCompositionRevision === lower.setCompositionRevision &&
    amount.coefficient * 10n ** BigInt(lowerAmount.scale) ===
      count.coefficient * lowerAmount.coefficient * 10n ** BigInt(amount.scale)
  );
};

const fail = (status: Failure['status'], reason: string): Failure => ({ reason, status });
const missingContentReason = 'Exact Package Content owner proof is missing';
const revisionValid = (revision: number): boolean => Number.isSafeInteger(revision) && revision > 0;
const completeContentHistory = (definition: Definition, revisions: readonly Content[], id: string): boolean => {
  if (!revisionValid(definition.currentRevision) || revisions.length === 0) {
    return false;
  }
  const latest = revisions.length;
  if (latest !== definition.currentRevision && latest !== definition.currentRevision + 1) {
    return false;
  }
  // The definition pointer can lag exactly one immutable scheduled successor.
  // Effectivity is checked separately, so conflicting times remain INVALID.
  return revisions.every((revision) => revision.packageDefinitionId === id);
};
const contentAtRevision = (revisions: readonly Content[], revision: number): Content | undefined =>
  revisions.find((row) => row.revision === revision);
const effectiveContentRevision = (revisions: readonly Content[], at: Date): number | null =>
  Match.value(resolveEffectiveRevision(revisions, at)).pipe(
    Match.tag('invalid', () => null),
    Match.tag('resolved', ({ revision }) => revision),
    Match.exhaustive,
  );
const RoundingSchema = Schema.Literals(['UP', 'DOWN', 'HALF_UP']);
const activeAt = (at: Date, now: Date): boolean =>
  Option.isSome(DateTime.make(at)) &&
  DateTime.toEpochMillis(DateTime.makeUnsafe(at)) <= DateTime.toEpochMillis(DateTime.makeUnsafe(now));
const unavailable = (cause: unknown): CatalogPersistenceUnavailable => {
  const error = new CatalogPersistenceUnavailable({
    code: 'catalog_persistence_unavailable',
    reason: 'Catalog package and Unit basis is unavailable',
  });
  Object.defineProperty(error, 'cause', { configurable: true, value: cause });
  return error;
};

const assessContent = (
  definition: Definition | undefined,
  content: Content | undefined,
  productId: string,
  variantId: string,
  now: Date,
): Failure | undefined => {
  if (definition === undefined || content === undefined) {
    return fail('INDETERMINATE', missingContentReason);
  }
  if (
    definition.productId !== productId ||
    definition.variantId !== variantId ||
    content.productId !== productId ||
    content.variantId !== variantId
  ) {
    return fail('INVALID', 'Package Content targets another Product or Variant');
  }
  if (
    content.lifecycleState !== 'ACTIVE' ||
    content.unitResourceType !== 'commerce.catalog.product-unit' ||
    !activeAt(content.effectiveAt, now)
  ) {
    return fail('INVALID', 'Package Content is not currently usable');
  }
  if (
    (content.lowerPackageDefinitionId === null) !== (content.lowerRevision === null) ||
    (content.lowerRevision === null) !== (content.lowerCount === null)
  ) {
    return fail('INDETERMINATE', 'Lower Package Content edge is incomplete');
  }
  if (positiveDecimal(content.amount) === null) {
    return fail('INVALID', 'Package Content amount must be positive and exact');
  }
  if ((content.setCompositionResourceId === null) !== (content.setCompositionRevision === null)) {
    return fail('INDETERMINATE', 'Package Set Composition reference is incomplete');
  }
  if (content.lowerRevision !== null && !revisionValid(content.lowerRevision)) {
    return fail('INDETERMINATE', 'Lower Package Content revision is unusable');
  }
  return undefined;
};

const assessRole = (
  definition: Definition,
  role: Role | undefined,
  contentRevision: number,
  effectiveRevision: number,
  productId: string,
  variantId: string,
  now: Date,
): Failure | undefined => {
  if (
    definition.lifecycleState !== 'ACTIVE' ||
    definition.optionState !== 'ACTIVE' ||
    effectiveRevision !== contentRevision ||
    !revisionValid(definition.currentOptionRevision)
  ) {
    return fail('INVALID', 'Selected Package Option is not Current');
  }
  if (role === undefined) {
    return fail('INDETERMINATE', 'Current Package Option role proof is missing');
  }
  if (
    role.state !== 'ACTIVE' ||
    role.contentRevision !== contentRevision ||
    role.productId !== productId ||
    role.variantId !== variantId ||
    !role.independentlyRequested ||
    role.looseUnitsSubstitutable ||
    !activeAt(role.effectiveAt, now)
  ) {
    return fail('INVALID', 'Package Option role does not attest the selected content');
  }
  return undefined;
};

const readPackage = (
  transaction: ScopedTransaction,
  tenantId: string,
  first: { readonly id: string; readonly revision: number },
  productId: string,
  variantId: string,
  now: Date,
) =>
  Effect.suspend(() => {
    let state: PackageWalkState = { next: first, path: [], visited: new Set<string>() };
    return Effect.whileLoop({
      body: () =>
        Effect.gen(function* walkPackage() {
          const { next } = state;
          if (next === null) {
            return state;
          }
          if (state.visited.has(next.id) || state.visited.size >= 32) {
            return {
              ...state,
              failure: fail('INDETERMINATE', 'Package content path cycles or exceeds the supported bound'),
            };
          }
          const [definition] = yield* transaction
            .select()
            .from(packageDefinitions)
            .where(and(eq(packageDefinitions.tenantId, tenantId), eq(packageDefinitions.packageDefinitionId, next.id)))
            .limit(1);
          if (definition === undefined) {
            return { ...state, failure: fail('INDETERMINATE', missingContentReason) };
          }
          const revisions: Content[] = yield* transaction
            .select()
            .from(packageContentRevisions)
            .where(
              and(
                eq(packageContentRevisions.tenantId, tenantId),
                eq(packageContentRevisions.packageDefinitionId, definition.packageDefinitionId),
              ),
            );
          const content = contentAtRevision(revisions, next.revision);
          if (!completeContentHistory(definition, revisions, next.id)) {
            return { ...state, failure: fail('INDETERMINATE', missingContentReason) };
          }
          const contentFailure = assessContent(definition, content, productId, variantId, now);
          if (contentFailure !== undefined || definition === undefined || content === undefined) {
            return {
              ...state,
              failure: contentFailure ?? fail('INDETERMINATE', missingContentReason),
            };
          }
          if (state.previousContent !== undefined && !agreesWithLower(state.previousContent, content)) {
            return { ...state, failure: fail('INVALID', 'Higher Package Content disagrees with its lower revision') };
          }
          let { optionRevision } = state;
          if (state.path.length === 0) {
            const effectiveRevision = effectiveContentRevision(revisions, now);
            if (effectiveRevision === null) {
              return { ...state, failure: fail('INVALID', 'Package Content has no unambiguous effective revision') };
            }
            const [role] = yield* transaction
              .select()
              .from(packageOptionRoleRevisions)
              .where(
                and(
                  eq(packageOptionRoleRevisions.tenantId, tenantId),
                  eq(packageOptionRoleRevisions.packageDefinitionId, next.id),
                  eq(packageOptionRoleRevisions.revision, definition.currentOptionRevision),
                ),
              )
              .limit(1);
            const roleFailure = assessRole(
              definition,
              role,
              next.revision,
              effectiveRevision,
              productId,
              variantId,
              now,
            );
            if (roleFailure !== undefined || role === undefined) {
              return {
                ...state,
                failure: roleFailure ?? fail('INDETERMINATE', 'Current Package Option role proof is missing'),
              };
            }
            optionRevision = role.revision;
          }
          const step: PackageContentStep = {
            amount: content.amount,
            configurationKey: content.configurationKey,
            lowerCount: content.lowerCount,
            packageDefinitionId: next.id,
            revision: next.revision,
            unitId: content.unitResourceId,
          };
          const lower =
            content.lowerPackageDefinitionId === null || content.lowerRevision === null
              ? null
              : { id: content.lowerPackageDefinitionId, revision: content.lowerRevision };
          return {
            firstContent: state.firstContent ?? content,
            next: lower,
            optionRevision,
            path: [...state.path, step],
            previousContent: content,
            visited: new Set([...state.visited, next.id]),
          };
        }),
      step: (nextState) => {
        state = nextState;
      },
      while: () => state.next !== null && state.failure === undefined,
    }).pipe(Effect.map(() => state));
  });

const readSet = Effect.fn('CatalogSelectionPackageUnitBasis.readSet')(function* readSet(
  transaction: ScopedTransaction,
  tenantId: string,
  selected: CatalogSelection['setComposition'],
  productId: string,
  variantId: string,
  now: Date,
) {
  if (selected === undefined) {
    return { status: 'NONE' as const };
  }
  const id = selected.resourceRef.resourceId;
  const [composition] = yield* transaction
    .select()
    .from(setCompositions)
    .where(and(eq(setCompositions.tenantId, tenantId), eq(setCompositions.compositionId, id)))
    .limit(1);
  if (composition === undefined) {
    return fail('INDETERMINATE', 'Set Composition owner proof is missing');
  }
  const [revision] = yield* transaction
    .select()
    .from(setCompositionRevisions)
    .where(
      and(
        eq(setCompositionRevisions.tenantId, tenantId),
        eq(setCompositionRevisions.compositionId, composition.compositionId),
        eq(setCompositionRevisions.revision, selected.revision),
      ),
    )
    .limit(1);
  if (composition === undefined || revision === undefined) {
    return fail('INDETERMINATE', 'Set Composition owner proof is missing');
  }
  if (
    composition.productId !== productId ||
    composition.variantId !== variantId ||
    revision.productId !== productId ||
    revision.variantId !== variantId ||
    composition.currentRevision !== selected.revision ||
    revision.lifecycleState !== 'ACTIVE' ||
    !activeAt(revision.effectiveFrom, now) ||
    (revision.effectiveTo !== null && activeAt(revision.effectiveTo, now))
  ) {
    return fail('INVALID', 'Set Composition is not Current for this Variant');
  }
  return { revision: revision.revision, status: 'CURRENT' as const };
});

const readUnit = Effect.fn('CatalogSelectionPackageUnitBasis.readUnit')(function* readUnit(
  transaction: ScopedTransaction,
  tenantId: string,
  targetId: string,
  isPackage: boolean,
) {
  const [target] = isPackage
    ? yield* transaction
        .select()
        .from(packageUnitDivisibility)
        .where(
          and(
            eq(packageUnitDivisibility.tenantId, tenantId),
            eq(packageUnitDivisibility.packageDefinitionId, targetId),
          ),
        )
        .limit(1)
    : yield* transaction
        .select()
        .from(variantUnitDivisibility)
        .where(and(eq(variantUnitDivisibility.tenantId, tenantId), eq(variantUnitDivisibility.variantId, targetId)))
        .limit(1);
  if (target === undefined || !revisionValid(target.currentRevision)) {
    return fail('INDETERMINATE', 'Target Unit or divisibility proof is missing');
  }
  const [unit] = yield* transaction
    .select()
    .from(productUnits)
    .where(and(eq(productUnits.tenantId, tenantId), eq(productUnits.unitId, target.unitId)))
    .limit(1);
  if (unit === undefined || !revisionValid(unit.currentRuleRevision)) {
    return fail('INDETERMINATE', 'Current Unit proof is missing');
  }
  if (unit.lifecycleState !== 'ACTIVE') {
    return fail('INVALID', 'Product Unit is retired');
  }
  const [rule] = yield* transaction
    .select()
    .from(productUnitRuleRevisions)
    .where(
      and(
        eq(productUnitRuleRevisions.tenantId, tenantId),
        eq(productUnitRuleRevisions.unitId, unit.unitId),
        eq(productUnitRuleRevisions.revision, unit.currentRuleRevision),
      ),
    )
    .limit(1);
  if (rule === undefined || rule.lifecycleState !== 'ACTIVE') {
    return fail('INDETERMINATE', 'Current Unit rule is missing or unusable');
  }
  if (!Schema.is(RoundingSchema)(rule.rounding)) {
    return fail('INDETERMINATE', 'Current Unit rounding is unusable');
  }
  return {
    status: 'CURRENT' as const,
    unit: {
      divisible: target.divisible,
      id: unit.unitId,
      rounding: rule.rounding,
      ruleRevision: rule.revision,
      step: rule.step,
      targetDivisibilityRevision: target.currentRevision,
    },
  };
});

const readParents = Effect.fn('CatalogSelectionPackageUnitBasis.readParents')(function* readParents(
  transaction: ScopedTransaction,
  tenantId: string,
  selection: CatalogSelection,
) {
  const [product] = yield* transaction
    .select()
    .from(products)
    .where(and(eq(products.tenantId, tenantId), eq(products.productId, selection.productRef.resourceId)))
    .limit(1);
  if (product === undefined) {
    return fail('INDETERMINATE', 'Product owner proof is missing');
  }
  const [variant] = yield* transaction
    .select()
    .from(productVariants)
    .where(
      and(
        eq(productVariants.tenantId, tenantId),
        eq(productVariants.productId, product.productId),
        eq(productVariants.variantId, selection.variantRef.resourceId),
      ),
    )
    .limit(1);
  if (variant === undefined) {
    return fail('INDETERMINATE', 'Variant owner proof is missing');
  }
  if (
    variant.productId !== product.productId ||
    product.lifecycleState !== 'ACTIVE' ||
    variant.lifecycleState !== 'ACTIVE'
  ) {
    return fail('INVALID', 'Product and Variant must be active and owned together');
  }
  if (!revisionValid(product.currentRevision) || !revisionValid(variant.currentRevision)) {
    return fail('INDETERMINATE', 'Product or Variant revision is unusable');
  }
  return { product, status: 'CURRENT' as const, variant };
});

const assessBinding = (
  selection: CatalogSelection,
  packageBasis: PackageWalkState | undefined,
): Failure | undefined => {
  if (packageBasis?.path.some((step) => step.configurationKey !== null) ?? false) {
    return fail('INDETERMINATE', 'Configuration binding requires owner-issued complete-value proof');
  }
  const content = packageBasis?.firstContent;
  if (content === undefined) {
    return undefined;
  }
  const selectedSet = selection.setComposition;
  if (selectedSet === undefined && content.setCompositionResourceId !== null) {
    return fail('INVALID', 'Package Content binds an unselected Set Composition');
  }
  if (
    selectedSet !== undefined &&
    (content.setCompositionResourceId !== selectedSet.resourceRef.resourceId ||
      content.setCompositionRevision !== selectedSet.revision)
  ) {
    return fail('INVALID', 'Package Content and Set Composition differ');
  }
  return undefined;
};

const assessOmittedConfiguration = Effect.fn('CatalogSelectionPackageUnitBasis.assessOmittedConfiguration')(
  function* assessOmittedConfiguration(
    transaction: ScopedTransaction,
    scope: OperationalScope,
    productId: string,
    variantId: string,
    packageDefinitionId: string | undefined,
    now: Date,
    selectedDefinitionId?: string,
  ) {
    const definitions = yield* transaction
      .select({ definitionId: productConfigurationDefinitions.definitionId })
      .from(productConfigurationDefinitions)
      .where(
        and(
          eq(productConfigurationDefinitions.tenantId, scope.tenantId),
          eq(productConfigurationDefinitions.productId, productId),
        ),
      );
    if (selectedDefinitionId !== undefined && !definitions.some((item) => item.definitionId === selectedDefinitionId)) {
      return fail('INDETERMINATE', 'Selected Configuration definition is absent from owner applicability');
    }
    const results = yield* Effect.forEach(
      definitions.filter((definition) => definition.definitionId !== selectedDefinitionId),
      (definition) => {
        const target: TrustedConfigurationTarget = { definitionId: definition.definitionId, productId, variantId };
        if (packageDefinitionId !== undefined) {
          Object.assign(target, { packageDefinitionId });
        }
        return evaluateCurrentProductConfiguration(productConfigurationPersistenceForScope(transaction, scope), {
          at: now,
          target,
          values: [],
        }).pipe(Effect.orElseSucceed(() => null));
      },
      { concurrency: 1 },
    );
    if (results.some((assessment) => assessment === null || assessment.status === 'INDETERMINATE')) {
      return fail('INDETERMINATE', 'Configuration applicability proof is unavailable');
    }
    const invalid = results.find((assessment) => assessment?.status === 'INVALID');
    return invalid?.status === 'INVALID' ? fail('INVALID', `Configuration Current proof: ${invalid.code}`) : undefined;
  },
);

const assessSelectedConfiguration = Effect.fn('CatalogSelectionPackageUnitBasis.assessSelectedConfiguration')(
  function* assessSelectedConfiguration(
    transaction: ScopedTransaction,
    scope: OperationalScope,
    configuration: NonNullable<CatalogSelection['configuration']>,
    productId: string,
    variantId: string,
    packageDefinitionId: string | undefined,
    now: Date,
  ) {
    const target: TrustedConfigurationTarget = {
      definitionId: configuration.definition.resourceRef.resourceId,
      productId,
      variantId,
    };
    if (packageDefinitionId !== undefined) {
      Object.assign(target, { packageDefinitionId });
    }
    const assessment = yield* evaluateCurrentProductConfiguration(
      productConfigurationPersistenceForScope(transaction, scope),
      {
        at: now,
        target,
        values: configuration.choices.map((choice) =>
          choice.unit === undefined
            ? { choiceKey: choice.choiceKey, kind: 'SINGLE_CHOICE' as const, optionKey: choice.value }
            : {
                amount: choice.value,
                choiceKey: choice.choiceKey,
                kind: 'MEASURED_VALUE' as const,
                unitId: choice.unit.resourceRef.resourceId,
              },
        ),
      },
    ).pipe(Effect.orElseSucceed(() => null));
    if (assessment === null) {
      return fail('INDETERMINATE', 'Configuration owner Current proof is unavailable');
    }
    if (assessment.status !== 'VALID') {
      return fail(assessment.status, `Configuration Current proof: ${assessment.code}`);
    }
    if (
      assessment.definitionRevision !== configuration.definition.revision ||
      assessment.target.productId !== productId ||
      assessment.target.variantId !== variantId ||
      assessment.target.packageDefinitionId !== packageDefinitionId ||
      DateTime.toEpochMillis(DateTime.makeUnsafe(assessment.assessedAt)) !==
        DateTime.toEpochMillis(DateTime.makeUnsafe(now)) ||
      assessment.choiceRevisions.length !== configuration.choices.length ||
      configuration.choices.some((choice) => {
        const proven = assessment.choiceRevisions.find((item) => item.choiceKey === choice.choiceKey);
        return (
          proven === undefined ||
          (choice.unit === undefined
            ? proven.kind !== 'SINGLE_CHOICE'
            : proven.kind !== 'MEASURED_VALUE' ||
              proven.unitId !== choice.unit.resourceRef.resourceId ||
              proven.unitRevision !== choice.unit.revision)
        );
      }) ||
      assessment.choiceRevisions.some(
        (choice) =>
          choice.kind === 'MEASURED_VALUE' &&
          !assessment.unitRevisions.some(
            (unit) =>
              unit.ref.moduleId === 'commerce.catalog' &&
              unit.ref.resourceType === 'commerce.catalog.unit' &&
              unit.ref.tenantId === scope.tenantId &&
              unit.ref.resourceId === choice.unitId &&
              unit.revision === choice.unitRevision,
          ),
      )
    ) {
      return fail('INDETERMINATE', 'Configuration proof does not match exact target, choices, or Unit revisions');
    }
    return { assessment, status: 'PROVEN' as const };
  },
);

const selectionInputFailure = (selection: CatalogSelection, tenantId: string, now: Date): Failure | undefined => {
  if (
    !Schema.is(CatalogSelectionSchema)(selection) ||
    selection.productRef.tenantId !== tenantId ||
    selection.configuration?.choices.some(
      (choice) =>
        choice.unit !== undefined &&
        (choice.unit.resourceRef.moduleId !== 'commerce.catalog' ||
          choice.unit.resourceRef.resourceType !== 'commerce.catalog.unit' ||
          choice.unit.resourceRef.tenantId !== tenantId),
    ) === true
  ) {
    return fail('INVALID', 'Selection is malformed or outside the trusted Tenant');
  }
  return Option.isNone(DateTime.make(now))
    ? fail('INDETERMINATE', 'Trusted assessment time is unavailable')
    : undefined;
};

const assessSelectionConfiguration = Effect.fn('CatalogSelectionPackageUnitBasis.assessSelectionConfiguration')(
  function* assessSelectionConfiguration(
    transaction: ScopedTransaction,
    scope: OperationalScope,
    selection: CatalogSelection,
    productId: string,
    variantId: string,
    now: Date,
  ) {
    const packageDefinitionId = selection.packageOption?.optionRef.resourceId;
    if (selection.configuration === undefined) {
      const failure = yield* assessOmittedConfiguration(
        transaction,
        scope,
        productId,
        variantId,
        packageDefinitionId,
        now,
      );
      return failure ?? { status: 'PROVEN' as const };
    }
    const selected = yield* assessSelectedConfiguration(
      transaction,
      scope,
      selection.configuration,
      productId,
      variantId,
      packageDefinitionId,
      now,
    );
    if (selected.status !== 'PROVEN') {
      return selected;
    }
    const remainingFailure = yield* assessOmittedConfiguration(
      transaction,
      scope,
      productId,
      variantId,
      packageDefinitionId,
      now,
      selection.configuration.definition.resourceRef.resourceId,
    );
    return remainingFailure ?? selected;
  },
);

/** Read inside Core's scoped transaction; lower content edges remain pinned to exact revisions. */
export const catalogSelectionPackageUnitBasisForScope = (transaction: ScopedTransaction, scope: OperationalScope) => ({
  read: Effect.fn('CatalogSelectionPackageUnitBasis.read')(function* read(selection: CatalogSelection, now: Date) {
    const { tenantId } = scope;
    const inputFailure = selectionInputFailure(selection, tenantId, now);
    if (inputFailure !== undefined) {
      return inputFailure;
    }
    const parents = yield* readParents(transaction, tenantId, selection);
    if (parents.status !== 'CURRENT') {
      return parents;
    }
    const { product, variant } = parents;
    const option = selection.packageOption;
    const packageBasis =
      option === undefined
        ? undefined
        : yield* readPackage(
            transaction,
            tenantId,
            { id: option.optionRef.resourceId, revision: option.contentRevision.revision },
            product.productId,
            variant.variantId,
            now,
          );
    if (packageBasis?.failure !== undefined) {
      return packageBasis.failure;
    }
    const setBasis = yield* readSet(
      transaction,
      tenantId,
      selection.setComposition,
      product.productId,
      variant.variantId,
      now,
    );
    if (setBasis.status === 'INVALID' || setBasis.status === 'INDETERMINATE') {
      return setBasis;
    }
    const bindingFailure = assessBinding(selection, packageBasis);
    if (bindingFailure !== undefined) {
      return bindingFailure;
    }
    const configuration = yield* assessSelectionConfiguration(
      transaction,
      scope,
      selection,
      product.productId,
      variant.variantId,
      now,
    );
    if (configuration.status !== 'PROVEN') {
      return configuration;
    }
    const unitBasis = yield* readUnit(
      transaction,
      tenantId,
      option?.optionRef.resourceId ?? variant.variantId,
      option !== undefined,
    );
    if (unitBasis.status !== 'CURRENT') {
      return unitBasis;
    }
    const basis: CatalogSelectionPackageUnitBasis = {
      contentPath: packageBasis?.path ?? [],
      productRevision: product.currentRevision,
      status: 'CURRENT',
      unit: unitBasis.unit,
      variantRevision: variant.currentRevision,
    };
    if ('assessment' in configuration) {
      Object.assign(basis, { configuration: configuration.assessment });
    }
    if (basis.status === 'CURRENT') {
      if (packageBasis?.optionRevision !== undefined) {
        Object.assign(basis, { optionRevision: packageBasis.optionRevision });
      }
      if (setBasis.status === 'CURRENT') {
        Object.assign(basis, { setCompositionRevision: setBasis.revision });
      }
    }
    return basis;
  }, Effect.mapError(unavailable)),
});
