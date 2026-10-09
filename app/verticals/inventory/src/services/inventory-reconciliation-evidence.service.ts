/* oxlint-disable effect-native/no-dependency-parameters -- Core supplies only transaction-scoped owner ports after the governed Read gate; expires: 2027-03-31. */
import type { Effect as EffectType, Option as OptionType } from 'effect';
import { DateTime, Effect, Match, Option, Schema } from 'effect';

import { INVENTORY_RECONCILIATION_EVIDENCE_LIMIT } from '../../shared/apis/inventory-reconciliation-evidence.ts';
import type {
  InventoryPrivacyOwnerLookup,
  InventoryReconciliationEvidenceQuery,
  InventoryReconciliationEvidenceResponse,
} from '../../shared/apis/inventory-reconciliation-evidence.ts';
import type { CatalogToStockBindingPersistence } from '../../shared/domain/catalog-to-stock-binding.ts';
import type { CommitmentProtectionPersistence } from '../../shared/domain/commitment-protection.ts';
import type { ExternalStockCorrelationPersistence } from '../../shared/domain/external-stock-correlation.ts';
import type { InventoryEffectLedgerRecord } from '../../shared/domain/inventory-effect-ledger.ts';
import type { InventoryObligation } from '../../shared/domain/inventory-obligation.ts';
import { InventoryReconciliationEvidenceRejected } from '../../shared/domain/inventory-reconciliation-evidence-rejected.ts';
import { InventoryReconciliationEvidenceUnavailable } from '../../shared/domain/inventory-reconciliation-evidence-unavailable.ts';
import type { ReservationConfirmationPersistence } from '../../shared/domain/reservation-confirmation.ts';
import type { StockSharingEligibilityPersistence } from '../../shared/domain/stock-sharing-eligibility.ts';
import {
  assessInventoryPrivacyOwnerCoverage,
  inventoryPrivacyOwnerScopeParts,
} from '../../shared/inventory-privacy-owner-contract.ts';
import type {
  InventoryPrivacyOwnerScopePart,
  InventoryPrivacyScopeObservation,
} from '../../shared/inventory-privacy-owner-contract.ts';
import type { InventoryObligationPersistence } from '../persistence/inventory-obligation-repository.ts';
import type { InventoryEffectLedgerPersistence } from './inventory-effect-ledger.service.ts';
import type { InventorySourceConflictPersistence } from './inventory-source-conflict.service.ts';

export const InventoryReconciliationEvidenceErrorSchema = Schema.Union([
  InventoryReconciliationEvidenceRejected,
  InventoryReconciliationEvidenceUnavailable,
]);
export type InventoryReconciliationEvidenceError = typeof InventoryReconciliationEvidenceErrorSchema.Type;

export interface InventoryReconciliationEvidenceDependencies {
  readonly bindings: Pick<CatalogToStockBindingPersistence, 'readHistory'>;
  readonly confirmations: Pick<ReservationConfirmationPersistence, 'readHistory'>;
  readonly conflicts: Pick<InventorySourceConflictPersistence, 'findLatest'>;
  readonly correlations: Pick<ExternalStockCorrelationPersistence, 'findByRef'>;
  readonly effects: Pick<InventoryEffectLedgerPersistence, 'read'>;
  readonly obligations: Pick<InventoryObligationPersistence, 'read'>;
  readonly protections: Pick<CommitmentProtectionPersistence, 'readHistory'>;
  readonly sharing: Pick<StockSharingEligibilityPersistence, 'readHistory'>;
}

export interface InventoryReconciliationEvidenceScope {
  readonly legalEntityId: string;
  readonly tenantId: string;
}

const unavailable = (cause?: unknown) => {
  const failure = new InventoryReconciliationEvidenceUnavailable({
    code: 'inventory_reconciliation_evidence_unavailable',
    reason: 'Inventory reconciliation evidence is temporarily unavailable',
    retryable: true,
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

const rejected = (reason: InventoryReconciliationEvidenceRejected['reason']) =>
  new InventoryReconciliationEvidenceRejected({
    code: 'inventory_reconciliation_evidence_rejected',
    reason,
  });

const exactResource = (
  left: {
    readonly moduleId: string;
    readonly resourceId: string;
    readonly resourceType: string;
    readonly tenantId: string;
  },
  right: {
    readonly moduleId: string;
    readonly resourceId: string;
    readonly resourceType: string;
    readonly tenantId: string;
  },
) =>
  left.moduleId === right.moduleId &&
  left.resourceId === right.resourceId &&
  left.resourceType === right.resourceType &&
  left.tenantId === right.tenantId;

const effectOwner = (record: InventoryEffectLedgerRecord) =>
  Match.value(record.intent).pipe(
    Match.tag('PHYSICAL_ISSUE', 'PHYSICAL_RECEIPT', ({ request }) => request.positionRef),
    Match.tag('RESERVATION_CREATE', 'RESERVATION_RELEASE', ({ request }) => request.reservation.ref),
    Match.tag('ESTABLISH_COMMITMENT_PROTECTION', ({ request }) => request.confirmation.reservation.ref),
    Match.exhaustive,
  );

const effectLegalEntityId = (record: InventoryEffectLedgerRecord): string => record.intent.request.legalEntityId;

const boundedHistory = <Entry, Response extends InventoryReconciliationEvidenceResponse>(
  entries: readonly Entry[],
  response: (bounded: readonly Entry[]) => Response,
): EffectType.Effect<
  OptionType.Option<InventoryReconciliationEvidenceResponse>,
  InventoryReconciliationEvidenceRejected
> => {
  if (entries.length === 0) {
    return Effect.succeedNone;
  }
  if (entries.length > INVENTORY_RECONCILIATION_EVIDENCE_LIMIT) {
    return Effect.fail(rejected('EVIDENCE_LIMIT_EXCEEDED'));
  }
  return Effect.succeedSome(response(entries));
};

const readBindingHistory = (
  dependencies: InventoryReconciliationEvidenceDependencies,
  request: Extract<InventoryReconciliationEvidenceQuery, { readonly _tag: 'BINDING_HISTORY' }>,
) =>
  dependencies.bindings.readHistory(request.bindingRef).pipe(
    Effect.mapError(unavailable),
    Effect.flatMap((entries) =>
      boundedHistory(entries, (bounded) => ({
        _tag: 'BINDING_HISTORY',
        bindingRef: request.bindingRef,
        entries: bounded,
      })),
    ),
  );

const readSharingHistory = (
  dependencies: InventoryReconciliationEvidenceDependencies,
  request: Extract<InventoryReconciliationEvidenceQuery, { readonly _tag: 'SHARING_HISTORY' }>,
) =>
  dependencies.sharing.readHistory(request.relationRef).pipe(
    Effect.mapError(unavailable),
    Effect.flatMap((entries) =>
      boundedHistory(entries, (bounded) => ({
        _tag: 'SHARING_HISTORY',
        entries: bounded,
        relationRef: request.relationRef,
      })),
    ),
  );

const readConfirmationHistory = (
  dependencies: InventoryReconciliationEvidenceDependencies,
  request: Extract<InventoryReconciliationEvidenceQuery, { readonly _tag: 'CONFIRMATION_HISTORY' }>,
) =>
  dependencies.confirmations.readHistory(request.confirmationRef).pipe(
    Effect.mapError(unavailable),
    Effect.flatMap((entries) =>
      boundedHistory(entries, (bounded) => ({
        _tag: 'CONFIRMATION_HISTORY',
        confirmationRef: request.confirmationRef,
        entries: bounded,
      })),
    ),
  );

const readProtectionHistory = (
  dependencies: InventoryReconciliationEvidenceDependencies,
  request: Extract<InventoryReconciliationEvidenceQuery, { readonly _tag: 'PROTECTION_HISTORY' }>,
) =>
  dependencies.protections.readHistory(request.protectionRef).pipe(
    Effect.mapError(unavailable),
    Effect.flatMap((entries) =>
      boundedHistory(entries, (bounded) => ({
        _tag: 'PROTECTION_HISTORY',
        entries: bounded,
        protectionRef: request.protectionRef,
      })),
    ),
  );

type PrivacyCoverageRequest = Extract<
  InventoryReconciliationEvidenceQuery,
  { readonly _tag: 'PRIVACY_OWNER_COVERAGE' }
>;

interface PrivacyCoverageContribution {
  readonly coverageStatus: InventoryPrivacyScopeObservation['coverageStatus'];
  readonly evidenceRefs: readonly string[];
  readonly foundContentRefs: readonly string[];
  readonly scopePart: InventoryPrivacyOwnerScopePart;
  readonly unresolvedReason?: string;
}

const unique = (references: readonly string[]): readonly string[] => [...new Set(references)];

const privacyFoundRefs = (lookupRef: string, found: boolean): readonly string[] => (found ? [lookupRef] : []);

const incompleteContribution = (
  scopePart: InventoryPrivacyOwnerScopePart,
  lookupRef: string,
  found: boolean,
  evidenceRefs: readonly string[],
  unresolvedReason: string,
): PrivacyCoverageContribution => ({
  coverageStatus: 'PARTIAL',
  evidenceRefs,
  foundContentRefs: privacyFoundRefs(lookupRef, found),
  scopePart,
  unresolvedReason,
});

const unavailableContributions = (
  scopeParts: readonly InventoryPrivacyOwnerScopePart[],
  unresolvedReason: string,
): readonly PrivacyCoverageContribution[] =>
  scopeParts.map((scopePart) => ({
    coverageStatus: 'UNAVAILABLE',
    evidenceRefs: [],
    foundContentRefs: [],
    scopePart,
    unresolvedReason,
  }));

const obligationEvidenceRefs = (obligation: InventoryObligation): readonly string[] =>
  obligation.lifecycleMeaning === 'COMMITTED_OBLIGATION' ? [obligation.orderProof.evidenceRef] : [];

const readPrivacyLookup = (
  dependencies: InventoryReconciliationEvidenceDependencies,
  request: PrivacyCoverageRequest,
  lookup: InventoryPrivacyOwnerLookup,
): EffectType.Effect<readonly PrivacyCoverageContribution[]> =>
  Match.value(lookup).pipe(
    Match.tag('RESERVATION_OBLIGATION', ({ lookupRef }) =>
      dependencies.obligations.read(request.ownerRef).pipe(
        Effect.match({
          onFailure: (error) =>
            unavailableContributions(
              [
                'CURRENT_RESERVATION_CORRELATIONS',
                'BACKEND_AUTHORITY_AND_CUTOVER_HISTORY',
                'DEMAND_SELECTION_BINDING_AND_REQUIREMENTS_HISTORY',
                'RESERVATION_ATTEMPT_ORDER_AND_ALLOCATION_HISTORY',
                'COMMITTED_OBLIGATION_HISTORY',
              ],
              `INVENTORY_OBLIGATION_EVIDENCE_UNAVAILABLE:${error._tag}`,
            ),
          onSuccess: Option.match({
            onNone: (): readonly PrivacyCoverageContribution[] => [
              {
                coverageStatus: 'COMPLETE',
                evidenceRefs: [],
                foundContentRefs: [],
                scopePart: 'CURRENT_RESERVATION_CORRELATIONS',
              },
              incompleteContribution(
                'BACKEND_AUTHORITY_AND_CUTOVER_HISTORY',
                lookupRef,
                false,
                [],
                'HISTORICAL_BACKEND_AUTHORITY_ENUMERATION_UNAVAILABLE',
              ),
              incompleteContribution(
                'DEMAND_SELECTION_BINDING_AND_REQUIREMENTS_HISTORY',
                lookupRef,
                false,
                [],
                'HISTORICAL_RESERVATION_REQUIREMENTS_ENUMERATION_UNAVAILABLE',
              ),
              incompleteContribution(
                'RESERVATION_ATTEMPT_ORDER_AND_ALLOCATION_HISTORY',
                lookupRef,
                false,
                [],
                'HISTORICAL_RESERVATION_ENUMERATION_UNAVAILABLE',
              ),
              incompleteContribution(
                'COMMITTED_OBLIGATION_HISTORY',
                lookupRef,
                false,
                [],
                'HISTORICAL_COMMITTED_OBLIGATION_ENUMERATION_UNAVAILABLE',
              ),
            ],
            onSome: (obligation): readonly PrivacyCoverageContribution[] => {
              const evidenceRefs = obligationEvidenceRefs(obligation);
              const committed = obligation.lifecycleMeaning === 'COMMITTED_OBLIGATION';
              return [
                {
                  coverageStatus: 'COMPLETE',
                  evidenceRefs,
                  foundContentRefs: [lookupRef],
                  scopePart: 'CURRENT_RESERVATION_CORRELATIONS',
                },
                incompleteContribution(
                  'BACKEND_AUTHORITY_AND_CUTOVER_HISTORY',
                  lookupRef,
                  true,
                  evidenceRefs,
                  'ONLY_CURRENT_BACKEND_AUTHORITY_WAS_VERIFIED',
                ),
                incompleteContribution(
                  'DEMAND_SELECTION_BINDING_AND_REQUIREMENTS_HISTORY',
                  lookupRef,
                  true,
                  evidenceRefs,
                  'HISTORICAL_RESERVATION_REQUIREMENTS_ENUMERATION_UNAVAILABLE',
                ),
                incompleteContribution(
                  'RESERVATION_ATTEMPT_ORDER_AND_ALLOCATION_HISTORY',
                  lookupRef,
                  true,
                  evidenceRefs,
                  'HISTORICAL_RESERVATION_ENUMERATION_UNAVAILABLE',
                ),
                incompleteContribution(
                  'COMMITTED_OBLIGATION_HISTORY',
                  lookupRef,
                  committed,
                  evidenceRefs,
                  'HISTORICAL_COMMITTED_OBLIGATION_ENUMERATION_UNAVAILABLE',
                ),
              ];
            },
          }),
        }),
      ),
    ),
    Match.tag('BINDING_HISTORY', ({ bindingRef, lookupRef }) =>
      dependencies.bindings.readHistory(bindingRef).pipe(
        Effect.match({
          onFailure: (error) =>
            unavailableContributions(
              ['DEMAND_SELECTION_BINDING_AND_REQUIREMENTS_HISTORY'],
              `CATALOG_BINDING_HISTORY_UNAVAILABLE:${error._tag}`,
            ),
          onSuccess: (entries): readonly PrivacyCoverageContribution[] => [
            incompleteContribution(
              'DEMAND_SELECTION_BINDING_AND_REQUIREMENTS_HISTORY',
              lookupRef,
              entries.length > 0,
              entries.map(({ ownerEvidenceRef }) => ownerEvidenceRef),
              'COMPLETE_RESERVATION_REQUIREMENT_HISTORY_CANNOT_BE_ENUMERATED',
            ),
          ],
        }),
      ),
    ),
    Match.tag('CONFIRMATION_HISTORY', ({ confirmationRef, lookupRef }) =>
      dependencies.confirmations.readHistory(confirmationRef).pipe(
        Effect.match({
          onFailure: (error) =>
            unavailableContributions(
              ['CONFIRMATION_SHORTAGE_PRIORITY_AND_RELEASE_HISTORY'],
              `RESERVATION_CONFIRMATION_HISTORY_UNAVAILABLE:${error._tag}`,
            ),
          onSuccess: (entries): readonly PrivacyCoverageContribution[] => {
            const owned = entries.filter(({ reservation }) => exactResource(reservation.ref, request.ownerRef));
            return [
              incompleteContribution(
                'CONFIRMATION_SHORTAGE_PRIORITY_AND_RELEASE_HISTORY',
                lookupRef,
                owned.length > 0,
                owned.map(({ authorityEvidence }) => authorityEvidence.evidence.ownerEvidenceRef),
                'COMPLETE_CONFIRMATION_HISTORY_CANNOT_BE_ENUMERATED_FROM_RESERVATION_SCOPE',
              ),
            ];
          },
        }),
      ),
    ),
    Match.tag('PROTECTION_HISTORY', ({ lookupRef, protectionRef }) =>
      dependencies.protections.readHistory(protectionRef).pipe(
        Effect.match({
          onFailure: (error) =>
            unavailableContributions(
              ['COMMITMENT_PROTECTION_HISTORY'],
              `COMMITMENT_PROTECTION_HISTORY_UNAVAILABLE:${error._tag}`,
            ),
          onSuccess: (entries): readonly PrivacyCoverageContribution[] => {
            const owned = entries.filter(({ confirmation }) =>
              exactResource(confirmation.reservation.ref, request.ownerRef),
            );
            return [
              incompleteContribution(
                'COMMITMENT_PROTECTION_HISTORY',
                lookupRef,
                owned.length > 0,
                owned.map(({ authorityEvidence }) => authorityEvidence.evidence.ownerEvidenceRef),
                'COMPLETE_COMMITMENT_PROTECTION_HISTORY_CANNOT_BE_ENUMERATED_FROM_RESERVATION_SCOPE',
              ),
            ];
          },
        }),
      ),
    ),
    Match.tag('EFFECT_OUTCOME', ({ effectId, lookupRef }) =>
      dependencies.effects.read(effectId).pipe(
        Effect.map(
          Option.filter(
            (record) =>
              record.tenantId === request.ownerRef.tenantId && exactResource(effectOwner(record), request.ownerRef),
          ),
        ),
        Effect.match({
          onFailure: (error) =>
            unavailableContributions(
              ['EFFECT_AND_RECONCILIATION_EVIDENCE'],
              `INVENTORY_EFFECT_EVIDENCE_UNAVAILABLE:${error._tag}`,
            ),
          onSuccess: (record): readonly PrivacyCoverageContribution[] => [
            incompleteContribution(
              'EFFECT_AND_RECONCILIATION_EVIDENCE',
              lookupRef,
              Option.isSome(record),
              Option.isSome(record) ? [record.value.effectId] : [],
              'COMPLETE_EFFECT_AND_RECONCILIATION_HISTORY_CANNOT_BE_ENUMERATED',
            ),
          ],
        }),
      ),
    ),
    Match.tag('EXTERNAL_CORRELATION', ({ correlationRef, lookupRef }) =>
      dependencies.correlations.findByRef(correlationRef).pipe(
        Effect.match({
          onFailure: (error) =>
            unavailableContributions(
              ['EXTERNAL_SOURCE_ASSERTION_COVERAGE_AND_CORRELATION_HISTORY'],
              `EXTERNAL_CORRELATION_EVIDENCE_UNAVAILABLE:${error._tag}`,
            ),
          onSuccess: (correlation): readonly PrivacyCoverageContribution[] => [
            incompleteContribution(
              'EXTERNAL_SOURCE_ASSERTION_COVERAGE_AND_CORRELATION_HISTORY',
              lookupRef,
              Option.isSome(correlation),
              Option.isSome(correlation) ? [correlation.value.ownerEvidenceRef] : [],
              'COMPLETE_EXTERNAL_CORRELATION_HISTORY_CANNOT_BE_ENUMERATED',
            ),
          ],
        }),
      ),
    ),
    Match.exhaustive,
  );

const privacyCoveragePriority = ['INDETERMINATE', 'UNAVAILABLE', 'PARTIAL', 'COMPLETE'] as const;

const consolidatePrivacyObservation = (
  scopePart: InventoryPrivacyOwnerScopePart,
  contributions: readonly PrivacyCoverageContribution[],
  observedAt: string,
): InventoryPrivacyScopeObservation => {
  if (contributions.length === 0) {
    return {
      coverageStatus: 'INDETERMINATE',
      evidenceRefs: [],
      foundContentRefs: [],
      observedAt,
      scopePart,
      unresolvedReason: 'REQUIRED_INVENTORY_OWNER_SCOPE_HAS_NO_TRUSTED_LOOKUP_SOURCE',
    };
  }
  const coverageStatus =
    privacyCoveragePriority.find((candidate) =>
      contributions.some(({ coverageStatus: contributionStatus }) => contributionStatus === candidate),
    ) ?? 'INDETERMINATE';
  const observation = {
    coverageStatus,
    evidenceRefs: unique(contributions.flatMap(({ evidenceRefs }) => evidenceRefs)),
    foundContentRefs: unique(contributions.flatMap(({ foundContentRefs }) => foundContentRefs)),
    observedAt,
    scopePart,
  };
  if (coverageStatus === 'COMPLETE') {
    return observation;
  }
  return {
    ...observation,
    unresolvedReason: unique(
      contributions.flatMap(({ unresolvedReason }) => (unresolvedReason === undefined ? [] : [unresolvedReason])),
    ).join(';'),
  };
};

const consolidatePrivacyObservations = (
  contributions: readonly PrivacyCoverageContribution[],
  observedAt: string,
): readonly InventoryPrivacyScopeObservation[] =>
  inventoryPrivacyOwnerScopeParts.map((scopePart) =>
    consolidatePrivacyObservation(
      scopePart,
      contributions.filter((contribution) => contribution.scopePart === scopePart),
      observedAt,
    ),
  );

const readPrivacyOwnerCoverage = (
  dependencies: InventoryReconciliationEvidenceDependencies,
  request: PrivacyCoverageRequest,
) =>
  DateTime.now.pipe(
    Effect.map(DateTime.formatIso),
    Effect.flatMap((observedAt) =>
      Effect.forEach(request.trustedLookups, (lookup) => readPrivacyLookup(dependencies, request, lookup), {
        concurrency: 1,
      }).pipe(
        Effect.map((contributions) => contributions.flat()),
        Effect.map((contributions) => consolidatePrivacyObservations(contributions, observedAt)),
        Effect.map((observations) =>
          assessInventoryPrivacyOwnerCoverage({
            assessedAt: observedAt,
            evidenceRefs: unique(observations.flatMap(({ evidenceRefs }) => evidenceRefs)),
            observations,
            scope: request.scope,
          }),
        ),
        Effect.map((coverage) =>
          Option.some({
            _tag: 'PRIVACY_OWNER_COVERAGE' as const,
            coverage,
            ownerRef: request.ownerRef,
          }),
        ),
      ),
    ),
  );

// oxlint-disable-next-line effect-native/no-wide-factory-signature -- Core invokes this owner-local transaction-scoped Read service factory only after the governed scope gate; expires: 2027-03-31.
export const makeInventoryReconciliationEvidenceService = (dependencies: InventoryReconciliationEvidenceDependencies) =>
  Object.freeze({
    read: (
      input: InventoryReconciliationEvidenceQuery,
      scope: InventoryReconciliationEvidenceScope,
    ): EffectType.Effect<
      OptionType.Option<InventoryReconciliationEvidenceResponse>,
      InventoryReconciliationEvidenceError
    > =>
      Match.value(input).pipe(
        Match.tag('BINDING_HISTORY', (request) => readBindingHistory(dependencies, request)),
        Match.tag('ENDED_CORRELATION', (request) =>
          dependencies.correlations.findByRef(request.correlationRef).pipe(
            Effect.mapError(unavailable),
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.succeedNone,
                onSome: (correlation) =>
                  correlation.lifecycle === 'ENDED'
                    ? Effect.succeedSome({
                        _tag: 'ENDED_CORRELATION' as const,
                        correlation,
                        correlationRef: request.correlationRef,
                      })
                    : Effect.fail(rejected('CORRELATION_NOT_ENDED')),
              }),
            ),
          ),
        ),
        Match.tag('SHARING_HISTORY', (request) => readSharingHistory(dependencies, request)),
        Match.tag('CONFIRMATION_HISTORY', (request) => readConfirmationHistory(dependencies, request)),
        Match.tag('PROTECTION_HISTORY', (request) => readProtectionHistory(dependencies, request)),
        Match.tag('EFFECT_OUTCOME', (request) =>
          dependencies.effects.read(request.effectId).pipe(
            Effect.mapError(unavailable),
            Effect.map(
              Option.filter(
                (record) =>
                  record.tenantId === scope.tenantId &&
                  effectLegalEntityId(record) === scope.legalEntityId &&
                  exactResource(effectOwner(record), request.ownerRef),
              ),
            ),
            Effect.map(
              Option.map((record) => ({
                _tag: 'EFFECT_OUTCOME' as const,
                ownerRef: request.ownerRef,
                record,
              })),
            ),
          ),
        ),
        Match.tag('SOURCE_CONFLICT_DETAIL', (request) =>
          dependencies.conflicts.findLatest(request.conflictRef).pipe(
            Effect.mapError(unavailable),
            Effect.map(
              Option.map((conflict) => ({
                _tag: 'SOURCE_CONFLICT_DETAIL' as const,
                conflict,
                conflictRef: request.conflictRef,
              })),
            ),
          ),
        ),
        Match.tag('PRIVACY_OWNER_COVERAGE', (request) => readPrivacyOwnerCoverage(dependencies, request)),
        Match.exhaustive,
      ),
  });
