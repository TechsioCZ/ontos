import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { DateTime, Effect, Option, Result, Schema } from 'effect';

import type {
  CartOpenSelectionPopulationEvidence,
  CartOpenSelectionPopulationPort,
  CartOpenSelectionReference,
  CatalogSelectionEvidenceReader,
} from '../../shared/domain/catalog-open-selection-population.ts';
import { readCartOpenSelectionPopulation } from '../../shared/domain/catalog-open-selection-population.ts';
import type { CatalogSelection, CatalogSelectionRevision } from '../../shared/domain/catalog-selection-evidence.ts';
import { CatalogSelectionRevisionSchema } from '../../shared/domain/catalog-selection-evidence.ts';
import type {
  ProductConfiguration,
  ProductConfigurationDefinitionRevision,
} from '../../shared/domain/product-configuration.ts';
import {
  assessCatalogOpenSelectionSnapshot,
  catalogSelectionOpenPopulationImpactForScope,
} from './catalog-selection-open-population.ts';
import { catalogSelectionEvidenceForScope } from './catalog-selection-evidence-service.ts';
import type { PackageActivationSelectionImpact } from './package-activation-persistence.ts';
import { PackageActivationUnavailable } from './package-activation-persistence.ts';
import type {
  CurrentConfigurationAssessmentInput,
  CurrentConfigurationValue,
  TrustedConfigurationTarget,
} from './product-configuration-current-evaluator.ts';
import { evaluateCurrentProductConfiguration } from './product-configuration-current-evaluator.ts';
import type {
  ConfigurationSelectionImpact,
  CurrentConfigurationRevision,
  ProductConfigurationPersistence,
} from './product-configuration-persistence.ts';
import {
  ProductConfigurationPersistenceUnavailable,
  productConfigurationPersistenceForScope,
} from './product-configuration-persistence.ts';
import type { SetCompositionSelectionImpact } from './set-composition-persistence.ts';
import { SetCompositionPersistenceUnavailable } from './set-composition-persistence.ts';
import type { ProductConfigurationAssessmentSide } from '../domain/product-configuration-reassessment.ts';
import { reassessProductConfigurationChange } from '../domain/product-configuration-reassessment.ts';
import { productConfigurationRevisionEquivalenceAttestationFor } from '../domain/product-configuration-equivalence.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];

const configurationUnavailable = (reason: string) =>
  new ProductConfigurationPersistenceUnavailable({
    code: 'product_configuration_persistence_unavailable',
    reason,
  });

const configurationTarget = (selection: CatalogSelection): TrustedConfigurationTarget | undefined => {
  const { configuration } = selection;
  if (configuration === undefined) {
    return undefined;
  }
  const base: TrustedConfigurationTarget = {
    definitionId: configuration.definition.resourceRef.resourceId,
    productId: selection.productRef.resourceId,
    variantId: selection.variantRef.resourceId,
  };
  return selection.packageOption === undefined
    ? base
    : { ...base, packageDefinitionId: selection.packageOption.optionRef.resourceId };
};

const configurationValues = (selection: CatalogSelection): readonly CurrentConfigurationValue[] =>
  (selection.configuration?.choices ?? []).map((choice) =>
    choice.unit === undefined
      ? { choiceKey: choice.choiceKey, kind: 'SINGLE_CHOICE' as const, optionKey: choice.value }
      : {
          amount: choice.value,
          choiceKey: choice.choiceKey,
          kind: 'MEASURED_VALUE' as const,
          unitId: choice.unit.resourceRef.resourceId,
        },
  );

const productConfigurationFromSelection = (selection: CatalogSelection): ProductConfiguration | undefined => {
  const { configuration } = selection;
  if (configuration === undefined) {
    return undefined;
  }
  const base: ProductConfiguration = {
    definition: configuration.definition,
    productRef: configuration.productRef,
    values: configuration.choices.map((choice) =>
      choice.unit === undefined
        ? { choiceKey: choice.choiceKey, kind: 'SINGLE_CHOICE' as const, optionKey: choice.value }
        : {
            amount: choice.value,
            choiceKey: choice.choiceKey,
            kind: 'MEASURED_VALUE' as const,
            unitRef: choice.unit.resourceRef,
          },
    ),
    variantRef: configuration.variantRef,
  };
  return selection.packageOption === undefined
    ? base
    : { ...base, packageOptionRef: selection.packageOption.optionRef };
};

/** Re-express the exact selected values at another Definition revision without selecting anything new. */
const reexpressSelection = (
  selection: ProductConfiguration,
  reference: CatalogSelectionRevision,
): ProductConfiguration => {
  const candidate: ProductConfiguration = {
    definition: reference,
    productRef: selection.productRef,
    values: selection.values,
    variantRef: selection.variantRef,
  };
  return selection.packageOptionRef === undefined
    ? candidate
    : { ...candidate, packageOptionRef: selection.packageOptionRef };
};

const proposedDefinitionReference = (
  selection: CatalogSelection,
  proposedRevision: number,
): CatalogSelectionRevision | undefined => {
  const { configuration } = selection;
  if (configuration === undefined) {
    return undefined;
  }
  // A publication creates the next revision; it must not inherit the earlier revision's optional
  // owner-issued revision ID. Only the sequence is carried.
  const decoded = Schema.decodeResult(CatalogSelectionRevisionSchema)({
    resourceRef: configuration.definition.resourceRef,
    revision: proposedRevision,
  });
  return Result.isSuccess(decoded) ? decoded.success : undefined;
};

const definitionFromRevision = (
  revision: CurrentConfigurationRevision,
  selection: CatalogSelection,
  reference: CatalogSelectionRevision,
): ProductConfigurationDefinitionRevision | undefined => {
  const units = new Map(revision.units.map((unit) => [unit.ref.resourceId, unit.ref]));
  const choices: ProductConfigurationDefinitionRevision['choices'][number][] = [];
  for (const choice of revision.choices) {
    if (choice.kind === 'SINGLE_CHOICE') {
      choices.push({
        choiceKey: choice.choiceKey,
        kind: 'SINGLE_CHOICE',
        meaning: choice.meaning,
        options: choice.options ?? [],
        required: choice.required,
      });
      continue;
    }
    const unitRef = units.get(choice.unitId ?? '');
    if (unitRef === undefined) {
      return undefined;
    }
    choices.push({
      choiceKey: choice.choiceKey,
      kind: 'MEASURED_VALUE',
      meaning: choice.meaning,
      required: choice.required,
      unitRef,
    });
  }
  return { choices, productRef: selection.productRef, reference };
};

/**
 * Present the proposed snapshot as the owner-issued Current revision it will become. Exact Unit
 * revisions are carried from the committed Current read (the same trusted Unit source the
 * publication pins); an absent committed read is handled by the caller.
 */
const proposedCurrentRevision = (
  committed: CurrentConfigurationRevision,
  input: ConfigurationSelectionChange,
): CurrentConfigurationRevision => {
  const unitRevisions = new Map(committed.choices.map((choice) => [choice.choiceKey, choice.unitRevision]));
  const choices = input.proposed.choices.map((choice) => {
    if (choice.unitRevision !== undefined || choice.unitId === undefined) {
      return choice;
    }
    const unitRevision = unitRevisions.get(choice.choiceKey);
    return unitRevision === undefined ? choice : { ...choice, unitRevision };
  });
  return {
    choices,
    compatibilityRules: input.proposed.compatibilityRules,
    definitionEvidenceRefs: committed.definitionEvidenceRefs,
    definitionId: input.definitionId,
    effectiveFrom: input.effectiveFrom,
    measuredRules: input.proposed.measuredRules,
    optionAllowances: input.proposed.optionAllowances,
    productId: input.productId,
    revision: input.proposedRevision,
    ruleCombination: committed.ruleCombination,
    units: committed.units,
  };
};

/** The proposed Definition publication an open selection is reassessed against. */
export interface ConfigurationSelectionChange {
  readonly definitionId: string;
  readonly effectiveFrom: Date;
  readonly previousRevision: number;
  readonly productId: string;
  readonly proposed: Pick<
    CurrentConfigurationRevision,
    'choices' | 'compatibilityRules' | 'measuredRules' | 'optionAllowances'
  >;
  readonly proposedRevision: number;
  readonly tenantId: string;
}

const revisionReader = (
  revision: CurrentConfigurationRevision,
): Pick<ProductConfigurationPersistence, 'readCurrent'> => ({
  readCurrent: () => Effect.succeedSome(revision),
});

/**
 * Decide whether a Definition publication preserves every open selection pinned to the revision it
 * supersedes. The earlier side is the exact committed revision the selection is pinned to and the
 * current side is the proposed snapshot. A material change invalidates, a display-only change is
 * Current only with an owner-issued equivalence decision, and any unverifiable comparison fails
 * closed instead of treating absent evidence as safe.
 */
export const reassessOpenConfiguration: (
  persistence: ProductConfigurationPersistence,
  population: Pick<CartOpenSelectionPopulationEvidence, 'observedAt' | 'revisionToken'>,
  input: ConfigurationSelectionChange,
  reference: CartOpenSelectionReference,
) => Effect.Effect<boolean, ProductConfigurationPersistenceUnavailable> = Effect.fn(
  'CatalogSelectionChangeImpact.reassessOpenConfiguration',
)(function* reassessOpenConfigurationStep(persistence, population, input, reference): Effect.fn.Return<
  boolean,
  ProductConfigurationPersistenceUnavailable
> {
  const { selection } = reference;
  const configuration = productConfigurationFromSelection(selection);
  const target = configurationTarget(selection);
  const proposedReference = proposedDefinitionReference(selection, input.proposedRevision);
  if (configuration === undefined || target === undefined || proposedReference === undefined) {
    return false;
  }
  const populationObservedAt = DateTime.make(population.observedAt);
  if (Option.isNone(populationObservedAt)) {
    return false;
  }
  const at = input.effectiveFrom;
  const sideInput: CurrentConfigurationAssessmentInput = { at, target, values: configurationValues(selection) };
  const committed = yield* persistence
    .readCurrent({ at, definitionId: input.definitionId, productId: input.productId })
    .pipe(Effect.orElseSucceed(() => Option.none()));
  if (Option.isNone(committed) || committed.value.revision !== configuration.definition.revision) {
    return false;
  }
  const earlierAssessment = yield* evaluateCurrentProductConfiguration(revisionReader(committed.value), sideInput);
  const earlierDefinition = definitionFromRevision(committed.value, selection, configuration.definition);
  const proposed = proposedCurrentRevision(committed.value, input);
  const proposedDefinition = definitionFromRevision(proposed, selection, proposedReference);
  if (earlierAssessment.status !== 'VALID' || earlierDefinition === undefined || proposedDefinition === undefined) {
    return false;
  }
  const currentAssessment = yield* evaluateCurrentProductConfiguration(revisionReader(proposed), sideInput);
  const earlier: ProductConfigurationAssessmentSide = {
    assessment: earlierAssessment,
    definition: earlierDefinition,
    input: sideInput,
  };
  const current: ProductConfigurationAssessmentSide = {
    assessment: currentAssessment,
    definition: proposedDefinition,
    input: sideInput,
  };
  const proposedSelection = reexpressSelection(configuration, proposedDefinition.reference);
  const attestation = productConfigurationRevisionEquivalenceAttestationFor({
    attestationId: [
      'commerce.catalog',
      'configuration-equivalence',
      input.tenantId,
      input.definitionId,
      String(input.previousRevision),
      String(input.proposedRevision),
      population.revisionToken,
      reference.selectionId,
    ].join(':'),
    left: { ...earlier, selection: configuration },
    right: { ...current, selection: proposedSelection },
  });
  const result = reassessProductConfigurationChange(
    attestation === undefined
      ? {
          authority: {
            complete: true,
            observedAt: DateTime.toDateUtc(populationObservedAt.value),
            revisionToken: population.revisionToken,
            selectionId: reference.selectionId,
          },
          current,
          earlier,
          selection: configuration,
        }
      : {
          attestation,
          authority: {
            complete: true,
            observedAt: DateTime.toDateUtc(populationObservedAt.value),
            revisionToken: population.revisionToken,
            selectionId: reference.selectionId,
          },
          current,
          earlier,
          selection: configuration,
        },
  );
  return result.status === 'CURRENT';
});

const configurationAffected =
  (input: Parameters<ConfigurationSelectionImpact['verify']>[0]) =>
  (reference: CartOpenSelectionReference): boolean =>
    reference.selection.configuration !== undefined &&
    reference.selection.configuration.definition.resourceRef.resourceId === input.definitionId &&
    reference.selection.productRef.resourceId === input.productId;

/** #479-backed impact for a Configuration Definition publication. */
export const productConfigurationSelectionImpactForScope = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
  population?: CartOpenSelectionPopulationPort,
  assess?: CatalogSelectionEvidenceReader['assess'],
): ConfigurationSelectionImpact => ({
  verify: Effect.fn('ProductConfigurationSelectionImpact.verify')(function* verifyConfigurationImpact(
    input: Parameters<ConfigurationSelectionImpact['verify']>[0],
  ) {
    if (population === undefined) {
      return yield* configurationUnavailable('Owner-confirmed Cart/checkout open-selection population is unavailable');
    }
    const snapshot = yield* readCartOpenSelectionPopulation(population, scope.tenantId).pipe(
      Effect.mapError((failure) => configurationUnavailable(failure.reason)),
    );
    const affected = snapshot.selections.filter(configurationAffected(input));
    const impacted = yield* assessCatalogOpenSelectionSnapshot({
      affected: configurationAffected(input),
      assess: assess ?? ((request) => catalogSelectionEvidenceForScope(transaction, scope).assess(request)),
      purpose: 'PURCHASE_ACCEPTANCE',
      snapshot,
    });
    if (impacted.kind !== 'PROVEN') {
      return false;
    }
    const persistence = productConfigurationPersistenceForScope(transaction, scope);
    const reassessments = yield* Effect.forEach(
      affected,
      (reference) => reassessOpenConfiguration(persistence, snapshot, input, reference),
      { concurrency: 1 },
    );
    if (!reassessments.every(Boolean)) {
      return false;
    }
    const confirmed = yield* readCartOpenSelectionPopulation(population, scope.tenantId).pipe(
      Effect.mapError((failure) => configurationUnavailable(failure.reason)),
    );
    // This narrows the race window but is not a Cart lease through the Catalog commit. The external
    // owner still needs to provide that commit-spanning guarantee before this can claim atomicity.
    return confirmed.tenantId === snapshot.tenantId && confirmed.revisionToken === snapshot.revisionToken;
  }),
});

/** #479-backed impact for Package Definition activation. */
export const packageActivationSelectionImpactForScope = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
  population?: CartOpenSelectionPopulationPort,
  assess?: CatalogSelectionEvidenceReader['assess'],
): PackageActivationSelectionImpact => ({
  verify: Effect.fn('PackageActivationSelectionImpact.verify')(function* verifyPackageActivationImpact(
    input: Parameters<PackageActivationSelectionImpact['verify']>[0],
  ) {
    const impacted = yield* catalogSelectionOpenPopulationImpactForScope(transaction, scope, population, assess)
      .assess({
        affected: (reference) => reference.selection.packageOption?.optionRef.resourceId === input.packageDefinitionId,
        purpose: 'PURCHASE_ACCEPTANCE',
      })
      .pipe(
        Effect.mapError(
          (failure) =>
            new PackageActivationUnavailable({
              code: 'package_activation_unavailable',
              reason: failure.reason,
            }),
        ),
      );
    if (impacted.kind === 'POPULATION_UNAVAILABLE') {
      return yield* new PackageActivationUnavailable({
        code: 'package_activation_unavailable',
        reason: impacted.reason,
      });
    }
    return impacted.kind === 'PROVEN';
  }),
});

/** #479-backed impact for an original-data-error Set Composition correction. */
export const setCompositionSelectionImpactForScope = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
  population?: CartOpenSelectionPopulationPort,
  assess?: CatalogSelectionEvidenceReader['assess'],
): SetCompositionSelectionImpact => ({
  verify: Effect.fn('SetCompositionSelectionImpact.verify')(function* verifySetCorrectionImpact(
    input: Parameters<SetCompositionSelectionImpact['verify']>[0],
  ) {
    const impacted = yield* catalogSelectionOpenPopulationImpactForScope(transaction, scope, population, assess)
      .assess({
        affected: (reference) => reference.selection.setComposition?.resourceRef.resourceId === input.compositionId,
        purpose: 'PURCHASE_ACCEPTANCE',
      })
      .pipe(
        Effect.mapError(
          (failure) =>
            new SetCompositionPersistenceUnavailable({
              code: 'set_composition_persistence_unavailable',
              reason: failure.reason,
            }),
        ),
      );
    if (impacted.kind === 'POPULATION_UNAVAILABLE') {
      return yield* new SetCompositionPersistenceUnavailable({
        code: 'set_composition_persistence_unavailable',
        reason: impacted.reason,
      });
    }
    return impacted.kind === 'PROVEN';
  }),
});
