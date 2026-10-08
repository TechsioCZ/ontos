import type { OperationalScope } from '@app/core-runtime';
import { and, eq } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { DateTime, Effect, Option, Schema } from 'effect';

import { TaxSourceConflictKindSchema } from '../../shared/actions/tax-source-assertion.ts';
import type {
  SellingLegalEntityVatRegistrationStateRequest,
  SellingLegalEntityVatRegistrationStateResponse,
} from '../../shared/apis/selling-legal-entity-vat-registration-state.ts';
import type {
  TaxSourceAssertionHistoryRequest,
  TaxSourceAssertionHistoryResponse,
} from '../../shared/apis/tax-source-assertion-history.ts';
import type {
  TaxSourceConflictDetailRequest,
  TaxSourceConflictDetailResponse,
} from '../../shared/apis/tax-source-conflict-detail.ts';
import { taxSourceAssertions, taxSourceConflicts } from '../database/schema.ts';
import { resolveSellingLegalEntityVatRegistration } from '../domain/selling-legal-entity-vat-registration-resolution.ts';
import {
  taxFactAuthorityContractBasisFingerprint,
  taxFactAuthorityContractRef,
} from './tax-authority-governance.service.ts';
import { taxMeaningFingerprint } from './tax-governance-fingerprint.ts';
import { isOwnerId, query, unavailable } from './tax-governance-persistence.ts';
import type { PersistenceUnavailable, ScopedTransaction } from './tax-governance-persistence.ts';
import {
  decodeStoredTaxSourceAssertion,
  decodeTaxSourceConflictDetail,
  eligibleTaxSourceAssertion,
  evaluateStoredTaxSourceAcceptance,
  loadTaxSourceSnapshot,
  taxSourceAssertionRef,
  taxSourceConflictRef,
  toTaxSourceAuthorityPeriod,
} from './tax-source-assertion.service.ts';
import type { TaxSourceAssertionRow } from './tax-source-assertion.service.ts';

const FACT_FAMILY = 'SELLING_LEGAL_ENTITY_VAT_REGISTRATION' as const;
const subjectAssertions = alias(taxSourceAssertions, 'subject_assertion');
const relatedAssertions = alias(taxSourceAssertions, 'related_assertion');
const byText = (left: string, right: string) => left.localeCompare(right, 'en');
const instant = (value: Date) => DateTime.makeUnsafe(value);
const optionalInstant = (value: Date | null) => Option.map(Option.fromNullOr(value), instant);

/** Owner-local reads of Selling Legal Entity VAT Registration source evidence, bound to one scoped transaction. */
export interface TaxSourceReads {
  readonly sellingLegalEntityVatRegistrationState: (
    request: SellingLegalEntityVatRegistrationStateRequest,
  ) => Effect.Effect<SellingLegalEntityVatRegistrationStateResponse, PersistenceUnavailable>;
  readonly taxSourceAssertionHistory: (
    request: TaxSourceAssertionHistoryRequest,
  ) => Effect.Effect<TaxSourceAssertionHistoryResponse, PersistenceUnavailable>;
  /** None when the conflict is not visible in the trusted Tenant and Selling Legal Entity scope. */
  readonly taxSourceConflictDetail: (
    request: TaxSourceConflictDetailRequest,
  ) => Effect.Effect<Option.Option<TaxSourceConflictDetailResponse>, PersistenceUnavailable>;
}

/** Fingerprint over the identity, meaning and eligibility of every assertion plus the current authority set. */
const setFingerprint = (
  legalEntityId: string,
  assertions: readonly TaxSourceAssertionRow[],
  contracts: readonly string[],
) =>
  taxMeaningFingerprint({
    assertions: assertions
      .map((row) => [row.taxSourceAssertionId, row.semanticFingerprint, row.eligibility].join(':'))
      .toSorted(byText),
    contracts: contracts.toSorted(byText),
    factFamily: FACT_FAMILY,
    legalEntityId,
  });

export const taxSourceReadsForScope = (transaction: ScopedTransaction, scope: OperationalScope): TaxSourceReads => {
  const { tenantId } = scope;
  const legalEntityId = scope.legalEntityId ?? '';

  const evidenceOf = Effect.fn('taxSourceReads.evidenceOf')(function* evidenceOfEffect(row: TaxSourceAssertionRow) {
    const stored = yield* decodeStoredTaxSourceAssertion(row);
    return {
      ...stored,
      assertionRef: taxSourceAssertionRef(tenantId, row.taxSourceAssertionId),
      authorityContractRevisionId: Option.fromNullOr(row.authorityContractRevisionId),
      deliveryRef: Option.fromNullOr(row.deliveryRef),
      factFamily: FACT_FAMILY,
      issuedAt: optionalInstant(row.issuedAt),
      jurisdiction: 'CZ_DOMESTIC' as const,
      observedAt: optionalInstant(row.observedAt),
      provenanceRef: row.provenanceRef,
      reason: row.reason,
      recordedAt: instant(row.recordedAt),
      semanticFingerprint: row.semanticFingerprint,
      sourceAssertionKey: row.sourceAssertionKey,
      sourceRecordRef: row.sourceRecordRef,
      sourceRef: row.sourceRef,
      validFrom: optionalInstant(row.validFrom),
      validTo: optionalInstant(row.validTo),
    };
  });

  const sellingLegalEntityVatRegistrationState: TaxSourceReads['sellingLegalEntityVatRegistrationState'] = Effect.fn(
    'taxSourceReads.sellingLegalEntityVatRegistrationState',
  )(function* sellingLegalEntityVatRegistrationStateEffect(request) {
    if (scope.legalEntityId === undefined) {
      return yield* unavailable();
    }
    const snapshot = yield* loadTaxSourceSnapshot(transaction, { factFamily: FACT_FAMILY, legalEntityId, tenantId });
    const eligible = (yield* Effect.forEach(snapshot.assertions, eligibleTaxSourceAssertion, {
      concurrency: 1,
    })).flatMap(Option.toArray);
    const resolution = resolveSellingLegalEntityVatRegistration({
      completeState: {
        authorities: snapshot.currentRevisions.map(toTaxSourceAuthorityPeriod),
        eligibleAssertions: eligible,
      },
      evaluationTime: request.evaluationTime,
    });
    const eligibleIds = new Set(eligible.map(({ assertionId }) => assertionId));
    const eligibleRows = snapshot.assertions.filter((row) => eligibleIds.has(row.taxSourceAssertionId));
    const { systemOfRecord } = resolution.authority;
    return {
      authority: {
        contractRef: systemOfRecord.pipe(
          Option.map((authority) => taxFactAuthorityContractRef(tenantId, authority.contractId)),
        ),
        outcome: resolution.authority.outcome,
        systemOfRecordRef: systemOfRecord.pipe(Option.map((authority) => authority.systemOfRecordRef)),
      },
      basisAssertionRefs: resolution.basisAssertionIds.map((id) => taxSourceAssertionRef(tenantId, id)),
      completeness: {
        rowCount: eligibleRows.length,
        setFingerprint: setFingerprint(
          legalEntityId,
          eligibleRows,
          snapshot.currentRevisions.map(taxFactAuthorityContractBasisFingerprint),
        ),
      },
      evaluationTime: request.evaluationTime,
      evidenceDisagreementRefs: resolution.evidenceDisagreementIds.map((id) => taxSourceAssertionRef(tenantId, id)),
      factFamily: FACT_FAMILY,
      reason: resolution.reason,
      state: resolution.state,
    };
  });

  const taxSourceAssertionHistory: TaxSourceReads['taxSourceAssertionHistory'] = Effect.fn(
    'taxSourceReads.taxSourceAssertionHistory',
  )(function* taxSourceAssertionHistoryEffect(request) {
    if (scope.legalEntityId === undefined) {
      return yield* unavailable();
    }
    const snapshot = yield* loadTaxSourceSnapshot(transaction, {
      factFamily: request.factFamily,
      legalEntityId,
      tenantId,
    });
    // Ordered by identity, never by received time: arrival order carries no business meaning (#958 F19).
    const ordered = snapshot.assertions.toSorted((left, right) =>
      byText(left.taxSourceAssertionId, right.taxSourceAssertionId),
    );
    const authorities = snapshot.currentRevisions.map(toTaxSourceAuthorityPeriod);
    // Acceptance is evaluated at read time under the current revisions of the same snapshot (#957 H, #959 F25).
    const entryOf = Effect.fn('taxSourceReads.historyEntryOf')(function* historyEntryOfEffect(
      row: TaxSourceAssertionRow,
    ) {
      const { acceptance } = yield* evaluateStoredTaxSourceAcceptance(row, authorities);
      return {
        ...(yield* evidenceOf(row)),
        acceptanceOutcome: acceptance.outcome,
        acceptanceReason: acceptance.reason,
      };
    });
    return {
      assertions: yield* Effect.forEach(ordered, entryOf, { concurrency: 1 }),
      completeness: {
        rowCount: ordered.length,
        setFingerprint: setFingerprint(
          legalEntityId,
          ordered,
          snapshot.currentRevisions.map(taxFactAuthorityContractBasisFingerprint),
        ),
      },
      factFamily: request.factFamily,
    };
  });

  const taxSourceConflictDetail: TaxSourceReads['taxSourceConflictDetail'] = Effect.fn(
    'taxSourceReads.taxSourceConflictDetail',
  )(function* taxSourceConflictDetailEffect(request) {
    const conflictId = request.conflictRef.resourceId;
    if (scope.legalEntityId === undefined || request.conflictRef.tenantId !== tenantId || !isOwnerId(conflictId)) {
      return Option.none();
    }
    // The conflict and the assertions it names in one statement, hence one snapshot.
    const [row] = yield* query(
      transaction
        .select({ conflict: taxSourceConflicts, related: relatedAssertions, subject: subjectAssertions })
        .from(taxSourceConflicts)
        .leftJoin(
          subjectAssertions,
          and(
            eq(subjectAssertions.tenantId, taxSourceConflicts.tenantId),
            eq(subjectAssertions.legalEntityId, taxSourceConflicts.legalEntityId),
            eq(subjectAssertions.taxSourceAssertionId, taxSourceConflicts.subjectAssertionId),
          ),
        )
        .leftJoin(
          relatedAssertions,
          and(
            eq(relatedAssertions.tenantId, taxSourceConflicts.tenantId),
            eq(relatedAssertions.legalEntityId, taxSourceConflicts.legalEntityId),
            eq(relatedAssertions.taxSourceAssertionId, taxSourceConflicts.relatedAssertionId),
          ),
        )
        .where(
          and(
            eq(taxSourceConflicts.tenantId, tenantId),
            eq(taxSourceConflicts.legalEntityId, legalEntityId),
            eq(taxSourceConflicts.taxSourceConflictId, conflictId),
          ),
        )
        .limit(1),
    );
    if (row === undefined) {
      return Option.none();
    }
    const conflictRow = row.conflict;
    const evidenceFor = (assertion: TaxSourceAssertionRow | null) =>
      assertion === null ? Effect.succeedNone : evidenceOf(assertion).pipe(Effect.asSome);
    const conflictKind = yield* Schema.decodeUnknownEffect(TaxSourceConflictKindSchema)(conflictRow.conflictKind).pipe(
      Effect.mapError(unavailable),
    );
    return Option.some({
      conflictKind,
      conflictRef: taxSourceConflictRef(tenantId, conflictRow.taxSourceConflictId),
      detail: yield* decodeTaxSourceConflictDetail(conflictRow),
      detectedAt: instant(conflictRow.detectedAt),
      factFamily: FACT_FAMILY,
      provenanceRef: conflictRow.provenanceRef,
      reason: conflictRow.reason,
      relatedAssertion: yield* evidenceFor(row.related),
      status: 'OPEN' as const,
      subjectAssertion: yield* evidenceFor(row.subject),
    });
  });

  return Object.freeze({ sellingLegalEntityVatRegistrationState, taxSourceAssertionHistory, taxSourceConflictDetail });
};
