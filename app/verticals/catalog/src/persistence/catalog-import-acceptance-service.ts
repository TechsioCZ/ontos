import { Context, Effect, Layer, Option, Schema } from 'effect';

import type { CatalogExternalSourceRecordRef } from '../../shared/domain/external-identifier-boundary.ts';
import type {
  CosmeticProductCorrection,
  ProductChangeClassification,
} from '../../shared/domain/product-change-classification.ts';
import { requireExistingCatalogFactChangeClassification } from '../../shared/domain/product-change-classification.ts';
import type {
  CatalogExternalTargetKind,
  CatalogExternalTargetRequest,
  CatalogResolvedExternalTarget,
} from '../../shared/domain/external-target-resolution.ts';
import type {
  CatalogAssertionDecision,
  CatalogFactScope,
  CatalogLocalOverride,
  CatalogSourceAssertion,
} from '../domain/catalog-source-resolution.ts';
import { assessCatalogSourceAssertion, resolveCatalogSourceFact } from '../domain/catalog-source-resolution.ts';
import { decideCatalogResolvedCurrentChange } from './catalog-resolved-current-event-seam.ts';
import type { ExternalCorrelationResolutionFailure } from './external-correlation-resolver.ts';
import { ExternalCorrelationAmbiguous } from './external-correlation-ambiguous.ts';
import { ExternalCorrelationInvalid } from './external-correlation-invalid.ts';
import { ExternalCorrelationMissingLink } from './external-correlation-missing-link.ts';
import { ExternalCorrelationTargetTypeMismatch } from './external-correlation-target-type-mismatch.ts';
import { ExternalCorrelationUnverifiable } from './external-correlation-unverifiable.ts';
import type {
  CatalogFactAdmissionPorts,
  CatalogResolvedCurrentEventPorts,
  CatalogSourceAuthorityPorts,
  CatalogSourceResolutionPorts,
  CatalogSourceResolutionUnavailable,
} from './catalog-source-resolution-ports.ts';

/** One delivered assertion plus the owner-verified facts #422 and #481 need before acceptance. */
export interface CatalogImportDeliveredItem<Value> {
  readonly assertion: CatalogSourceAssertion<Value>;
  readonly captureConfirmed: boolean;
  readonly classification?: ProductChangeClassification;
  readonly recordMeaning: CatalogExternalTargetKind;
  readonly sourceRecord: CatalogExternalSourceRecordRef;
}

export interface CatalogImportBatchInput<Value> {
  readonly at: Date;
  readonly items: readonly CatalogImportDeliveredItem<Value>[];
}

export type CatalogImportItemResult<Value> =
  | {
      readonly base: CatalogSourceAssertion<Value>;
      readonly classification?: CosmeticProductCorrection;
      readonly resolvedCurrentChanged: boolean;
      readonly scope: CatalogFactScope;
      readonly status: 'ACCEPTED_BASE';
    }
  | {
      readonly reason: string;
      readonly status:
        | 'DUPLICATE'
        | 'STALE'
        | 'NO_AUTHORITY'
        | 'INVALID_TARGET'
        | 'INVALID_VALUE'
        | 'HELD'
        | 'RECONCILIATION_REQUIRED'
        | 'UNVERIFIABLE';
    };

export interface CatalogImportBatchSummary {
  readonly acceptedBases: number;
  readonly allItemsResolved: boolean;
  readonly duplicates: number;
  readonly held: number;
  readonly reconciliationRequired: number;
  readonly rejected: number;
  readonly resolvedCurrentChanged: number;
  readonly stale: number;
  readonly unverifiable: number;
}

export interface CatalogImportBatchResult<Value> {
  readonly items: readonly CatalogImportItemResult<Value>[];
  readonly summary: CatalogImportBatchSummary;
}

export interface CatalogImportAcceptanceWiring<Value> {
  readonly admission: CatalogFactAdmissionPorts<Value>;
  readonly authority: CatalogSourceAuthorityPorts;
  readonly events: CatalogResolvedCurrentEventPorts<Value>;
  readonly resolveTarget: (
    request: CatalogExternalTargetRequest,
  ) => Effect.Effect<CatalogResolvedExternalTarget, ExternalCorrelationResolutionFailure>;
  readonly store: CatalogSourceResolutionPorts<Value>;
  readonly valuesEqual: (left: Value, right: Value) => boolean;
}

const selectCurrentBase = <Value>(
  bases: readonly CatalogSourceAssertion<Value>[],
  assertion: CatalogSourceAssertion<Value>,
): CatalogSourceAssertion<Value> | null => {
  const comparable = bases.filter(
    (base) => base.issuerSystemId === assertion.issuerSystemId && base.sourceRecordId === assertion.sourceRecordId,
  );
  let newest: CatalogSourceAssertion<Value> | null = null;
  for (const base of comparable) {
    if (
      newest === null ||
      base.sourceRevision > newest.sourceRevision ||
      (base.sourceRevision === newest.sourceRevision && base.evidencedAt.getTime() > newest.evidencedAt.getTime())
    ) {
      newest = base;
    }
  }
  return newest;
};

const selectActiveOverride = <Value>(
  overrides: readonly CatalogLocalOverride<Value>[],
  scope: CatalogFactScope,
): CatalogLocalOverride<Value> | null => {
  const scoped = overrides.filter(
    (override) =>
      override.scope.tenantId === scope.tenantId &&
      override.scope.targetKind === scope.targetKind &&
      override.scope.targetId === scope.targetId &&
      override.scope.factKey === scope.factKey,
  );
  let latest: CatalogLocalOverride<Value> | null = null;
  for (const override of scoped) {
    if (latest === null || override.revision > latest.revision) {
      latest = override;
    }
  }
  return latest !== null && latest.lifecycle === 'ACTIVE' ? latest : null;
};

const failedTargetResult = <Value>(failure: ExternalCorrelationResolutionFailure): CatalogImportItemResult<Value> => {
  if (Schema.is(ExternalCorrelationMissingLink)(failure)) {
    return { reason: 'Unknown external record has no confirmed Catalog target', status: 'HELD' };
  }
  if (Schema.is(ExternalCorrelationAmbiguous)(failure)) {
    return { reason: failure.reason, status: 'RECONCILIATION_REQUIRED' };
  }
  if (Schema.is(ExternalCorrelationTargetTypeMismatch)(failure)) {
    return { reason: failure.reason, status: 'HELD' };
  }
  if (Schema.is(ExternalCorrelationUnverifiable)(failure)) {
    return { reason: failure.reason, status: 'UNVERIFIABLE' };
  }
  if (Schema.is(ExternalCorrelationInvalid)(failure)) {
    return { reason: failure.reason, status: 'INVALID_TARGET' };
  }
  return { reason: 'The external target could not be resolved', status: 'HELD' };
};

const decisionResult = <Value>(decision: CatalogAssertionDecision<Value>): CatalogImportItemResult<Value> => {
  if (decision.status === 'ACCEPTED') {
    return {
      base: decision.base,
      resolvedCurrentChanged: decision.currentChanged,
      scope: decision.base.scope,
      status: 'ACCEPTED_BASE',
    };
  }
  if (decision.status === 'DUPLICATE') {
    return { reason: decision.reason, status: 'DUPLICATE' };
  }
  if (decision.status === 'STALE') {
    return { reason: decision.reason, status: 'STALE' };
  }
  if (decision.status === 'NO_AUTHORITY') {
    return { reason: decision.reason, status: 'NO_AUTHORITY' };
  }
  if (decision.status === 'INVALID') {
    return { reason: decision.reason, status: 'INVALID_VALUE' };
  }
  return { reason: decision.reason, status: 'RECONCILIATION_REQUIRED' };
};

/** Batch counts make partial rejection and uncertain writes visible instead of hiding them. */
export const summarizeCatalogImportItems = <Value>(
  items: readonly CatalogImportItemResult<Value>[],
): CatalogImportBatchSummary => {
  const counts = {
    ACCEPTED_BASE: 0,
    DUPLICATE: 0,
    HELD: 0,
    INVALID_TARGET: 0,
    INVALID_VALUE: 0,
    NO_AUTHORITY: 0,
    RECONCILIATION_REQUIRED: 0,
    STALE: 0,
    UNVERIFIABLE: 0,
  };
  let resolvedCurrentChanged = 0;
  for (const item of items) {
    counts[item.status] += 1;
    if (item.status === 'ACCEPTED_BASE' && item.resolvedCurrentChanged) {
      resolvedCurrentChanged += 1;
    }
  }
  const rejected = counts.NO_AUTHORITY + counts.INVALID_TARGET + counts.INVALID_VALUE;
  return {
    acceptedBases: counts.ACCEPTED_BASE,
    allItemsResolved: counts.HELD === 0 && counts.RECONCILIATION_REQUIRED === 0 && counts.UNVERIFIABLE === 0,
    duplicates: counts.DUPLICATE,
    held: counts.HELD,
    reconciliationRequired: counts.RECONCILIATION_REQUIRED,
    rejected,
    resolvedCurrentChanged,
    stale: counts.STALE,
    unverifiable: counts.UNVERIFIABLE,
  };
};

/**
 * Accept one delivered assertion. The batch result is always per-item: an unknown external ID is
 * held and never creates a Product, duplicate delivery is a no-op, newer usable accepted evidence is
 * decided by source rules rather than arrival time, and omission simply produces no item.
 */
export const makeCatalogImportAcceptanceService = <Value>(wiring: CatalogImportAcceptanceWiring<Value>) => {
  const acceptItem = Effect.fn('CatalogImportAcceptance.acceptItem')(function* acceptItem(input: {
    readonly at: Date;
    readonly item: CatalogImportDeliveredItem<Value>;
  }): Effect.fn.Return<CatalogImportItemResult<Value>, CatalogSourceResolutionUnavailable> {
    const {
      assertion,
      captureConfirmed,
      classification: suppliedClassification,
      recordMeaning,
      sourceRecord,
    } = input.item;
    if (
      assertion.scope.tenantId !== sourceRecord.tenantId ||
      assertion.issuerSystemId !== sourceRecord.issuerId ||
      assertion.sourceRecordId !== sourceRecord.recordId
    ) {
      return { reason: 'Assertion provenance does not match the exact source identity', status: 'INVALID_TARGET' };
    }
    const resolvedTarget = yield* wiring.resolveTarget({ recordMeaning, sourceRecord }).pipe(
      Effect.match({
        onFailure: (failure) => ({ failure, kind: 'UNRESOLVED' as const }),
        onSuccess: (resolution) => ({ kind: 'RESOLVED' as const, resolution }),
      }),
    );
    if (resolvedTarget.kind === 'UNRESOLVED') {
      return failedTargetResult<Value>(resolvedTarget.failure);
    }
    const { resolution } = resolvedTarget;
    if (resolution.capture === 'REQUIRED_BEFORE_ACCEPTANCE' && !captureConfirmed) {
      return { reason: 'CORRELATION_NOT_CAPTURED', status: 'HELD' };
    }
    if (
      assertion.scope.targetKind !== resolution.targetKind ||
      assertion.scope.targetId !== resolution.target.resourceId
    ) {
      return { reason: 'The assertion scope does not match the confirmed Catalog target', status: 'INVALID_TARGET' };
    }
    const scope: CatalogFactScope = {
      factKey: assertion.scope.factKey,
      targetId: resolution.target.resourceId,
      targetKind: resolution.targetKind,
      tenantId: resolution.target.tenantId,
    };
    const [authorityOption, admissionOption, bases, overrides] = yield* Effect.all(
      [
        wiring.authority.resolveAuthority({ issuerSystemId: assertion.issuerSystemId, scope }),
        wiring.admission.readAdmission(scope),
        wiring.store.readAcceptedBases(scope),
        wiring.store.readOverrides(scope),
      ] as const,
      { concurrency: 4 },
    );
    const valueValid = yield* wiring.admission.isAssertionValueValid({ assertion, scope });
    const currentBase = selectCurrentBase(bases, assertion);
    const decision = assessCatalogSourceAssertion({
      activeOverride: selectActiveOverride(overrides, scope),
      admission: Option.getOrNull(admissionOption),
      assertion,
      at: input.at,
      authority: Option.getOrNull(authorityOption),
      currentBase,
      targetVerified: true,
      valuesEqual: wiring.valuesEqual,
      valueValid,
    });
    if (decision.status !== 'ACCEPTED') {
      return decisionResult<Value>(decision);
    }
    let classification: CosmeticProductCorrection | undefined;
    if (
      currentBase !== null &&
      !wiring.valuesEqual(currentBase.value, assertion.value) &&
      (scope.targetKind === 'PRODUCT' || scope.targetKind === 'VARIANT')
    ) {
      const checked = yield* requireExistingCatalogFactChangeClassification({
        classification: suppliedClassification,
        evidenceRef: assertion.assertionId,
        target: {
          resourceId: scope.targetId,
          targetKind: scope.targetKind,
          tenantId: scope.tenantId,
        },
      }).pipe(
        Effect.match({
          onFailure: (error) => ({ error, status: 'REJECTED' as const }),
          onSuccess: (value) => ({ status: 'ACCEPTED' as const, value }),
        }),
      );
      if (checked.status === 'REJECTED') {
        return { reason: checked.error.reason, status: 'RECONCILIATION_REQUIRED' };
      }
      classification = checked.value;
    }
    const verifiedAuthority = Option.getOrNull(authorityOption);
    if (verifiedAuthority === null) {
      return { reason: 'Verified source authority disappeared before persistence', status: 'UNVERIFIABLE' };
    }
    const append = yield* wiring.store.appendAcceptedBase({
      assertion: decision.base,
      authority: verifiedAuthority,
      captureConfirmed,
      sourceRecord,
      targetResolution: resolution,
    });
    if (append.status === 'ALREADY_PRESENT') {
      return { reason: 'The same source assertion was already accepted', status: 'DUPLICATE' };
    }
    if (append.status === 'CONFLICT') {
      return { reason: append.reason, status: 'RECONCILIATION_REQUIRED' };
    }
    const admission = Option.getOrNull(admissionOption);
    const previous = resolveCatalogSourceFact({
      acceptedBases: bases,
      admission,
      at: input.at,
      overrides,
      scope,
      valuesEqual: wiring.valuesEqual,
    });
    const next = resolveCatalogSourceFact({
      acceptedBases: [...bases, decision.base],
      admission,
      at: input.at,
      overrides,
      scope,
      valuesEqual: wiring.valuesEqual,
    });
    const change = decideCatalogResolvedCurrentChange({ next, previous, valuesEqual: wiring.valuesEqual });
    if (change.kind === 'CHANGED') {
      yield* wiring.events.emitResolvedCurrentChanged({
        cause: 'IMPORT_ACCEPTED',
        next: change.next,
        previous: change.previous,
        scope,
        sourceRevision: {
          assertionId: decision.base.assertionId,
          issuerSystemId: decision.base.issuerSystemId,
          kind: 'ACCEPTED_BASE',
          sourceRecordId: decision.base.sourceRecordId,
          sourceRevision: decision.base.sourceRevision,
        },
      });
    }
    const accepted = {
      base: decision.base,
      resolvedCurrentChanged: change.kind === 'CHANGED',
      scope,
      status: 'ACCEPTED_BASE' as const,
    };
    return classification === undefined ? accepted : { ...accepted, classification };
  });

  const acceptBatch = Effect.fn('CatalogImportAcceptance.acceptBatch')(function* acceptBatch(
    input: CatalogImportBatchInput<Value>,
  ): Effect.fn.Return<CatalogImportBatchResult<Value>, CatalogSourceResolutionUnavailable> {
    const items = yield* Effect.forEach(input.items, (item) => acceptItem({ at: input.at, item }), { concurrency: 1 });
    return { items, summary: summarizeCatalogImportItems(items) };
  });

  return { acceptBatch };
};

export type CatalogImportAcceptanceOperations<Value> = ReturnType<typeof makeCatalogImportAcceptanceService<Value>>;

export interface CatalogImportAcceptanceServiceFactoryService {
  readonly make: <Value>(wiring: CatalogImportAcceptanceWiring<Value>) => CatalogImportAcceptanceOperations<Value>;
}

export class CatalogImportAcceptanceServiceFactory extends Context.Service<
  CatalogImportAcceptanceServiceFactory,
  CatalogImportAcceptanceServiceFactoryService
>()('@app/catalog/persistence/catalog-import-acceptance-service/CatalogImportAcceptanceServiceFactory') {}

export const catalogImportAcceptanceServiceFactoryLive = Layer.succeed(
  CatalogImportAcceptanceServiceFactory,
  Object.freeze({ make: makeCatalogImportAcceptanceService }),
);
