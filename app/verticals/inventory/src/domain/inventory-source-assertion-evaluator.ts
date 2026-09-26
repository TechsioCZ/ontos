import type { Effect as EffectType, Option as OptionType } from 'effect';
import { Effect, Match, Schema } from 'effect';

import {
  InventorySourceAssertionRejected,
  InventorySourceAssertionSchema,
  InventorySourceAssertionUnavailable,
  sourceAssertionBusinessTimeAtOrAfterSelection,
} from '../../shared/domain/inventory-source-assertion.ts';
import type {
  InventorySourceAssertionEvaluation,
  InventorySourceAssertionPersistence,
  InventorySourceAssertionProposal,
} from '../../shared/domain/inventory-source-assertion.ts';
import type { InventoryBackendConfiguration } from '../../shared/domain/inventory-backend-configuration.ts';
import {
  ExternalStockItemTargetSchema,
  ExternalStockLocationTargetSchema,
} from '../../shared/domain/external-stock-correlation.ts';
import type {
  ExternalStockCorrelationResolution,
  ExternalStockCorrelationResolutionInput,
  ResolvedExternalStockCorrelationSchema,
} from '../../shared/domain/external-stock-correlation.ts';
import { AppliedPhysicalStockEffectSchema } from '../../shared/domain/physical-stock-effect.ts';
import type { PhysicalStockEffectRecord } from '../../shared/domain/physical-stock-effect.ts';
import type { StockPosition } from '../../shared/domain/stock-position.ts';
import type { StockPositionRef } from '../../shared/resources/stock-position.ts';

interface InventorySourceAssertionCorrelationResolver {
  readonly resolve: (
    input: ExternalStockCorrelationResolutionInput,
  ) => EffectType.Effect<ExternalStockCorrelationResolution, InventorySourceAssertionUnavailable>;
}

interface InventorySourceAssertionPositionReader {
  readonly read: (
    positionRef: StockPositionRef,
  ) => EffectType.Effect<OptionType.Option<StockPosition>, InventorySourceAssertionUnavailable>;
}

interface InventorySourceAssertionEffectReader {
  readonly listAppliedForPosition: (
    positionRef: StockPositionRef,
  ) => EffectType.Effect<readonly PhysicalStockEffectRecord[], InventorySourceAssertionUnavailable>;
}

interface InventorySourceAssertionEvaluatorDependencies {
  readonly correlations: InventorySourceAssertionCorrelationResolver;
  readonly effects: InventorySourceAssertionEffectReader;
  readonly persistence: InventorySourceAssertionPersistence;
  readonly positions: InventorySourceAssertionPositionReader;
}

const rejected = (
  assertionId: InventorySourceAssertionProposal['assertionId'],
  reason: InventorySourceAssertionRejected['reason'],
  cause?: unknown,
) => {
  const failure = new InventorySourceAssertionRejected({
    assertionId,
    code: 'inventory_source_assertion_rejected',
    reason,
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

const unavailable = (assertionId: InventorySourceAssertionProposal['assertionId'], cause: unknown) => {
  const failure = new InventorySourceAssertionUnavailable({
    assertionId,
    code: 'inventory_source_assertion_unavailable',
    reason: 'Inventory Source Assertion dependency is temporarily unavailable',
    retryable: true,
  });
  Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  return failure;
};

const sameRef = (
  left: { readonly resourceId: string; readonly tenantId: string },
  right: { readonly resourceId: string; readonly tenantId: string },
) => left.resourceId === right.resourceId && left.tenantId === right.tenantId;

const sameUnit = (left: StockPosition['scope']['unitRef'], right: StockPosition['scope']['unitRef']) =>
  left.moduleId === right.moduleId &&
  left.resourceId === right.resourceId &&
  left.resourceType === right.resourceType &&
  left.tenantId === right.tenantId;

const requireResolved = (
  assertionId: InventorySourceAssertionProposal['assertionId'],
  resolution: ExternalStockCorrelationResolution,
): EffectType.Effect<typeof ResolvedExternalStockCorrelationSchema.Type, InventorySourceAssertionRejected> =>
  Match.value(resolution).pipe(
    Match.tag('UNRESOLVED', () => Effect.fail(rejected(assertionId, 'CORRELATION_NOT_FOUND'))),
    Match.tag('AMBIGUOUS', () => Effect.fail(rejected(assertionId, 'CORRELATION_AMBIGUOUS'))),
    Match.tag('RESOLVED', (resolved) => Effect.succeed(resolved)),
    Match.exhaustive,
  );

const exactMaterialEffects = (
  assertion: typeof InventorySourceAssertionSchema.Type,
  records: readonly PhysicalStockEffectRecord[],
) =>
  records.filter(
    (record) =>
      Schema.is(AppliedPhysicalStockEffectSchema)(record) &&
      sameRef(record.request.positionRef, assertion.positionRef) &&
      sameRef(record.request.stockItemRef, assertion.stockItemRef) &&
      sameRef(record.request.stockLocationRef, assertion.stockLocationRef) &&
      sameUnit(record.request.quantity.unitRef, assertion.quantity.unitRef),
  );

/**
 * Evaluates owner-authored coverage for the exact material physical effects in an assertion scope.
 * This is shared by source ingestion and later reconciliation so neither path invents arithmetic.
 */
export const evaluateInventorySourceAssertionCoverage = (
  assertion: typeof InventorySourceAssertionSchema.Type,
  effects: readonly PhysicalStockEffectRecord[],
): EffectType.Effect<InventorySourceAssertionEvaluation, InventorySourceAssertionRejected> => {
  const materialEffects = exactMaterialEffects(assertion, effects);
  const materialIds = new Set(materialEffects.map((effect) => effect.request.effectId));
  if (assertion.coverage.some((coverage) => !materialIds.has(coverage.effectId))) {
    return Effect.fail(rejected(assertion.assertionId, 'COVERAGE_EFFECT_NOT_FOUND'));
  }
  if (assertion.issuerAuthority === 'HISTORICAL_PRE_CUTOVER_ISSUER') {
    return Effect.succeed({
      _tag: 'HISTORICAL',
      assertion,
      postEffectOnHand: null,
      reason: 'ISSUER_OUTSIDE_SELECTED_BACKEND',
      reconciliationRequired: false,
    });
  }
  const coverageByEffect = new Map(assertion.coverage.map((coverage) => [coverage.effectId, coverage]));
  const missingEffectIds: (typeof materialEffects)[number]['request']['effectId'][] = [];
  const unknownEffectIds: (typeof materialEffects)[number]['request']['effectId'][] = [];
  for (const effect of materialEffects) {
    const { effectId } = effect.request;
    const coverage = coverageByEffect.get(effectId);
    if (coverage === undefined) {
      missingEffectIds.push(effectId);
    } else if (coverage.relation === 'UNKNOWN') {
      unknownEffectIds.push(effectId);
    }
  }
  if (missingEffectIds.length > 0) {
    return Effect.succeed({
      _tag: 'INDETERMINATE',
      assertion,
      materialEffectIds: missingEffectIds,
      postEffectOnHand: null,
      reason: 'MATERIAL_EFFECT_COVERAGE_MISSING',
      reconciliationRequired: true,
    });
  }
  if (unknownEffectIds.length > 0) {
    return Effect.succeed({
      _tag: 'INDETERMINATE',
      assertion,
      materialEffectIds: unknownEffectIds,
      postEffectOnHand: null,
      reason: 'MATERIAL_EFFECT_COVERAGE_UNKNOWN',
      reconciliationRequired: true,
    });
  }
  if (
    materialEffects.some((effect) => {
      const relation = coverageByEffect.get(effect.request.effectId)?.relation;
      return relation === 'EXCLUDES' || relation === 'PREDATES';
    })
  ) {
    return Effect.succeed({
      _tag: 'HISTORICAL',
      assertion,
      postEffectOnHand: null,
      reason: 'MATERIAL_EFFECT_EXCLUDED_OR_PREDATED',
      reconciliationRequired: false,
    });
  }
  return Effect.succeed({
    _tag: 'DETERMINATE',
    assertion,
    postEffectOnHand: assertion.quantity,
    reconciliationRequired: false,
  });
};

// oxlint-disable-next-line effect-native/no-dependency-parameters, effect-native/no-wide-factory-signature -- Core binds these owner-local ports inside one scoped Inventory operation; expires: 2027-03-31.
export const makeInventorySourceAssertionEvaluator = (dependencies: InventorySourceAssertionEvaluatorDependencies) => ({
  evaluate: Effect.fn('InventorySourceAssertionEvaluator.evaluate')(function* evaluate(input: {
    readonly proposal: InventorySourceAssertionProposal;
    readonly selectedConfiguration: InventoryBackendConfiguration;
  }) {
    if (
      input.selectedConfiguration.tenantId !== input.proposal.positionRef.tenantId ||
      input.selectedConfiguration.customerConfigurationId !== input.proposal.customerConfigurationId
    ) {
      return yield* rejected(input.proposal.assertionId, 'AUTHORITY_SCOPE_MISMATCH');
    }
    const [itemResolution, locationResolution] = yield* Effect.all(
      [
        dependencies.correlations.resolve({
          asOf: input.proposal.businessObservedAt,
          externalKey: input.proposal.itemExternalKey,
          selectedConfiguration: input.selectedConfiguration,
        }),
        dependencies.correlations.resolve({
          asOf: input.proposal.businessObservedAt,
          externalKey: input.proposal.locationExternalKey,
          selectedConfiguration: input.selectedConfiguration,
        }),
      ],
      { concurrency: 2 },
    ).pipe(
      Effect.mapError((cause) => unavailable(input.proposal.assertionId, cause)),
      Effect.flatMap(([item, location]) =>
        Effect.all(
          [requireResolved(input.proposal.assertionId, item), requireResolved(input.proposal.assertionId, location)],
          { concurrency: 2 },
        ),
      ),
    );

    if (
      !Schema.is(ExternalStockItemTargetSchema)(itemResolution.target) ||
      !Schema.is(ExternalStockLocationTargetSchema)(locationResolution.target)
    ) {
      return yield* rejected(input.proposal.assertionId, 'POSITION_SCOPE_MISMATCH');
    }
    if (itemResolution.selectedBackendOriginMatch !== locationResolution.selectedBackendOriginMatch) {
      return yield* rejected(input.proposal.assertionId, 'CORRELATION_AUTHORITY_MISMATCH');
    }

    const maybePosition = yield* dependencies.positions
      .read(input.proposal.positionRef)
      .pipe(Effect.mapError((cause) => unavailable(input.proposal.assertionId, cause)));
    const position = yield* Effect.fromOption(maybePosition).pipe(
      Effect.mapError((cause) => rejected(input.proposal.assertionId, 'POSITION_NOT_FOUND', cause)),
    );
    if (
      position.scope.customerConfigurationId !== input.proposal.customerConfigurationId ||
      !sameRef(position.scope.stockItemRef, itemResolution.target.ref) ||
      !sameRef(position.scope.stockLocationRef, locationResolution.target.ref) ||
      !sameUnit(position.scope.unitRef, input.proposal.quantity.unitRef)
    ) {
      return yield* rejected(input.proposal.assertionId, 'POSITION_SCOPE_MISMATCH');
    }

    const assertion = yield* Schema.decodeEffect(InventorySourceAssertionSchema)({
      ...input.proposal,
      authorityConfiguration: input.selectedConfiguration,
      issuerAuthority:
        itemResolution.selectedBackendOriginMatch === 'MATCHES_SELECTED_BACKEND' &&
        sourceAssertionBusinessTimeAtOrAfterSelection(
          input.proposal.businessObservedAt,
          input.selectedConfiguration.selectedAt,
        )
          ? 'SELECTED_BACKEND'
          : 'HISTORICAL_PRE_CUTOVER_ISSUER',
      itemCorrelationRef: itemResolution.correlationRef,
      locationCorrelationRef: locationResolution.correlationRef,
      stockItemRef: itemResolution.target.ref,
      stockLocationRef: locationResolution.target.ref,
    }).pipe(Effect.mapError((cause) => unavailable(input.proposal.assertionId, cause)));
    const materialEffects = yield* dependencies.effects
      .listAppliedForPosition(input.proposal.positionRef)
      .pipe(Effect.mapError((cause) => unavailable(input.proposal.assertionId, cause)));
    const evaluation = yield* evaluateInventorySourceAssertionCoverage(assertion, materialEffects);
    const stored = yield* dependencies.persistence.append(evaluation.assertion);
    return { ...evaluation, assertion: stored };
  }),
});
