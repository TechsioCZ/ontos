import { Context, DateTime, Effect, Layer, Option, Schema } from 'effect';

import type { CatalogLocalOverrideOperation } from '../domain/catalog-local-override.ts';
import type {
  CosmeticProductCorrection,
  ProductChangeClassification,
} from '../../shared/domain/product-change-classification.ts';
import { requireExistingCatalogFactChangeClassification } from '../../shared/domain/product-change-classification.ts';
import {
  catalogLocalOverridePermission,
  decideCatalogLocalOverrideTransition,
} from '../domain/catalog-local-override.ts';
import type {
  CatalogCurrentResolution,
  CatalogFactAdmission,
  CatalogFactScope,
  CatalogLocalOverride,
  CatalogSourceAssertion,
} from '../domain/catalog-source-resolution.ts';
import { resolveCatalogSourceFact } from '../domain/catalog-source-resolution.ts';
import { decideCatalogResolvedCurrentChange } from './catalog-resolved-current-event-seam.ts';
import type {
  CatalogFactAdmissionPorts,
  CatalogResolvedCurrentChangeCause,
  CatalogResolvedCurrentEventPorts,
  CatalogSourceResolutionPorts,
  CatalogSourceResolutionUnavailable,
} from './catalog-source-resolution-ports.ts';

export interface CatalogLocalOverrideActivation<Value> {
  readonly at: Date;
  readonly classification?: ProductChangeClassification;
  readonly evidenceRef: string;
  readonly principalId: string;
  readonly reason: string;
  readonly scope: CatalogFactScope;
  readonly value: Value;
}

export interface CatalogLocalOverrideChange<Value> extends CatalogLocalOverrideActivation<Value> {
  readonly expectedRevision: bigint;
}

export interface CatalogLocalOverrideRelease {
  readonly at: Date;
  readonly evidenceRef: string;
  readonly expectedRevision: bigint;
  readonly principalId: string;
  readonly reason: string;
  readonly scope: CatalogFactScope;
}

export type CatalogLocalOverrideOperationResult<Value> =
  | {
      readonly action: CatalogLocalOverrideOperation;
      readonly classification?: CosmeticProductCorrection;
      readonly override: CatalogLocalOverride<Value>;
      readonly resolved: CatalogCurrentResolution<Value>;
      readonly resolvedCurrentChanged: boolean;
      readonly status: 'APPLIED';
    }
  | {
      readonly reason: string;
      readonly status:
        | 'PERMISSION_REQUIRED'
        | 'FORBIDDEN_FACT'
        | 'NO_AUTHORITY'
        | 'NO_ACTIVE_OVERRIDE'
        | 'ALREADY_ACTIVE'
        | 'ALREADY_RELEASED'
        | 'STALE_EDITOR'
        | 'INVALID'
        | 'CONFLICT'
        | 'UNAVAILABLE'
        | 'INDETERMINATE';
    };

export interface CatalogLocalOverrideWiring<Value> {
  readonly admission: CatalogFactAdmissionPorts<Value>;
  readonly events: CatalogResolvedCurrentEventPorts<Value>;
  readonly store: CatalogSourceResolutionPorts<Value>;
  readonly valuesEqual: (left: Value, right: Value) => boolean;
}

const activeOverrideValue = <Value>(
  overrides: readonly CatalogLocalOverride<Value>[],
  scope: CatalogFactScope,
): Value | null => {
  let latest: CatalogLocalOverride<Value> | null = null;
  for (const override of overrides) {
    if (
      override.scope.tenantId === scope.tenantId &&
      override.scope.targetKind === scope.targetKind &&
      override.scope.targetId === scope.targetId &&
      override.scope.factKey === scope.factKey &&
      override.lifecycle === 'ACTIVE' &&
      (latest === null || override.revision > latest.revision)
    ) {
      latest = override;
    }
  }
  return latest === null ? null : latest.value;
};

const CatalogLocalOverrideTransitionFailureStatusSchema = Schema.Literals([
  'PERMISSION_REQUIRED',
  'FORBIDDEN_FACT',
  'NO_ACTIVE_OVERRIDE',
  'ALREADY_ACTIVE',
  'ALREADY_RELEASED',
  'STALE_EDITOR',
  'INDETERMINATE',
]);
type CatalogLocalOverrideTransitionFailureStatus = typeof CatalogLocalOverrideTransitionFailureStatusSchema.Type;

const transitionFailure = <Value>(
  status: CatalogLocalOverrideTransitionFailureStatus,
  reason: string,
): CatalogLocalOverrideOperationResult<Value> => ({ reason, status });

const operationChangeCause = {
  ACTIVATE: 'OVERRIDE_ACTIVATED',
  CHANGE: 'OVERRIDE_CHANGED',
  RELEASE: 'OVERRIDE_RELEASED',
} as const satisfies Record<CatalogLocalOverrideOperation, CatalogResolvedCurrentChangeCause>;

const epochOf = (value: Date): number => DateTime.toEpochMillis(DateTime.makeUnsafe(value));

const newestAcceptedBaseFirst = <Value>(left: CatalogSourceAssertion<Value>, right: CatalogSourceAssertion<Value>) => {
  if (left.sourceRevision === right.sourceRevision) {
    return epochOf(right.evidencedAt) - epochOf(left.evidencedAt);
  }
  return left.sourceRevision < right.sourceRevision ? 1 : -1;
};

const ProductTargetKindSchema = Schema.Literals(['PRODUCT', 'VARIANT']);
const isProductTargetKind = Schema.is(ProductTargetKindSchema);

const acceptedBaseRevisionFor = <Value>(input: {
  readonly at: Date;
  readonly bases: readonly CatalogSourceAssertion<Value>[];
  readonly resolved: CatalogCurrentResolution<Value>;
  readonly valuesEqual: (left: Value, right: Value) => boolean;
}) => {
  if (input.resolved.status !== 'CURRENT' || input.resolved.source !== 'BASE') {
    return null;
  }
  const resolvedValue = input.resolved.value;
  const epoch = epochOf(input.at);
  const matching = input.bases.filter(
    (base) =>
      Number.isFinite(epoch) &&
      epochOf(base.effectiveFrom) <= epoch &&
      (base.effectiveTo === undefined || epoch < epochOf(base.effectiveTo)) &&
      input.valuesEqual(base.value, resolvedValue),
  );
  return matching.toSorted(newestAcceptedBaseFirst)[0] ?? null;
};

/**
 * One explicit Catalog decision over one exact Catalog-owned fact/scope. Permission, ownership,
 * validity, single-active-winner compare-and-set, and release-to-latest-base are all enforced here;
 * a released override never remains secretly active and a mere base update never claims a change.
 */
export const makeCatalogLocalOverrideService = <Value>(wiring: CatalogLocalOverrideWiring<Value>) => {
  const runOperation = Effect.fn('CatalogLocalOverride.runOperation')(function* runOperation(input: {
    readonly at: Date;
    readonly classification: ProductChangeClassification | null;
    readonly evidenceRef: string;
    readonly expectedRevision: bigint | null;
    readonly operation: CatalogLocalOverrideOperation;
    readonly principalId: string;
    readonly reason: string;
    readonly scope: CatalogFactScope;
    readonly value: Value | null;
  }): Effect.fn.Return<CatalogLocalOverrideOperationResult<Value>, CatalogSourceResolutionUnavailable> {
    const admissionOption = yield* wiring.admission.readAdmission(input.scope);
    const admission = Option.getOrNull(admissionOption);
    if (admission === null) {
      return { reason: 'Catalog fact admission is unavailable', status: 'UNAVAILABLE' };
    }
    if (admission.factOwnership !== 'CATALOG_LOCAL') {
      return { reason: 'Local Override may only hold a Catalog-owned fact', status: 'NO_AUTHORITY' };
    }
    const authorized = yield* wiring.admission.authorizeOverrideOperation({
      operation: input.operation,
      permissionKey: catalogLocalOverridePermission[input.operation],
      principalId: input.principalId,
      scope: input.scope,
    });
    const overrides = yield* wiring.store.readOverrides(input.scope);
    const transition = decideCatalogLocalOverrideTransition({
      authorized,
      expectedRevision: input.expectedRevision,
      operation: input.operation,
      overrides,
      scope: input.scope,
    });
    if (transition.status !== 'PROCEED') {
      return transitionFailure<Value>(transition.status, transition.reason);
    }
    const value = input.operation === 'RELEASE' ? activeOverrideValue(overrides, input.scope) : input.value;
    if (value === null) {
      return { reason: 'Local Override requires a value for this exact Catalog fact', status: 'INVALID' };
    }
    if (input.operation !== 'RELEASE') {
      const valueValid = yield* wiring.admission.isOverrideValueValid({
        principalId: input.principalId,
        scope: input.scope,
        value,
      });
      if (!valueValid) {
        return { reason: 'Local Override value is not valid for the Catalog fact', status: 'INVALID' };
      }
    }
    const override: CatalogLocalOverride<Value> = {
      actorPrincipalId: input.principalId,
      evidenceRef: input.evidenceRef,
      lifecycle: input.operation === 'RELEASE' ? 'RELEASED' : 'ACTIVE',
      reason: input.reason,
      revision: transition.nextRevision,
      scope: input.scope,
      value,
    };
    const bases = yield* wiring.store.readAcceptedBases(input.scope);
    const resolutionAdmission: CatalogFactAdmission = {
      assertionAdmission: admission.assertionAdmission,
      factOwnership: admission.factOwnership,
      overridePermitted: true,
      overrideValueValid: true,
    };
    const previous = resolveCatalogSourceFact({
      acceptedBases: bases,
      admission: resolutionAdmission,
      at: input.at,
      overrides,
      scope: input.scope,
      valuesEqual: wiring.valuesEqual,
    });
    let classification: CosmeticProductCorrection | undefined;
    if (
      input.operation !== 'RELEASE' &&
      previous.status === 'CURRENT' &&
      !wiring.valuesEqual(previous.value, value) &&
      isProductTargetKind(input.scope.targetKind)
    ) {
      const checked = yield* requireExistingCatalogFactChangeClassification({
        classification: input.classification ?? undefined,
        evidenceRef: input.evidenceRef,
        reason: input.reason,
        target: {
          resourceId: input.scope.targetId,
          targetKind: input.scope.targetKind,
          tenantId: input.scope.tenantId,
        },
      }).pipe(
        Effect.match({
          onFailure: (error) => ({ error, status: 'REJECTED' as const }),
          onSuccess: (checkedClassification) => ({ status: 'ACCEPTED' as const, value: checkedClassification }),
        }),
      );
      if (checked.status === 'REJECTED') {
        return { reason: checked.error.reason, status: 'INVALID' };
      }
      classification = checked.value;
    }
    const next = resolveCatalogSourceFact({
      acceptedBases: bases,
      admission: resolutionAdmission,
      at: input.at,
      overrides: [...overrides, override],
      scope: input.scope,
      valuesEqual: wiring.valuesEqual,
    });
    const append = yield* wiring.store.appendOverrideRevision({
      expectedRevision: input.operation === 'ACTIVATE' ? null : input.expectedRevision,
      override,
    });
    if (append.status === 'CONFLICT') {
      return { reason: append.reason, status: 'CONFLICT' };
    }
    const change = decideCatalogResolvedCurrentChange({ next, previous, valuesEqual: wiring.valuesEqual });
    if (change.kind === 'CHANGED') {
      const acceptedBase = acceptedBaseRevisionFor({
        at: input.at,
        bases,
        resolved: next,
        valuesEqual: wiring.valuesEqual,
      });
      const sourceRevision =
        acceptedBase === null
          ? {
              evidenceRef: override.evidenceRef,
              kind: 'LOCAL_OVERRIDE' as const,
              revision: override.revision,
            }
          : {
              assertionId: acceptedBase.assertionId,
              issuerSystemId: acceptedBase.issuerSystemId,
              kind: 'ACCEPTED_BASE' as const,
              sourceRecordId: acceptedBase.sourceRecordId,
              sourceRevision: acceptedBase.sourceRevision,
            };
      yield* wiring.events.emitResolvedCurrentChanged({
        cause: operationChangeCause[input.operation],
        next: change.next,
        previous: change.previous,
        scope: input.scope,
        sourceRevision,
      });
    }
    const applied = {
      action: input.operation,
      override,
      resolved: next,
      resolvedCurrentChanged: change.kind === 'CHANGED',
      status: 'APPLIED' as const,
    };
    return classification === undefined ? applied : { ...applied, classification };
  });

  return {
    activate: Effect.fn('CatalogLocalOverride.activate')(function* activate(
      input: CatalogLocalOverrideActivation<Value>,
    ) {
      return yield* runOperation({
        at: input.at,
        classification: input.classification ?? null,
        evidenceRef: input.evidenceRef,
        expectedRevision: null,
        operation: 'ACTIVATE',
        principalId: input.principalId,
        reason: input.reason,
        scope: input.scope,
        value: input.value,
      });
    }),
    change: Effect.fn('CatalogLocalOverride.change')(function* change(input: CatalogLocalOverrideChange<Value>) {
      return yield* runOperation({
        at: input.at,
        classification: input.classification ?? null,
        evidenceRef: input.evidenceRef,
        expectedRevision: input.expectedRevision,
        operation: 'CHANGE',
        principalId: input.principalId,
        reason: input.reason,
        scope: input.scope,
        value: input.value,
      });
    }),
    release: Effect.fn('CatalogLocalOverride.release')(function* release(input: CatalogLocalOverrideRelease) {
      return yield* runOperation({
        at: input.at,
        classification: null,
        evidenceRef: input.evidenceRef,
        expectedRevision: input.expectedRevision,
        operation: 'RELEASE',
        principalId: input.principalId,
        reason: input.reason,
        scope: input.scope,
        value: null,
      });
    }),
  };
};

export type CatalogLocalOverrideOperations<Value> = ReturnType<typeof makeCatalogLocalOverrideService<Value>>;

export interface CatalogLocalOverrideServiceFactoryService {
  readonly make: <Value>(wiring: CatalogLocalOverrideWiring<Value>) => CatalogLocalOverrideOperations<Value>;
}

export class CatalogLocalOverrideServiceFactory extends Context.Service<
  CatalogLocalOverrideServiceFactory,
  CatalogLocalOverrideServiceFactoryService
>()('@app/catalog/persistence/catalog-local-override-service/CatalogLocalOverrideServiceFactory') {}

export const catalogLocalOverrideServiceFactoryLive = Layer.succeed(
  CatalogLocalOverrideServiceFactory,
  Object.freeze({ make: makeCatalogLocalOverrideService }),
);
