import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { and, eq } from 'drizzle-orm';
import { Crypto, DateTime, Effect, Match, Option, Schema } from 'effect';

import {
  CatalogRevisionNumberSchema,
  sameCatalogRevisionReference,
} from '../../shared/domain/catalog-revision-reference.ts';
import {
  CatalogSelectionBasisSchema,
  CatalogSelectionMembershipSchema,
  sameCatalogSelectionBasis,
} from '../../shared/domain/catalog-selection-evidence.ts';
import type { CatalogSelection } from '../../shared/domain/catalog-selection-evidence.ts';
import type { CatalogSelectionCurrentFacts } from '../../shared/domain/catalog-selection-assessment.ts';
import { deriveClassification } from '../../shared/domain/category-classification.ts';
import { catalogSelectionPurposeRequiresCategory } from '../../shared/domain/catalog-selection-purpose.ts';
import type { SetCompositionRevision } from '../../shared/domain/set-composition.ts';
import {
  productCategories,
  productCategoryAssignments,
  productCategoryHierarchyRevisions,
  productVariants,
  products,
  setCompositions,
} from '../database/schema.ts';
import { CatalogPersistenceUnavailable } from './errors.ts';
import { catalogSelectionPackageUnitBasisForScope } from './catalog-selection-package-unit-basis.ts';
import { effectiveAttributeValueReadsForScope } from './effective-attribute-value-reads.ts';
import { productConfigurationPersistenceForScope } from './product-configuration-persistence.ts';
import { evaluateCurrentProductConfiguration } from './product-configuration-current-evaluator.ts';
import type {
  CurrentConfigurationAssessment,
  TrustedConfigurationTarget,
} from './product-configuration-current-evaluator.ts';
import { productSelectionTypeValueAxisBasisForScope } from './product-type-readiness-source.ts';
import { setCompositionComponentCurrentBasisForScope } from './set-composition-component-current-basis.ts';
import type { SetComponentDependencyRevision } from './set-composition-component-current-basis.ts';
import { setCompositionPersistenceForScope } from './set-composition-persistence.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];
const catalogModuleId = 'commerce.catalog';
const attributeDefinitionType = 'commerce.catalog.attribute-definition';
const packageDefinitionType = 'commerce.catalog.package-definition';
const productUnitType = 'commerce.catalog.product-unit';
const variantType = 'commerce.catalog.variant';
const configurationDefinitionType = 'commerce.catalog.configuration-definition';
const catalogUnitType = 'commerce.catalog.unit';
const productCategoryType = 'commerce.catalog.product-category';

const unavailable = (cause: unknown): CatalogPersistenceUnavailable => {
  const failure = new CatalogPersistenceUnavailable({
    code: 'catalog_persistence_unavailable',
    reason: 'Catalog Current basis is temporarily unavailable',
  });
  Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  return failure;
};

const validRequest = (selection: CatalogSelection, purpose: string, tenantId: string): boolean =>
  selection.productRef.tenantId === tenantId &&
  selection.variantRef.tenantId === tenantId &&
  selection.productRef.moduleId === catalogModuleId &&
  selection.variantRef.moduleId === catalogModuleId &&
  selection.productRef.resourceType === 'commerce.catalog.product' &&
  selection.variantRef.resourceType === variantType &&
  purpose.length > 0 &&
  purpose === purpose.trim();

const validDependentRef = (
  ref: { readonly moduleId: string; readonly resourceType: string; readonly tenantId: string },
  tenantId: string,
  resourceType: string,
): boolean => ref.moduleId === catalogModuleId && ref.resourceType === resourceType && ref.tenantId === tenantId;

const requestProblem = (
  selection: CatalogSelection,
  purpose: string,
  tenantId: string,
): { readonly reason: string; readonly status: 'INVALID' | 'INDETERMINATE' } | null => {
  if (!validRequest(selection, purpose, tenantId)) {
    return { reason: 'Selection scope or purpose cannot be verified', status: 'INDETERMINATE' };
  }
  if (
    selection.packageOption?.contentRevision.revisionId !== undefined ||
    selection.configuration?.choices.some((choice) => choice.attributeDefinition?.revisionId !== undefined) === true
  ) {
    return { reason: 'Selected dependent revision ID is not owner-verifiable', status: 'INDETERMINATE' };
  }
  return selection.configuration?.choices.some(
    (choice) => choice.unit !== undefined && !validDependentRef(choice.unit.resourceRef, tenantId, catalogUnitType),
  ) === true
    ? { reason: 'Selected Configuration Unit reference is not a Catalog Unit in the trusted Tenant', status: 'INVALID' }
    : null;
};

const matchesConfigurationComponentDependency = (
  dependency: SetComponentDependencyRevision,
  component: SetCompositionRevision['components'][number],
): boolean => {
  const { role, source } = dependency.fact;
  const { resourceId, resourceType } = source.resourceRef;
  if (role === 'CONFIGURATION_DEFINITION') {
    return (
      resourceType === configurationDefinitionType &&
      resourceId === component.selection.configuration?.definition.resourceRef.resourceId &&
      dependency.fact.source.revision === component.selection.configuration.definition.revision
    );
  }
  return (
    resourceType === catalogUnitType &&
    component.selection.configuration?.choices.some(
      (choice) =>
        choice.unit?.resourceRef.resourceId === resourceId && choice.unit.revision === dependency.fact.source.revision,
    ) === true
  );
};

const matchesComponentTypeDependency = (
  dependency: SetComponentDependencyRevision,
  component: SetCompositionRevision['components'][number],
): boolean => {
  const { role, source } = dependency.fact;
  const { resourceId } = source.resourceRef;
  if (role === 'PRODUCT_TYPE_UNTYPED_DECISION' || role === 'VARIANT_AXIS') {
    return resourceId === component.selection.productRef.resourceId;
  }
  // These variable sources were verified by the same transaction-scoped Type/value/Axis owner closure.
  return (
    role === 'PRODUCT_TYPE' ||
    role === 'ATTRIBUTE_DEFINITION' ||
    role === 'INHERITED_VALUE' ||
    role === 'OTHER_CATALOG_FACT'
  );
};

const matchesComponentDependency = (
  dependency: SetComponentDependencyRevision,
  component: SetCompositionRevision['components'][number],
): boolean => {
  const { role, source } = dependency.fact;
  const { resourceId, resourceType } = source.resourceRef;
  if (role === 'PRODUCT') {
    return resourceType === 'commerce.catalog.product' && resourceId === component.selection.productRef.resourceId;
  }
  if (role === 'VARIANT') {
    return resourceType === variantType && resourceId === component.selection.variantRef.resourceId;
  }
  if (role === 'UNIT_RULE') {
    return resourceType === productUnitType && resourceId === component.quantity.unitRef.resourceId;
  }
  if (role === 'UNIT_TARGET_DIVISIBILITY') {
    return component.selection.packageOption === undefined
      ? resourceType === variantType && resourceId === component.selection.variantRef.resourceId
      : resourceType === packageDefinitionType && resourceId === component.selection.packageOption.optionRef.resourceId;
  }
  if (role === 'PACKAGE_CONTENT') {
    return resourceType === packageDefinitionType && component.selection.packageOption !== undefined;
  }
  if (role === 'CONFIGURATION_DEFINITION' || role === 'UNIT') {
    return matchesConfigurationComponentDependency(dependency, component);
  }
  if (role === 'PACKAGE_OPTION_ROLE') {
    return (
      resourceType === packageDefinitionType && resourceId === component.selection.packageOption?.optionRef.resourceId
    );
  }
  return matchesComponentTypeDependency(dependency, component);
};

const completeComponentDependencies = (
  dependencies: readonly SetComponentDependencyRevision[],
  revision: SetCompositionRevision,
): boolean =>
  revision.components.every((component) => {
    const forComponent = dependencies.filter((dependency) => dependency.componentId === component.componentId);
    const count = (role: SetComponentDependencyRevision['fact']['role']) =>
      forComponent.filter((dependency) => dependency.fact.role === role).length;
    const hasPackage = component.selection.packageOption !== undefined;
    const { configuration } = component.selection;
    const selectedUnits = new Set(
      configuration?.choices.flatMap((choice) =>
        choice.unit === undefined ? [] : [choice.unit.resourceRef.resourceId],
      ),
    );
    return (
      count('PRODUCT_TYPE') + count('PRODUCT_TYPE_UNTYPED_DECISION') === 1 &&
      (count('PRODUCT_TYPE') === 0 || count('VARIANT_AXIS') === 1) &&
      count('PRODUCT') === 1 &&
      count('VARIANT') === 1 &&
      count('UNIT_RULE') === 1 &&
      count('UNIT_TARGET_DIVISIBILITY') === 1 &&
      count('PACKAGE_OPTION_ROLE') === Number(hasPackage) &&
      count('CONFIGURATION_DEFINITION') === Number(configuration !== undefined) &&
      count('UNIT') === selectedUnits.size &&
      (hasPackage ? count('PACKAGE_CONTENT') > 0 : count('PACKAGE_CONTENT') === 0)
    );
  });

const componentDependencyBasis = (
  dependencies: readonly SetComponentDependencyRevision[],
  revision: SetCompositionRevision,
  tenantId: string,
) => {
  const basis: CatalogSelectionCurrentFacts['basis'][number][] = [];
  if (!completeComponentDependencies(dependencies, revision)) {
    return { basis: [], reason: 'Set component dependency inventory is incomplete' };
  }
  const components = new Map<string, SetCompositionRevision['components'][number]>(
    revision.components.map((component) => [component.componentId, component]),
  );
  for (const dependency of dependencies) {
    const component = components.get(dependency.componentId);
    if (component === undefined) {
      return { basis: [], reason: 'Set component dependency is not part of the selected revision' };
    }
    if (!matchesComponentDependency(dependency, component)) {
      return { basis: [], reason: 'Set component dependency does not match its owner target' };
    }
    if (dependency.fact.subject !== undefined || dependency.fact.source.resourceRef.tenantId !== tenantId) {
      return { basis: [], reason: 'Set component dependency scope is unavailable' };
    }
    const fact = Schema.decodeOption(CatalogSelectionBasisSchema)({
      ...dependency.fact,
      subject: { componentId: dependency.componentId, composition: revision.reference, kind: 'SET_COMPONENT' },
    });
    if (Option.isNone(fact)) {
      return { basis: [], reason: 'Set component dependency revision or identity is unavailable' };
    }
    const conflict = basis.some(
      (prior) =>
        prior.subject?.componentId === dependency.componentId &&
        prior.role === fact.value.role &&
        prior.source.resourceRef.resourceType === fact.value.source.resourceRef.resourceType &&
        prior.source.resourceRef.resourceId === fact.value.source.resourceRef.resourceId,
    );
    if (conflict) {
      return { basis: [], reason: 'Set component dependency is duplicated or contradictory' };
    }
    basis.push(fact.value);
  }
  return { basis, reason: null };
};

const verifySetComponents = Effect.fn('CatalogSelectionCurrentBasis.verifySetComponents')(function* verifySetComponents(
  transaction: ScopedTransaction,
  scope: OperationalScope,
  revision: SetCompositionRevision,
  at: Date,
) {
  const components = yield* setCompositionComponentCurrentBasisForScope(transaction, scope)
    .read(revision, at)
    .pipe(Effect.orElseSucceed(() => null));
  if (components === null) {
    return { basis: [], reason: 'Set component Current source is unavailable', status: 'INDETERMINATE' as const };
  }
  if (components.status !== 'VALID') {
    return { basis: [], reason: `Set component Current proof: ${components.code}`, status: components.status };
  }
  if (components.assessedAt !== DateTime.formatIso(DateTime.makeUnsafe(at))) {
    return {
      basis: [],
      reason: 'Set component proof time differs from this assessment',
      status: 'INDETERMINATE' as const,
    };
  }
  const componentBasis = componentDependencyBasis(components.dependencies, revision, scope.tenantId);
  return componentBasis.reason === null
    ? { basis: componentBasis.basis, reason: null }
    : { basis: [], reason: componentBasis.reason, status: 'INDETERMINATE' as const };
});

const appendPackageUnitBasis = (
  basis: CatalogSelectionCurrentFacts['basis'][number][],
  selection: CatalogSelection,
  packageBasis: {
    readonly contentPath: readonly { readonly packageDefinitionId: string; readonly revision: number }[];
    readonly optionRevision?: number;
    readonly unit: { readonly id: string; readonly ruleRevision: number; readonly targetDivisibilityRevision: number };
  },
  tenantId: string,
): string | null => {
  const option = selection.packageOption;
  if (option !== undefined) {
    if (
      packageBasis.contentPath[0]?.revision !== option.contentRevision.revision ||
      packageBasis.contentPath[0].packageDefinitionId !== option.optionRef.resourceId
    ) {
      return 'Package basis does not match the selected Current content';
    }
    basis.push({
      role: 'PACKAGE_CONTENT',
      source: { resourceRef: option.contentRevision.resourceRef, revision: option.contentRevision.revision },
    });
  }
  const unitRevision = Schema.decodeOption(CatalogRevisionNumberSchema)(packageBasis.unit.ruleRevision);
  const divisibilityRevision = Schema.decodeOption(CatalogRevisionNumberSchema)(
    packageBasis.unit.targetDivisibilityRevision,
  );
  if (Option.isNone(unitRevision) || Option.isNone(divisibilityRevision)) {
    return 'Current Unit rule or target divisibility revision is unavailable';
  }
  basis.push(
    {
      role: 'UNIT_RULE',
      source: {
        resourceRef: {
          moduleId: catalogModuleId,
          resourceId: packageBasis.unit.id,
          resourceType: productUnitType,
          tenantId,
        },
        revision: unitRevision.value,
      },
    },
    {
      role: 'UNIT_TARGET_DIVISIBILITY',
      source: {
        resourceRef: option?.optionRef ?? selection.variantRef,
        revision: divisibilityRevision.value,
      },
    },
  );
  if (option === undefined) {
    return null;
  }
  const optionRevision = Schema.decodeUnknownOption(CatalogRevisionNumberSchema)(packageBasis.optionRevision);
  if (Option.isNone(optionRevision)) {
    return 'Current Package Option role revision is unavailable';
  }
  basis.push({
    role: 'PACKAGE_OPTION_ROLE',
    source: { resourceRef: option.optionRef, revision: optionRevision.value },
  });
  for (const lower of packageBasis.contentPath.slice(1)) {
    const revision = Schema.decodeOption(CatalogRevisionNumberSchema)(lower.revision);
    if (Option.isNone(revision)) {
      return 'Lower Package Content revision is unavailable';
    }
    basis.push({
      role: 'PACKAGE_CONTENT',
      source: {
        resourceRef: {
          moduleId: catalogModuleId,
          resourceId: lower.packageDefinitionId,
          resourceType: packageDefinitionType,
          tenantId,
        },
        revision: revision.value,
      },
    });
  }
  return null;
};

type ConfigurationChoice = NonNullable<CatalogSelection['configuration']>['choices'][number];
const readOneConfigurationChoice = Effect.fn('CatalogSelectionCurrentBasis.readOneConfigurationChoice')(
  function* readOneConfigurationChoice(
    transaction: ScopedTransaction,
    scope: OperationalScope,
    choice: ConfigurationChoice,
    assessment: CurrentConfigurationAssessment,
    definitionRevision: number,
  ) {
    const basis: CatalogSelectionCurrentFacts['basis'][number][] = [];
    const recorded = assessment.choiceRevisions.find((item) => item.choiceKey === choice.choiceKey);
    if (recorded === undefined || recorded.revision !== definitionRevision) {
      return { basis, reason: 'Selected Configuration choice lacks owner meaning', status: 'INDETERMINATE' as const };
    }
    if (choice.unit !== undefined) {
      const selectedRef = choice.unit.resourceRef;
      const unit = assessment.unitRevisions.find(
        (item) =>
          item.ref.moduleId === selectedRef.moduleId &&
          item.ref.resourceType === selectedRef.resourceType &&
          item.ref.tenantId === selectedRef.tenantId &&
          item.ref.resourceId === selectedRef.resourceId,
      );
      if (
        choice.unit.revisionId !== undefined ||
        !validDependentRef(selectedRef, scope.tenantId, catalogUnitType) ||
        recorded.unitRevision !== choice.unit.revision ||
        unit?.revision !== choice.unit.revision ||
        unit.ref.tenantId !== scope.tenantId
      ) {
        return { basis, reason: 'Selected Configuration Unit is not Current', status: 'INVALID' as const };
      }
      basis.push({ role: 'UNIT', source: choice.unit });
    }
    if (choice.attributeDefinition !== undefined) {
      const ref = choice.attributeDefinition.resourceRef;
      if (!validDependentRef(ref, scope.tenantId, attributeDefinitionType)) {
        return {
          basis,
          reason: 'Selected Attribute Definition reference is not owner-verifiable',
          status: 'INDETERMINATE' as const,
        };
      }
      const reads = yield* effectiveAttributeValueReadsForScope(transaction, scope);
      const definition = yield* reads
        .readDefinitionCurrent({
          moduleId: catalogModuleId,
          resourceId: ref.resourceId,
          resourceType: attributeDefinitionType,
          tenantId: scope.tenantId,
        })
        .pipe(Effect.orElseSucceed(() => null));
      if (definition === null || !definition.complete) {
        return {
          basis,
          reason: 'Selected Attribute Definition Current source is unavailable',
          status: 'INDETERMINATE' as const,
        };
      }
      if (definition.revision !== choice.attributeDefinition.revision) {
        return { basis, reason: 'Selected Attribute Definition revision is not Current', status: 'INVALID' as const };
      }
      basis.push({
        role: 'ATTRIBUTE_DEFINITION',
        source: { resourceRef: choice.attributeDefinition.resourceRef, revision: choice.attributeDefinition.revision },
      });
    }
    return { basis, reason: null };
  },
);

const readConfigurationChoiceProof = Effect.fn('CatalogSelectionCurrentBasis.readConfigurationChoiceProof')(
  function* readConfigurationChoiceProof(
    transaction: ScopedTransaction,
    scope: OperationalScope,
    selection: CatalogSelection,
    at: Date,
  ) {
    const basis: CatalogSelectionCurrentFacts['basis'][number][] = [];
    const { configuration } = selection;
    if (configuration === undefined) {
      return { basis, reason: null };
    }
    const target: TrustedConfigurationTarget = {
      definitionId: configuration.definition.resourceRef.resourceId,
      productId: selection.productRef.resourceId,
      variantId: selection.variantRef.resourceId,
    };
    if (selection.packageOption !== undefined) {
      Object.assign(target, { packageDefinitionId: selection.packageOption.optionRef.resourceId });
    }
    const assessment = yield* evaluateCurrentProductConfiguration(
      productConfigurationPersistenceForScope(transaction, scope),
      {
        at,
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
      return { basis, reason: 'Configuration choice Current source is unavailable', status: 'INDETERMINATE' as const };
    }
    if (assessment.status !== 'VALID') {
      return { basis, reason: `Configuration choice proof: ${assessment.code}`, status: assessment.status };
    }
    if (
      assessment.definitionRevision !== configuration.definition.revision ||
      assessment.target.productId !== selection.productRef.resourceId ||
      assessment.target.variantId !== selection.variantRef.resourceId ||
      DateTime.toEpochMillis(DateTime.makeUnsafe(assessment.assessedAt)) !==
        DateTime.toEpochMillis(DateTime.makeUnsafe(at))
    ) {
      return {
        basis,
        reason: 'Configuration choice proof does not match the exact target',
        status: 'INDETERMINATE' as const,
      };
    }
    const proofs = yield* Effect.forEach(
      configuration.choices,
      (choice) => readOneConfigurationChoice(transaction, scope, choice, assessment, configuration.definition.revision),
      { concurrency: 1 },
    );
    for (const proof of proofs) {
      for (const fact of proof.basis) {
        if (
          fact.role !== 'UNIT' ||
          !basis.some((prior) => Schema.toEquivalence(CatalogSelectionBasisSchema)(prior, fact))
        ) {
          basis.push(fact);
        }
      }
      if (proof.reason !== null) {
        return { basis, reason: proof.reason, status: proof.status };
      }
    }
    const singleChoiceOnly =
      configuration.choices.every((choice) => choice.unit === undefined && choice.attributeDefinition === undefined) &&
      assessment.choiceRevisions.every((choice) => choice.kind === 'SINGLE_CHOICE') &&
      assessment.unitRevisions.length === 0;
    return { basis, effectiveTo: singleChoiceOnly ? assessment.effectiveTo : undefined, reason: null };
  },
);

const readSelectedConfiguration = Effect.fn('CatalogSelectionCurrentBasis.readSelectedConfiguration')(
  function* readSelectedConfiguration(
    transaction: ScopedTransaction,
    scope: OperationalScope,
    selection: CatalogSelection,
    at: Date,
  ) {
    const basis: CatalogSelectionCurrentFacts['basis'][number][] = [];
    if (selection.configuration === undefined) {
      return { basis, reason: null };
    }
    const selected = selection.configuration.definition;
    if (
      selected.revisionId !== undefined ||
      !validDependentRef(selected.resourceRef, scope.tenantId, configurationDefinitionType)
    ) {
      return {
        basis,
        reason: 'Selected Configuration reference is not owner-verifiable',
        status: 'INDETERMINATE' as const,
      };
    }
    const current = yield* productConfigurationPersistenceForScope(transaction, scope)
      .readCurrent({ at, definitionId: selected.resourceRef.resourceId, productId: selection.productRef.resourceId })
      .pipe(Effect.catchTag('ProductConfigurationPersistenceUnavailable', () => Effect.succeedNone));
    if (Option.isNone(current)) {
      return {
        basis,
        reason: 'Configuration Current revision is unavailable or missing',
        status: 'INDETERMINATE' as const,
      };
    }
    if (
      current.value.revision !== selected.revision ||
      current.value.definitionId !== selected.resourceRef.resourceId ||
      current.value.productId !== selection.productRef.resourceId
    ) {
      return { basis, reason: 'Selected Configuration revision is not Current', status: 'INVALID' as const };
    }
    const revision = yield* Schema.decodeEffect(CatalogRevisionNumberSchema)(current.value.revision).pipe(
      Effect.mapError(unavailable),
    );
    basis.push({
      role: 'CONFIGURATION_DEFINITION',
      source: {
        resourceRef: {
          moduleId: catalogModuleId,
          resourceId: current.value.definitionId,
          resourceType: configurationDefinitionType,
          tenantId: scope.tenantId,
        },
        revision,
      },
    });
    const choices = yield* readConfigurationChoiceProof(transaction, scope, selection, at);
    basis.push(...choices.basis);
    if (choices.reason !== null) {
      return { basis, reason: choices.reason, status: choices.status };
    }
    // Both exact owner reads must agree; an absent or inconsistent end grants no interval.
    const effectiveTo = 'effectiveTo' in choices ? choices.effectiveTo : undefined;
    const matchingEnd =
      effectiveTo !== undefined &&
      current.value.effectiveTo !== undefined &&
      Number.isFinite(effectiveTo.getTime()) &&
      effectiveTo.getTime() === current.value.effectiveTo.getTime() &&
      effectiveTo > at;
    return { basis, configurationEnd: matchingEnd ? effectiveTo : undefined, reason: null };
  },
);

const checkUnselectedSet = Effect.fn('CatalogSelectionCurrentBasis.checkUnselectedSet')(function* checkUnselectedSet(
  transaction: ScopedTransaction,
  scope: OperationalScope,
  selection: CatalogSelection,
) {
  if (selection.setComposition !== undefined) {
    return null;
  }
  const current = yield* transaction
    .select({ compositionId: setCompositions.compositionId })
    .from(setCompositions)
    .where(
      and(eq(setCompositions.tenantId, scope.tenantId), eq(setCompositions.productId, selection.productRef.resourceId)),
    )
    .limit(1)
    .pipe(Effect.orElseSucceed(() => null));
  if (current === null) {
    return { reason: 'Set ownership source is unavailable', status: 'INDETERMINATE' as const };
  }
  return current.length === 0
    ? null
    : { reason: 'Set Product requires an exact selected Composition revision', status: 'INVALID' as const };
});

/** Only exact effective revisions may enter the basis; component and choice validity is still separate. */
const readSelectedDependencies = Effect.fn('CatalogSelectionCurrentBasis.readSelectedDependencies')(
  function* readSelectedDependencies(
    transaction: ScopedTransaction,
    scope: OperationalScope,
    selection: CatalogSelection,
    at: Date,
  ) {
    const basis: CatalogSelectionCurrentFacts['basis'][number][] = [];
    const missingSet = yield* checkUnselectedSet(transaction, scope, selection);
    if (missingSet !== null) {
      return { basis, ...missingSet };
    }
    const configuration = yield* readSelectedConfiguration(transaction, scope, selection, at);
    basis.push(...configuration.basis);
    if (configuration.reason !== null) {
      return { basis, reason: configuration.reason, status: configuration.status };
    }
    if (selection.setComposition !== undefined) {
      const selected = selection.setComposition;
      if (
        selected.revisionId !== undefined ||
        !validDependentRef(selected.resourceRef, scope.tenantId, 'commerce.catalog.set-composition')
      ) {
        return { basis, reason: 'Selected Set reference is not owner-verifiable', status: 'INDETERMINATE' as const };
      }
      const current = yield* setCompositionPersistenceForScope(transaction, scope)
        .readCurrent({
          at,
          compositionId: selected.resourceRef.resourceId,
        })
        .pipe(Effect.catchTag('SetCompositionPersistenceUnavailable', () => Effect.succeedNone));
      if (Option.isNone(current)) {
        return {
          basis,
          reason: 'Set Composition Current revision is unavailable or missing',
          status: 'INDETERMINATE' as const,
        };
      }
      const { effectiveFrom, effectiveTo, revision } = current.value;
      if (
        !sameCatalogRevisionReference(revision.reference, selected) ||
        current.value.lifecycleState !== 'ACTIVE' ||
        revision.productRef.resourceId !== selection.productRef.resourceId ||
        revision.variantRef.resourceId !== selection.variantRef.resourceId ||
        effectiveFrom > at ||
        (effectiveTo !== undefined && at >= effectiveTo)
      ) {
        return {
          basis,
          reason: 'Selected Set Composition is not Current for this exact target',
          status: 'INVALID' as const,
        };
      }
      const componentProof = yield* verifySetComponents(transaction, scope, revision, at);
      if (componentProof.reason !== null) {
        return { basis, reason: componentProof.reason, status: componentProof.status };
      }
      basis.push(...componentProof.basis, { role: 'SET_COMPOSITION', source: revision.reference });
    }
    return {
      basis,
      configurationEnd: 'configurationEnd' in configuration ? configuration.configurationEnd : undefined,
      reason: null,
    };
  },
);

/**
 * Exact Category and ancestor basis for purposes that decide on classification.
 * The hierarchy revision row is frozen with a shared lock, matching category writes;
 * a missing assignment or unverifiable hierarchy is incomplete, never an empty set.
 */
const readCategoryBasis = Effect.fn('CatalogSelectionCurrentBasis.readCategoryBasis')(function* readCategoryBasis(
  transaction: ScopedTransaction,
  scope: OperationalScope,
  productId: string,
) {
  const { tenantId } = scope;
  const basis: CatalogSelectionCurrentFacts['basis'][number][] = [];
  const incomplete = { basis, complete: false as const };
  const hierarchyRows = yield* transaction
    .select()
    .from(productCategoryHierarchyRevisions)
    .where(eq(productCategoryHierarchyRevisions.tenantId, tenantId))
    .for('share')
    .limit(1)
    .pipe(Effect.orElseSucceed(() => null));
  const hierarchy = hierarchyRows?.[0];
  if (hierarchy === undefined) {
    return incomplete;
  }
  const reads = yield* Effect.all(
    [
      transaction
        .select()
        .from(productCategoryAssignments)
        .where(
          and(eq(productCategoryAssignments.tenantId, tenantId), eq(productCategoryAssignments.productId, productId)),
        )
        .orderBy(productCategoryAssignments.categoryId),
      transaction
        .select()
        .from(productCategories)
        .where(eq(productCategories.tenantId, tenantId))
        .orderBy(productCategories.categoryId),
    ],
    { concurrency: 1 },
  ).pipe(Effect.orElseSucceed(() => null));
  if (reads === null) {
    return incomplete;
  }
  const [assignments, categories] = reads;
  const classification = deriveClassification(
    { resourceId: productId, tenantId },
    assignments.map(({ categoryId }) => ({
      categoryRef: { resourceId: categoryId, tenantId },
      productRef: { resourceId: productId, tenantId },
    })),
    categories.map((row) => {
      const categoryRef = { resourceId: row.categoryId, tenantId };
      const lifecycle = row.lifecycleState === 'ACTIVE' ? ('ACTIVE' as const) : ('RETIRED' as const);
      return row.parentCategoryId === null
        ? { categoryRef, lifecycle }
        : { categoryRef, lifecycle, parentRef: { resourceId: row.parentCategoryId, tenantId } };
    }),
    { assignments: hierarchy.assignmentRevision, hierarchy: hierarchy.hierarchyRevision },
  );
  if (classification.status !== 'AVAILABLE' || classification.directCategories.length === 0) {
    return incomplete;
  }
  const revisionById = new Map(categories.map((row) => [row.categoryId, row.currentRevision]));
  const referenced = [
    ...classification.directCategories,
    ...classification.ancestors.map(({ ancestorRef }) => ancestorRef),
  ];
  for (const ref of new Map(referenced.map((entry) => [entry.resourceId, entry])).values()) {
    const revision = Schema.decodeUnknownOption(CatalogRevisionNumberSchema)(revisionById.get(ref.resourceId));
    if (Option.isNone(revision)) {
      return incomplete;
    }
    basis.push({
      role: 'CATEGORY',
      source: {
        resourceRef: {
          moduleId: catalogModuleId,
          resourceId: ref.resourceId,
          resourceType: productCategoryType,
          tenantId,
        },
        revision: revision.value,
      },
    });
  }
  return { basis, complete: true as const };
});

/** A purpose that does not require classification contributes no facts and no incompleteness. */
const readPurposeCategoryBasis = Effect.fn('CatalogSelectionCurrentBasis.readPurposeCategoryBasis')(
  function* readPurposeCategoryBasis(
    transaction: ScopedTransaction,
    scope: OperationalScope,
    productId: string,
    purpose: string,
  ) {
    return catalogSelectionPurposeRequiresCategory(purpose)
      ? yield* readCategoryBasis(transaction, scope, productId)
      : { basis: [], complete: true as const };
  },
);

const readIndirectDependencies = Effect.fn('CatalogSelectionCurrentBasis.readIndirectDependencies')(
  function* readIndirectDependencies(
    transaction: ScopedTransaction,
    scope: OperationalScope,
    selection: CatalogSelection,
    now: DateTime.Utc,
    productRevision: number,
    variantRevision: number,
    purpose: string,
  ) {
    const basis: CatalogSelectionCurrentFacts['basis'][number][] = [];
    const unknown = (reason: string) => ({ basis, reason, status: 'INDETERMINATE' as const });
    const closure = yield* productSelectionTypeValueAxisBasisForScope(transaction, scope).read(selection, now);
    basis.push(...closure.basis);
    if (closure.reason !== null) {
      return { basis, reason: closure.reason, status: closure.status };
    }
    const packageBasis = yield* catalogSelectionPackageUnitBasisForScope(transaction, scope)
      .read(selection, DateTime.toDateUtc(now))
      .pipe(Effect.orElseSucceed(() => null));
    if (packageBasis === null) {
      return unknown('Current Package and Unit basis is unavailable');
    }
    if (packageBasis.status !== 'CURRENT') {
      return { basis, reason: packageBasis.reason, status: packageBasis.status };
    }
    if (packageBasis.productRevision !== productRevision || packageBasis.variantRevision !== variantRevision) {
      return unknown('Package or Unit basis does not match the Current target');
    }
    const packageProblem = appendPackageUnitBasis(basis, selection, packageBasis, scope.tenantId);
    if (packageProblem !== null) {
      return unknown(packageProblem);
    }
    const category = yield* readPurposeCategoryBasis(transaction, scope, selection.productRef.resourceId, purpose);
    basis.push(...category.basis);
    // Assignment revision is a row counter, not the Product Resource revision.
    // Do not publish it as a ResourceRef basis until Catalog defines that identity.
    return {
      basis: basis.filter(
        (fact, index) => !basis.slice(0, index).some((prior) => sameCatalogSelectionBasis(prior, fact)),
      ),
      dependentFactsComplete: category.complete,
      reason: null,
    };
  },
);

/** A retained Configuration successor bounds only this completely inspected root-only subset. */
const hasClosedUntypedScheduledConfigurationBasis = (
  selection: CatalogSelection,
  basis: CatalogSelectionCurrentFacts['basis'],
): boolean => {
  const { configuration } = selection;
  if (configuration === undefined || selection.packageOption !== undefined || selection.setComposition !== undefined) {
    return false;
  }
  const counts = new Map<string, number>();
  const exact = (
    source: CatalogSelectionCurrentFacts['basis'][number]['source'],
    ref: CatalogSelectionCurrentFacts['basis'][number]['source']['resourceRef'],
  ) =>
    validDependentRef(source.resourceRef, ref.tenantId, ref.resourceType) &&
    source.resourceRef.resourceId === ref.resourceId;
  const supported = basis.every((fact) => {
    if (fact.subject !== undefined || fact.axisAllowances !== undefined) {
      return false;
    }
    counts.set(fact.role, (counts.get(fact.role) ?? 0) + 1);
    return Match.value(fact.role).pipe(
      Match.when('PRODUCT', () => exact(fact.source, selection.productRef)),
      Match.whenOr('VARIANT', 'UNIT_TARGET_DIVISIBILITY', () => exact(fact.source, selection.variantRef)),
      Match.when(
        'PRODUCT_TYPE_UNTYPED_DECISION',
        () =>
          fact.provenance === 'CATALOG_OWNER_CONFIRMED_UNTYPED_DECISION' && exact(fact.source, selection.productRef),
      ),
      Match.when('CONFIGURATION_DEFINITION', () => sameCatalogRevisionReference(fact.source, configuration.definition)),
      Match.when('UNIT_RULE', () =>
        validDependentRef(fact.source.resourceRef, selection.productRef.tenantId, productUnitType),
      ),
      Match.when('CATEGORY', () =>
        validDependentRef(fact.source.resourceRef, selection.productRef.tenantId, productCategoryType),
      ),
      Match.orElse(() => false),
    );
  });
  return (
    supported &&
    [
      'PRODUCT',
      'VARIANT',
      'PRODUCT_TYPE_UNTYPED_DECISION',
      'CONFIGURATION_DEFINITION',
      'UNIT_RULE',
      'UNIT_TARGET_DIVISIBILITY',
    ].every((role) => counts.get(role) === 1)
  );
};

/**
 * This bounded shape is consumed only after the native Type/value/Axis closure succeeds.
 * That owner read proves value-set-to-definition association and Current allowed values;
 * the flat basis alone cannot establish that association. Richer bases remain unsupported.
 */
const hasClosedTypedScheduledConfigurationBasis = (
  selection: CatalogSelection,
  basis: CatalogSelectionCurrentFacts['basis'],
): boolean => {
  const { configuration } = selection;
  if (configuration === undefined || selection.packageOption !== undefined || selection.setComposition !== undefined) {
    return false;
  }
  const types = basis.filter((fact) => fact.role === 'PRODUCT_TYPE');
  const axes = basis.filter((fact) => fact.role === 'VARIANT_AXIS');
  const definitions = basis.filter((fact) => fact.role === 'ATTRIBUTE_DEFINITION');
  const values = basis.filter((fact) => fact.role === 'INHERITED_VALUE' || fact.role === 'OTHER_CATALOG_FACT');
  const allowances = axes[0]?.axisAllowances;
  if (
    types.length !== 1 ||
    types[0]?.source.revisionId === undefined ||
    axes.length !== 1 ||
    allowances === undefined ||
    allowances.length === 0 ||
    definitions.length !== allowances.length ||
    values.length !== definitions.length ||
    new Set(definitions.map((fact) => fact.source.resourceRef.resourceId)).size !== definitions.length ||
    new Set(values.map((fact) => fact.source.resourceRef.resourceId)).size !== values.length ||
    !allowances.every((proof) =>
      definitions.some((fact) => sameCatalogRevisionReference(fact.source, proof.attributeDefinition)),
    )
  ) {
    return false;
  }
  const counts = new Map<string, number>();
  const exact = (
    source: CatalogSelectionCurrentFacts['basis'][number]['source'],
    ref: CatalogSelection['productRef'] | CatalogSelection['variantRef'],
  ) =>
    validDependentRef(source.resourceRef, selection.productRef.tenantId, ref.resourceType) &&
    source.resourceRef.resourceId === ref.resourceId;
  const supported = basis.every((fact, index) => {
    if (
      !Schema.is(CatalogSelectionBasisSchema)(fact) ||
      fact.subject !== undefined ||
      fact.provenance !== undefined ||
      (fact.role !== 'VARIANT_AXIS' && fact.axisAllowances !== undefined) ||
      basis
        .slice(0, index)
        .some(
          (prior) =>
            prior.role === fact.role && prior.source.resourceRef.resourceId === fact.source.resourceRef.resourceId,
        )
    ) {
      return false;
    }
    counts.set(fact.role, (counts.get(fact.role) ?? 0) + 1);
    return Match.value(fact.role).pipe(
      Match.when('PRODUCT', () => exact(fact.source, selection.productRef)),
      Match.whenOr('VARIANT', 'UNIT_TARGET_DIVISIBILITY', () => exact(fact.source, selection.variantRef)),
      Match.when('PRODUCT_TYPE', () =>
        validDependentRef(fact.source.resourceRef, selection.productRef.tenantId, 'commerce.catalog.product-type'),
      ),
      Match.when('VARIANT_AXIS', () => exact(fact.source, selection.productRef)),
      Match.when('ATTRIBUTE_DEFINITION', () =>
        validDependentRef(fact.source.resourceRef, selection.productRef.tenantId, attributeDefinitionType),
      ),
      Match.whenOr('INHERITED_VALUE', 'OTHER_CATALOG_FACT', () =>
        validDependentRef(
          fact.source.resourceRef,
          selection.productRef.tenantId,
          'commerce.catalog.attribute-value-set',
        ),
      ),
      Match.when('CONFIGURATION_DEFINITION', () => sameCatalogRevisionReference(fact.source, configuration.definition)),
      Match.when('UNIT_RULE', () =>
        validDependentRef(fact.source.resourceRef, selection.productRef.tenantId, productUnitType),
      ),
      Match.when('CATEGORY', () =>
        validDependentRef(fact.source.resourceRef, selection.productRef.tenantId, productCategoryType),
      ),
      Match.orElse(() => false),
    );
  });
  return (
    supported &&
    [
      'PRODUCT',
      'VARIANT',
      'PRODUCT_TYPE',
      'VARIANT_AXIS',
      'CONFIGURATION_DEFINITION',
      'UNIT_RULE',
      'UNIT_TARGET_DIVISIBILITY',
    ].every((role) => counts.get(role) === 1)
  );
};

/** A retained Configuration successor bounds only one of these completely inspected root-only subsets. */
export const hasClosedScheduledConfigurationBasis = (
  selection: CatalogSelection,
  basis: CatalogSelectionCurrentFacts['basis'],
): boolean =>
  hasClosedUntypedScheduledConfigurationBasis(selection, basis) ||
  hasClosedTypedScheduledConfigurationBasis(selection, basis);

const withScheduledConfigurationBoundary = (
  observed: Extract<CatalogSelectionCurrentFacts, { status: 'OBSERVED' }>,
  dependent: { readonly basis: CatalogSelectionCurrentFacts['basis']; readonly configurationEnd?: Date | undefined },
): CatalogSelectionCurrentFacts => {
  if (
    observed.dependentFactsComplete &&
    dependent.configurationEnd !== undefined &&
    hasClosedScheduledConfigurationBasis(observed.selection, observed.basis)
  ) {
    return { ...observed, validUntil: DateTime.formatIso(DateTime.makeUnsafe(dependent.configurationEnd)) };
  }
  return observed;
};

/**
 * Core supplies one tenant-scoped transaction. An OBSERVED result is a complete
 * point-in-time Catalog candidate, not an Order acceptance or validity lease.
 */
export const catalogSelectionCurrentBasisForScope = (transaction: ScopedTransaction, scope: OperationalScope) => ({
  read: Effect.fn('CatalogSelectionCurrentBasis.read')(function* read(input: {
    readonly purpose: string;
    readonly selection: CatalogSelection;
  }) {
    const { purpose, selection } = input;
    const now = yield* DateTime.now;
    const assessedAt = DateTime.formatIso(now);
    const basis: CatalogSelectionCurrentFacts['basis'][number][] = [];
    const result = (status: 'INDETERMINATE' | 'INVALID', reason: string): CatalogSelectionCurrentFacts => ({
      assessedAt,
      basis,
      purpose,
      reason,
      selection,
      source: 'CATALOG_OWNER_CURRENT_READ',
      status,
    });
    const precheck = requestProblem(selection, purpose, scope.tenantId);
    if (precheck !== null) {
      return result(precheck.status, precheck.reason);
    }

    const [product] = yield* transaction
      .select({ lifecycleState: products.lifecycleState, revision: products.currentRevision })
      .from(products)
      .where(and(eq(products.tenantId, scope.tenantId), eq(products.productId, selection.productRef.resourceId)))
      .limit(1)
      .pipe(Effect.mapError(unavailable));
    if (
      product === undefined ||
      !Number.isSafeInteger(product.revision) ||
      product.revision < 1 ||
      product.revision > 2_147_483_647
    ) {
      return result('INDETERMINATE', 'Product Current revision is missing or unavailable');
    }
    const productRevision = yield* Schema.decodeEffect(CatalogRevisionNumberSchema)(product.revision).pipe(
      Effect.mapError(unavailable),
    );
    basis.push({
      role: 'PRODUCT',
      source: {
        resourceRef: selection.productRef,
        revision: productRevision,
      },
    });

    const [variant] = yield* transaction
      .select({
        lifecycleState: productVariants.lifecycleState,
        productId: productVariants.productId,
        revision: productVariants.currentRevision,
      })
      .from(productVariants)
      .where(
        and(
          eq(productVariants.tenantId, scope.tenantId),
          eq(productVariants.variantId, selection.variantRef.resourceId),
        ),
      )
      .limit(1)
      .pipe(Effect.mapError(unavailable));
    if (
      variant === undefined ||
      !Number.isSafeInteger(variant.revision) ||
      variant.revision < 1 ||
      variant.revision > 2_147_483_647
    ) {
      return result('INDETERMINATE', 'Variant Current revision is missing or unavailable');
    }
    const variantRevision = yield* Schema.decodeEffect(CatalogRevisionNumberSchema)(variant.revision).pipe(
      Effect.mapError(unavailable),
    );
    if (variant.productId !== selection.productRef.resourceId) {
      return result('INVALID', 'Variant belongs to another Product');
    }
    basis.push({
      role: 'VARIANT',
      source: {
        resourceRef: selection.variantRef,
        revision: variantRevision,
      },
    });
    if (product.lifecycleState === 'RETIRED' || variant.lifecycleState === 'RETIRED') {
      return result('INVALID', 'Selected Product or Variant is retired');
    }
    if (product.lifecycleState !== 'ACTIVE' || variant.lifecycleState !== 'ACTIVE') {
      return result('INVALID', 'Selected Product or Variant is not active');
    }
    const dependent = yield* readSelectedDependencies(transaction, scope, selection, DateTime.toDateUtc(now));
    basis.push(...dependent.basis);
    if (dependent.reason !== null) {
      return result(dependent.status, dependent.reason);
    }
    const indirect = yield* readIndirectDependencies(
      transaction,
      scope,
      selection,
      now,
      product.revision,
      variant.revision,
      purpose,
    );
    for (const fact of indirect.basis) {
      if (!basis.some((existing) => sameCatalogSelectionBasis(existing, fact))) {
        basis.push(fact);
      }
    }
    if (indirect.reason !== null) {
      return result(indirect.status, indirect.reason);
    }
    const crypto = yield* Crypto.Crypto;
    const attestationId = yield* crypto.randomUUIDv4().pipe(Effect.mapError(unavailable));
    const membership = yield* Schema.decodeEffect(CatalogSelectionMembershipSchema)({
      attestationId,
      observedAt: assessedAt,
      productRef: selection.productRef,
      source: 'CATALOG_OWNER_CURRENT_READ',
      variant: { resourceRef: selection.variantRef, revision: variantRevision },
    }).pipe(Effect.mapError(unavailable));
    const observed: CatalogSelectionCurrentFacts = {
      assessedAt,
      basis,
      dependentFactsComplete: indirect.dependentFactsComplete,
      membership,
      productLifecycle: product.lifecycleState,
      purpose,
      selection,
      source: 'CATALOG_OWNER_CURRENT_READ',
      status: 'OBSERVED',
      variantLifecycle: variant.lifecycleState,
    };
    return withScheduledConfigurationBoundary(observed, dependent);
  }),
});
