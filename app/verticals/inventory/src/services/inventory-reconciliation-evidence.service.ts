/* oxlint-disable effect-native/no-dependency-parameters -- Core supplies only transaction-scoped owner ports after the governed Read gate; expires: 2027-03-31. */
import type { Effect as EffectType, Option as OptionType } from 'effect';
import { Effect, Match, Option, Schema } from 'effect';

import { INVENTORY_RECONCILIATION_EVIDENCE_LIMIT } from '../../shared/apis/inventory-reconciliation-evidence.ts';
import type {
  InventoryReconciliationEvidenceQuery,
  InventoryReconciliationEvidenceResponse,
} from '../../shared/apis/inventory-reconciliation-evidence.ts';
import type { CatalogToStockBindingPersistence } from '../../shared/domain/catalog-to-stock-binding.ts';
import type { CommitmentProtectionPersistence } from '../../shared/domain/commitment-protection.ts';
import type { ExternalStockCorrelationPersistence } from '../../shared/domain/external-stock-correlation.ts';
import type { InventoryEffectLedgerRecord } from '../../shared/domain/inventory-effect-ledger.ts';
import { InventoryReconciliationEvidenceRejected } from '../../shared/domain/inventory-reconciliation-evidence-rejected.ts';
import { InventoryReconciliationEvidenceUnavailable } from '../../shared/domain/inventory-reconciliation-evidence-unavailable.ts';
import type { ReservationConfirmationPersistence } from '../../shared/domain/reservation-confirmation.ts';
import type { StockSharingEligibilityPersistence } from '../../shared/domain/stock-sharing-eligibility.ts';
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
        Match.exhaustive,
      ),
  });
