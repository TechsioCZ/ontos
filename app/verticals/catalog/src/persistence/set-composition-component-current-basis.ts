import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { DateTime, Effect, Option } from 'effect';

import type { SetComponentCurrentProof } from '../../shared/domain/set-component-validation.ts';
import { validateSetComponents } from '../../shared/domain/set-component-validation.ts';
import type { CatalogRevisionInstant } from '../../shared/domain/catalog-revision-reference.ts';
import type { CatalogSelection, CatalogSelectionRevision } from '../../shared/domain/catalog-selection-evidence.ts';
import type { ConfigurationUnitRevision } from '../../shared/domain/configuration-unit.ts';
import type { SetComponent, SetCompositionRevision } from '../../shared/domain/set-composition.ts';
import { productVariants, products, setCompositions } from '../database/schema.ts';
import { catalogSelectionPackageUnitBasisForScope } from './catalog-selection-package-unit-basis.ts';
import type { CurrentConfigurationAssessment } from './product-configuration-current-evaluator.ts';
import { SetCompositionPersistenceUnavailable } from './set-composition-persistence.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];
const packageDefinitionType = 'commerce.catalog.package-definition';

export interface SetComponentDependencyRevision {
  readonly componentId: string;
  readonly resourceId: string;
  readonly resourceType: string;
  readonly revision: number;
  readonly role:
    | 'PRODUCT'
    | 'VARIANT'
    | 'UNIT_RULE'
    | 'UNIT_TARGET_DIVISIBILITY'
    | 'PACKAGE_CONTENT'
    | 'PACKAGE_OPTION_ROLE'
    | 'CONFIGURATION_DEFINITION'
    | 'UNIT';
}

const unavailable = (cause: unknown) => {
  const error = new SetCompositionPersistenceUnavailable({
    code: 'set_composition_persistence_unavailable',
    reason: 'Authoritative component Current basis is unavailable',
  });
  Object.defineProperty(error, 'cause', { configurable: true, value: cause });
  return error;
};

const exactConfigurationHeader = (
  configuration: NonNullable<CatalogSelection['configuration']>,
  assessment: CurrentConfigurationAssessment,
): boolean =>
  assessment.definitionId === configuration.definition.resourceRef.resourceId &&
  assessment.definitionRevision === configuration.definition.revision &&
  configuration.definition.revisionId === undefined &&
  assessment.choiceRevisions.length === configuration.choices.length;

const matchingConfigurationUnit = (
  selected: CatalogSelectionRevision,
  proven: CurrentConfigurationAssessment['choiceRevisions'][number],
  ownerUnit: ConfigurationUnitRevision | undefined,
): ConfigurationUnitRevision | undefined =>
  proven.kind === 'MEASURED_VALUE' &&
  proven.unitId === selected.resourceRef.resourceId &&
  proven.unitRevision === selected.revision &&
  selected.revisionId === undefined &&
  selected.resourceRef.resourceType === 'commerce.catalog.unit' &&
  ownerUnit?.revision === selected.revision &&
  ownerUnit.ref.moduleId === selected.resourceRef.moduleId &&
  ownerUnit.ref.resourceType === selected.resourceRef.resourceType &&
  ownerUnit.ref.tenantId === selected.resourceRef.tenantId
    ? ownerUnit
    : undefined;

/** Carry only revisions that the owner actually confirmed for the selected fixed values. */
export const setComponentConfigurationDependencies = (
  componentId: string,
  selection: CatalogSelection,
  assessment: CurrentConfigurationAssessment | undefined,
):
  | { readonly dependencies: readonly SetComponentDependencyRevision[]; readonly status: 'PROVEN' }
  | { readonly code: string; readonly componentId: string; readonly status: 'INDETERMINATE' } => {
  const { configuration } = selection;
  const unproven = (code: string) => ({ code, componentId, status: 'INDETERMINATE' as const });
  if (configuration === undefined) {
    return assessment === undefined
      ? { dependencies: [], status: 'PROVEN' }
      : unproven('UNSELECTED_CONFIGURATION_PROOF');
  }
  if (assessment?.status !== 'VALID' || !exactConfigurationHeader(configuration, assessment)) {
    return unproven('CONFIGURATION_PROOF_INCOMPLETE');
  }
  const dependencies: SetComponentDependencyRevision[] = [
    {
      componentId,
      resourceId: configuration.definition.resourceRef.resourceId,
      resourceType: configuration.definition.resourceRef.resourceType,
      revision: configuration.definition.revision,
      role: 'CONFIGURATION_DEFINITION',
    },
  ];
  const choicesByKey = new Map(assessment.choiceRevisions.map((choice) => [choice.choiceKey, choice]));
  const unitsById = new Map(assessment.unitRevisions.map((unit) => [unit.ref.resourceId, unit]));
  if (choicesByKey.size !== assessment.choiceRevisions.length || unitsById.size !== assessment.unitRevisions.length) {
    return unproven('CONFIGURATION_PROOF_CONFLICT');
  }
  for (const choice of configuration.choices) {
    const proven = choicesByKey.get(choice.choiceKey);
    if (proven === undefined) {
      return unproven('CONFIGURATION_CHOICE_UNPROVEN');
    }
    if (choice.unit === undefined) {
      if (proven.kind !== 'SINGLE_CHOICE') {
        return unproven('CONFIGURATION_CHOICE_UNPROVEN');
      }
      continue;
    }
    const selectedUnit = choice.unit;
    const ownerUnit = matchingConfigurationUnit(
      selectedUnit,
      proven,
      unitsById.get(selectedUnit.resourceRef.resourceId),
    );
    if (ownerUnit === undefined) {
      return unproven('CONFIGURATION_UNIT_UNPROVEN');
    }
    if (!dependencies.some((item) => item.role === 'UNIT' && item.resourceId === ownerUnit.ref.resourceId)) {
      dependencies.push({
        componentId,
        resourceId: ownerUnit.ref.resourceId,
        resourceType: ownerUnit.ref.resourceType,
        revision: ownerUnit.revision,
        role: 'UNIT',
      });
    }
  }
  return { dependencies, status: 'PROVEN' };
};

const readComponent = Effect.fn('SetCompositionComponentCurrentBasis.readComponent')(function* readComponent(
  transaction: ScopedTransaction,
  scope: OperationalScope,
  revision: SetCompositionRevision,
  component: SetComponent,
  at: Date,
  assessedAt: CatalogRevisionInstant,
) {
  const { componentId, selection } = component;
  const componentProductId = selection.productRef.resourceId;
  if (selection.productRef.tenantId !== scope.tenantId) {
    return { code: 'COMPONENT_TENANT_MISMATCH', componentId, status: 'INVALID' as const };
  }
  if (selection.setComposition !== undefined || componentProductId === revision.productRef.resourceId) {
    return { code: 'NESTED_SET', componentId, status: 'INVALID' as const };
  }
  // These tenant-qualified owner reads distinguish a confirmed missing target
  // from a failed read. A query failure stays in the typed unavailable channel.
  const [product] = yield* transaction
    .select({ productId: products.productId })
    .from(products)
    .where(and(eq(products.tenantId, scope.tenantId), eq(products.productId, componentProductId)))
    .limit(1);
  if (product === undefined) {
    return { code: 'COMPONENT_PRODUCT_MISSING', componentId, status: 'INVALID' as const };
  }
  const [variant] = yield* transaction
    .select({ variantId: productVariants.variantId })
    .from(productVariants)
    .where(
      and(
        eq(productVariants.tenantId, scope.tenantId),
        eq(productVariants.productId, componentProductId),
        eq(productVariants.variantId, selection.variantRef.resourceId),
      ),
    )
    .limit(1);
  if (variant === undefined) {
    return { code: 'COMPONENT_VARIANT_MISSING', componentId, status: 'INVALID' as const };
  }
  const [nested] = yield* transaction
    .select({ compositionId: setCompositions.compositionId })
    .from(setCompositions)
    .where(and(eq(setCompositions.tenantId, scope.tenantId), eq(setCompositions.productId, componentProductId)))
    .limit(1);
  if (nested !== undefined) {
    return { code: 'NESTED_SET', componentId, status: 'INVALID' as const };
  }
  const current = yield* catalogSelectionPackageUnitBasisForScope(transaction, scope).read(selection, at);
  if (current.status !== 'CURRENT') {
    return { code: 'CURRENT_COMPONENT_UNVERIFIABLE', componentId, status: current.status };
  }
  if (current.unit.id !== component.quantity.unitRef.resourceId) {
    return { code: 'COMPONENT_UNIT_MISMATCH', componentId, status: 'INVALID' as const };
  }
  const configuration = setComponentConfigurationDependencies(componentId, selection, current.configuration);
  if (configuration.status !== 'PROVEN') {
    return configuration;
  }
  const proof: SetComponentCurrentProof = {
    assessedAt,
    attestationId: randomUUID(),
    componentId,
    divisible: current.unit.divisible,
    productKind: 'ATOMIC',
    productLifecycle: 'ACTIVE',
    quantityStep: current.unit.step,
    quantityUnitRef: component.quantity.unitRef,
    selection,
    source: 'CATALOG_OWNER_CURRENT_READ',
    status: 'VALID',
    variantLifecycle: 'ACTIVE',
    variantProductRef: selection.productRef,
  };
  if (selection.packageOption !== undefined) {
    Object.assign(proof, { packageLifecycle: 'ACTIVE', packageProductRef: selection.productRef });
  }
  const dependencies: SetComponentDependencyRevision[] = [
    {
      componentId,
      resourceId: componentProductId,
      resourceType: 'commerce.catalog.product',
      revision: current.productRevision,
      role: 'PRODUCT',
    },
    {
      componentId,
      resourceId: selection.variantRef.resourceId,
      resourceType: 'commerce.catalog.variant',
      revision: current.variantRevision,
      role: 'VARIANT',
    },
    {
      componentId,
      resourceId: current.unit.id,
      resourceType: 'commerce.catalog.product-unit',
      revision: current.unit.ruleRevision,
      role: 'UNIT_RULE',
    },
    {
      componentId,
      resourceId: selection.packageOption?.optionRef.resourceId ?? selection.variantRef.resourceId,
      resourceType: selection.packageOption === undefined ? 'commerce.catalog.variant' : packageDefinitionType,
      revision: current.unit.targetDivisibilityRevision,
      role: 'UNIT_TARGET_DIVISIBILITY',
    },
    ...current.contentPath.map((step) => ({
      componentId,
      resourceId: step.packageDefinitionId,
      resourceType: packageDefinitionType,
      revision: step.revision,
      role: 'PACKAGE_CONTENT' as const,
    })),
    ...configuration.dependencies,
  ];
  if (selection.packageOption !== undefined && current.optionRevision !== undefined) {
    dependencies.push({
      componentId,
      resourceId: selection.packageOption.optionRef.resourceId,
      resourceType: packageDefinitionType,
      revision: current.optionRevision,
      role: 'PACKAGE_OPTION_ROLE',
    });
  }
  return { dependencies, proof, status: 'PROVEN' as const };
});

/** All reads share Core's tenant-scoped transaction and one assessment instant. */
export const setCompositionComponentCurrentBasisForScope = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
) => ({
  read: Effect.fn('SetCompositionComponentCurrentBasis.read')(function* read(
    revision: SetCompositionRevision,
    at: Date,
  ) {
    if (Option.isNone(DateTime.make(at)) || revision.productRef.tenantId !== scope.tenantId) {
      return { code: 'SET_CURRENT_SCOPE_OR_TIME_UNVERIFIABLE', status: 'INDETERMINATE' as const };
    }
    const assessedAt = DateTime.formatIso(DateTime.makeUnsafe(at));
    const results = yield* Effect.forEach(
      revision.components,
      (component) => readComponent(transaction, scope, revision, component, at, assessedAt),
      { concurrency: 1 },
    );
    const failure = results.find((result) => result.status !== 'PROVEN');
    if (failure !== undefined) {
      return failure;
    }
    const proven = results.filter((result) => result.status === 'PROVEN');
    const proofs = proven.map(({ proof }) => proof);
    const dependencies = proven.flatMap(({ dependencies: refs }) => refs);
    const validation = validateSetComponents(revision, proofs);
    return validation.status === 'VALID' ? { assessedAt, dependencies, proofs, status: 'VALID' as const } : validation;
  }, Effect.mapError(unavailable)),
});
