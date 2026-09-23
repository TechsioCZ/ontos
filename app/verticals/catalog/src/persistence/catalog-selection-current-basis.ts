import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { DateTime, Effect, Option, Schema } from 'effect';

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
import type { AttributeValueSetValidityEntry } from './effective-attribute-value-reads.ts';
import { productConfigurationPersistenceForScope } from './product-configuration-persistence.ts';
import { evaluateCurrentProductConfiguration } from './product-configuration-current-evaluator.ts';
import type {
  CurrentConfigurationAssessment,
  TrustedConfigurationTarget,
} from './product-configuration-current-evaluator.ts';
import { productTypeReadinessSourceForScope } from './product-type-readiness-source.ts';
import { setCompositionComponentCurrentBasisForScope } from './set-composition-component-current-basis.ts';
import type { SetComponentDependencyRevision } from './set-composition-component-current-basis.ts';
import { setCompositionPersistenceForScope } from './set-composition-persistence.ts';
import { variantAxisPersistenceForScope } from './variant-axis-persistence.ts';
import type { CurrentVariantAxisValue } from './variant-axis-persistence.ts';

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
  const { resourceId, resourceType, role } = dependency;
  if (role === 'CONFIGURATION_DEFINITION') {
    return (
      resourceType === configurationDefinitionType &&
      resourceId === component.selection.configuration?.definition.resourceRef.resourceId &&
      dependency.revision === component.selection.configuration.definition.revision
    );
  }
  return (
    resourceType === catalogUnitType &&
    component.selection.configuration?.choices.some(
      (choice) => choice.unit?.resourceRef.resourceId === resourceId && choice.unit.revision === dependency.revision,
    ) === true
  );
};

const matchesComponentDependency = (
  dependency: SetComponentDependencyRevision,
  component: SetCompositionRevision['components'][number],
): boolean => {
  const { resourceId, resourceType, role } = dependency;
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
  return (
    resourceType === packageDefinitionType && resourceId === component.selection.packageOption?.optionRef.resourceId
  );
};

const completeComponentDependencies = (
  dependencies: readonly SetComponentDependencyRevision[],
  revision: SetCompositionRevision,
): boolean =>
  revision.components.every((component) => {
    const forComponent = dependencies.filter((dependency) => dependency.componentId === component.componentId);
    const count = (role: SetComponentDependencyRevision['role']) =>
      forComponent.filter((dependency) => dependency.role === role).length;
    const hasPackage = component.selection.packageOption !== undefined;
    const { configuration } = component.selection;
    const measuredChoices = configuration?.choices.filter((choice) => choice.unit !== undefined).length ?? 0;
    return (
      count('PRODUCT') === 1 &&
      count('VARIANT') === 1 &&
      count('UNIT_RULE') === 1 &&
      count('UNIT_TARGET_DIVISIBILITY') === 1 &&
      count('PACKAGE_OPTION_ROLE') === Number(hasPackage) &&
      count('CONFIGURATION_DEFINITION') === Number(configuration !== undefined) &&
      count('UNIT') === measuredChoices &&
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
  const seen = new Set<string>();
  for (const dependency of dependencies) {
    const component = components.get(dependency.componentId);
    if (component === undefined) {
      return { basis: [], reason: 'Set component dependency is not part of the selected revision' };
    }
    if (!matchesComponentDependency(dependency, component)) {
      return { basis: [], reason: 'Set component dependency does not match its owner target' };
    }
    const fact = Schema.decodeOption(CatalogSelectionBasisSchema)({
      role: dependency.role,
      source: {
        resourceRef: {
          moduleId: catalogModuleId,
          resourceId: dependency.resourceId,
          resourceType: dependency.resourceType,
          tenantId,
        },
        revision: dependency.revision,
      },
      subject: { componentId: dependency.componentId, composition: revision.reference, kind: 'SET_COMPONENT' },
    });
    if (Option.isNone(fact)) {
      return { basis: [], reason: 'Set component dependency revision or identity is unavailable' };
    }
    const key = `${dependency.componentId}:${dependency.role}:${dependency.resourceType}:${dependency.resourceId}:${dependency.revision}`;
    if (seen.has(key)) {
      return { basis: [], reason: 'Set component dependency is duplicated' };
    }
    seen.add(key);
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

const appendAxisValueBasis = (
  basis: CatalogSelectionCurrentFacts['basis'][number][],
  values: readonly CurrentVariantAxisValue[],
  tenantId: string,
): string | null => {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value.attributeDefinitionId)) {
      return 'Current Variant axes repeat an Attribute Definition';
    }
    seen.add(value.attributeDefinitionId);
    const definitionRevision = Schema.decodeOption(CatalogRevisionNumberSchema)(value.definitionRevision);
    if (Option.isNone(definitionRevision)) {
      return 'Current axis Attribute Definition revision is unavailable';
    }
    basis.push({
      role: 'ATTRIBUTE_DEFINITION',
      source: {
        resourceRef: {
          moduleId: catalogModuleId,
          resourceId: value.attributeDefinitionId,
          resourceType: attributeDefinitionType,
          tenantId,
        },
        revision: definitionRevision.value,
      },
    });
    if (value.source === 'MISSING') {
      if (value.sourceRevision !== null || value.sourceValueSetRef !== null) {
        return 'Missing Current axis value has a contradictory owner source';
      }
      continue;
    }
    const valueRevision = Schema.decodeUnknownOption(CatalogRevisionNumberSchema)(value.sourceRevision);
    if (
      Option.isNone(valueRevision) ||
      value.sourceValueSetRef === null ||
      value.sourceValueSetRef.tenantId !== tenantId
    ) {
      return 'Current axis value has no owner-qualified revision';
    }
    basis.push({
      role: value.source === 'PRODUCT' ? 'INHERITED_VALUE' : 'OTHER_CATALOG_FACT',
      source: {
        resourceRef: {
          moduleId: catalogModuleId,
          resourceId: value.sourceValueSetRef.attributeValueSetId,
          resourceType: 'commerce.catalog.attribute-value-set',
          tenantId,
        },
        revision: valueRevision.value,
      },
    });
  }
  return null;
};

const readProductValueValidity = Effect.fn('CatalogSelectionCurrentBasis.readProductValueValidity')(
  function* readProductValueValidity(
    transaction: ScopedTransaction,
    scope: OperationalScope,
    productId: string,
    variantId: string,
  ) {
    const reads = yield* effectiveAttributeValueReadsForScope(transaction, scope);
    const validity = yield* reads.readProductTypeValidity([productId]).pipe(Effect.orElseSucceed(() => null));
    if (validity === null || !validity.complete || validity.tenantId !== scope.tenantId) {
      return { reason: 'Current Product Attribute value inventory is unavailable', status: 'INDETERMINATE' as const };
    }
    if (validity.entries.some((entry) => entry.productId !== productId)) {
      return {
        reason: 'Current Product Attribute inventory contains a foreign Product',
        status: 'INDETERMINATE' as const,
      };
    }
    if (validity.entries.some((entry) => (entry.variantId === null || entry.variantId === variantId) && !entry.valid)) {
      return { reason: 'Current Product Attribute value is invalid', status: 'INVALID' as const };
    }
    return validity.entries.filter((entry) => entry.variantId === null || entry.variantId === variantId);
  },
);

const appendProductValueBasis = (
  basis: CatalogSelectionCurrentFacts['basis'][number][],
  entries: readonly AttributeValueSetValidityEntry[],
  tenantId: string,
): string | null => {
  for (const entry of entries) {
    const revision = Schema.decodeOption(CatalogRevisionNumberSchema)(entry.revision);
    const definitionRevision = Schema.decodeOption(CatalogRevisionNumberSchema)(entry.definitionRevision);
    if (Option.isNone(revision) || Option.isNone(definitionRevision)) {
      return 'Current Attribute value or definition revision is unavailable';
    }
    basis.push(
      {
        role: entry.variantId === null ? 'INHERITED_VALUE' : 'OTHER_CATALOG_FACT',
        source: {
          resourceRef: {
            moduleId: catalogModuleId,
            resourceId: entry.attributeValueSetId,
            resourceType: 'commerce.catalog.attribute-value-set',
            tenantId,
          },
          revision: revision.value,
        },
      },
      {
        role: 'ATTRIBUTE_DEFINITION',
        source: {
          resourceRef: {
            moduleId: catalogModuleId,
            resourceId: entry.attributeDefinitionId,
            resourceType: attributeDefinitionType,
            tenantId,
          },
          revision: definitionRevision.value,
        },
      },
    );
  }
  return null;
};

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

const verifyProductTypeReadiness = Effect.fn('CatalogSelectionCurrentBasis.verifyProductTypeReadiness')(
  function* verifyProductTypeReadiness(
    transaction: ScopedTransaction,
    scope: OperationalScope,
    selection: CatalogSelection,
    now: DateTime.Utc,
    source: { readonly rulesRevision: number; readonly status: 'VERIFIED' } | { readonly status: 'UNTYPED' },
  ) {
    const readiness = yield* productTypeReadinessSourceForScope(transaction, scope)
      .evaluate(selection.productRef, now)
      .pipe(Effect.orElseSucceed(() => null));
    if (readiness === null || readiness.status === 'INDETERMINATE') {
      return { reason: 'Current Product Type readiness cannot be proved', status: 'INDETERMINATE' as const };
    }
    if (readiness.status === 'INVALID') {
      return { reason: 'Current Product Type requirements are invalid', status: 'INVALID' as const };
    }
    if (source.status === 'UNTYPED') {
      if (readiness.status !== 'CONFIRMED_UNTYPED_MINIMUM') {
        return {
          reason: 'Current confirmed-untyped decision is not completely attested',
          status: 'INDETERMINATE' as const,
        };
      }
      const revision = Schema.decodeOption(CatalogRevisionNumberSchema)(readiness.decisionRevision);
      return Option.isNone(revision)
        ? { reason: 'Current untyped decision revision is unavailable', status: 'INDETERMINATE' as const }
        : { decisionRevision: revision.value, reason: null };
    }
    if (readiness.status !== 'VERIFIED_TYPE_MINIMUM' || readiness.rulesRevision !== source.rulesRevision) {
      return {
        reason: 'Current Product Type requirements are not completely attested',
        status: 'INDETERMINATE' as const,
      };
    }
    const revision = Schema.decodeOption(CatalogRevisionNumberSchema)(readiness.assignmentRevision);
    return Option.isNone(revision)
      ? { reason: 'Current Product Type assignment revision is unavailable', status: 'INDETERMINATE' as const }
      : { reason: null };
  },
);

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
      basis.push(...proof.basis);
      if (proof.reason !== null) {
        return { basis, reason: proof.reason, status: proof.status };
      }
    }
    return { basis, reason: null };
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
    return choices.reason === null
      ? { basis, reason: null }
      : { basis, reason: choices.reason, status: choices.status };
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
    return { basis, reason: null };
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

/* oxlint-disable eslint/complexity -- Exact scope: one transaction-scoped Catalog Selection dependency proof. Evidence: #398 tests require separate typed/untyped, value, axis, package/unit, readiness, and category fail-closed outcomes. Owner/tracking: Catalog #398. Remove when these owner reads expose an approved aggregate Current-basis contract without weakening outcome distinctions; expires: 2027-03-31. */
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
    const typeSource = yield* productTypeReadinessSourceForScope(transaction, scope)
      .load(selection.productRef, now)
      .pipe(Effect.orElseSucceed(() => null));
    if (typeSource === null) {
      return unknown('Current Product Type assignment or untyped decision is not owner-attested');
    }
    if (typeSource.status === 'VERIFIED') {
      const typeRevision = yield* Schema.decodeEffect(CatalogRevisionNumberSchema)(typeSource.basis.revision).pipe(
        Effect.mapError(unavailable),
      );
      basis.push({
        role: 'PRODUCT_TYPE',
        source: {
          resourceRef: typeSource.basis.productTypeRef,
          revision: typeRevision,
          revisionId: typeSource.basis.revisionId,
        },
      });
    }
    const productValues = yield* readProductValueValidity(
      transaction,
      scope,
      selection.productRef.resourceId,
      selection.variantRef.resourceId,
    );
    if (productValues !== null && !Array.isArray(productValues)) {
      return { basis, ...productValues };
    }
    const valueProblem = appendProductValueBasis(basis, productValues, scope.tenantId);
    if (valueProblem !== null) {
      return unknown(valueProblem);
    }
    const axisReader = variantAxisPersistenceForScope(transaction, scope);
    const axes = yield* axisReader.readCurrent(selection.productRef).pipe(Effect.orElseSucceed(() => null));
    if (axes === null || axes.productId !== selection.productRef.resourceId) {
      return unknown('Current Variant axes are unavailable');
    }
    if (typeSource.status === 'VERIFIED') {
      if (axes.productTypeRevision !== typeSource.basis.revision) {
        return unknown('Current Variant axes are stale against Product Type');
      }
      if (!Number.isSafeInteger(axes.axisRevision) || axes.axisRevision < 1) {
        return unknown('Current Variant axis revision is not owner-attested');
      }
      const axisRevision = yield* Schema.decodeEffect(CatalogRevisionNumberSchema)(axes.axisRevision).pipe(
        Effect.mapError(unavailable),
      );
      basis.push({ role: 'VARIANT_AXIS', source: { resourceRef: selection.productRef, revision: axisRevision } });
      const axisValues = yield* axisReader
        .readEffectiveValues(selection.productRef, selection.variantRef, axes)
        .pipe(Effect.orElseSucceed(() => null));
      if (axisValues === null || axisValues.length !== axes.axes.length) {
        return unknown('Current Variant axis values are unavailable or incomplete');
      }
      const axisValueProblem = appendAxisValueBasis(basis, axisValues, scope.tenantId);
      if (axisValueProblem !== null) {
        return unknown(axisValueProblem);
      }
    } else if (axes.productTypeRevision !== null || axes.axes.length !== 0) {
      return unknown('Current untyped Product has contradictory Variant axes');
    }

    if (typeSource.status === 'UNTYPED') {
      const readiness = yield* verifyProductTypeReadiness(transaction, scope, selection, now, { status: 'UNTYPED' });
      if (readiness.reason !== null) {
        return { basis, reason: readiness.reason, status: readiness.status };
      }
      if (!('decisionRevision' in readiness)) {
        return unknown('Current untyped decision revision is unavailable');
      }
      basis.push({
        provenance: 'CATALOG_OWNER_CONFIRMED_UNTYPED_DECISION',
        role: 'PRODUCT_TYPE_UNTYPED_DECISION',
        source: { resourceRef: selection.productRef, revision: readiness.decisionRevision },
      });
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
    if (typeSource.status === 'VERIFIED') {
      const readiness = yield* verifyProductTypeReadiness(transaction, scope, selection, now, {
        rulesRevision: typeSource.basis.revision,
        status: 'VERIFIED',
      });
      if (readiness.reason !== null) {
        return { basis, reason: readiness.reason, status: readiness.status };
      }
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
/* oxlint-enable eslint/complexity */

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
    const membership = yield* Schema.decodeEffect(CatalogSelectionMembershipSchema)({
      attestationId: randomUUID(),
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
    return observed;
  }),
});
