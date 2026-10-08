import type { OperationalScope } from '@app/core-runtime';
import { and, eq, or, sql } from 'drizzle-orm';
import { DateTime, Effect, Option, Schema } from 'effect';

import {
  TaxSourceAuthorityRoleSchema,
  TaxSourceEligibilitySchema,
  TaxSourceRegistrationMeaningSchema,
} from '../../shared/actions/tax-source-assertion.ts';
import type {
  RecordTaxSourceAssertionPayload,
  TaxSourceAcceptanceOutcome,
  TaxSourceAcceptanceReason,
  TaxSourceAuthorityRole,
  TaxSourceConflictKind,
  TaxSourceEligibility,
} from '../../shared/actions/tax-source-assertion.ts';
import { TaxSourceConflictDetailSchema } from '../../shared/domain/tax-source-read-contracts.ts';
import type { TaxSourceConflictDetail } from '../../shared/domain/tax-source-read-contracts.ts';
import {
  taxFactAuthorityContractRevisions,
  taxFactAuthorityContracts,
  taxSourceAssertions,
  taxSourceConflicts,
} from '../database/schema.ts';
import {
  authoritiesCoveringInstant,
  evaluateTaxSourceAssertionAcceptance,
  taxSourceAuthorityConfigurationConflict,
  taxSourceContradiction,
} from '../domain/selling-legal-entity-vat-registration-resolution.ts';
import type {
  EligibleTaxSourceAssertion,
  TaxSourceAuthorityPeriod,
} from '../domain/selling-legal-entity-vat-registration-resolution.ts';
import { evaluateTaxSourceAuthority, evaluateTaxSourceEligibility } from '../domain/tax-source-acceptance.ts';
import { currentContractRevisions } from './tax-authority-governance.service.ts';
import { taxMeaningFingerprint } from './tax-governance-fingerprint.ts';
import {
  conflict,
  lockTaxFactFamily,
  mutation,
  query,
  sameAttribution,
  trustedInvocation,
  unavailable,
} from './tax-governance-persistence.ts';
import type {
  GovernanceConflict,
  GovernedInvocation,
  PersistenceUnavailable,
  ScopedTransaction,
} from './tax-governance-persistence.ts';

const MODULE_KEY = 'commerce.tax' as const;

export type TaxSourceAssertionRow = typeof taxSourceAssertions.$inferSelect;
export type TaxSourceConflictRow = typeof taxSourceConflicts.$inferSelect;
type ContractRow = typeof taxFactAuthorityContracts.$inferSelect;
type ContractRevisionRow = typeof taxFactAuthorityContractRevisions.$inferSelect;
type Invocation<Payload> = Payload & GovernedInvocation;

export const taxSourceAssertionRef = (tenantId: string, resourceId: string) => ({
  moduleId: MODULE_KEY,
  resourceId,
  resourceType: 'commerce.tax.tax-source-assertion' as const,
  tenantId,
});

export const taxSourceConflictRef = (tenantId: string, resourceId: string) => ({
  moduleId: MODULE_KEY,
  resourceId,
  resourceType: 'commerce.tax.tax-source-conflict' as const,
  tenantId,
});

const optionalIso = (value: DateTime.Utc | undefined): string | null =>
  value === undefined ? null : DateTime.formatIso(value);
const optionalDate = (value: DateTime.Utc | undefined): Date | null =>
  value === undefined ? null : DateTime.toDateUtc(value);
const optionalInstant = (value: Date | null) =>
  Option.map(Option.fromNullOr(value), (date) => DateTime.makeUnsafe(date));

/**
 * Business meaning of one assertion: fact subject, value, declared validity and source times. Transport identity,
 * delivery reference and attribution are not meaning, so a redelivery is a replay (#958 F10, F20).
 * The Source Record Reference is part of it: the same assertion key under another Source Record Reference is an
 * integrity conflict, never a silent replay (#958 F8-F11).
 */
export const taxSourceAssertionFingerprint = (
  legalEntityId: string,
  assertion: Pick<
    RecordTaxSourceAssertionPayload,
    | 'factFamily'
    | 'issuedAt'
    | 'jurisdiction'
    | 'observedAt'
    | 'registrationMeaning'
    | 'sourceRecordRef'
    | 'validFrom'
    | 'validTo'
  >,
): string =>
  taxMeaningFingerprint({
    factFamily: assertion.factFamily,
    issuedAt: optionalIso(assertion.issuedAt),
    jurisdiction: assertion.jurisdiction,
    legalEntityId,
    observedAt: optionalIso(assertion.observedAt),
    registrationMeaning: assertion.registrationMeaning,
    sourceRecordRef: assertion.sourceRecordRef,
    validFrom: optionalIso(assertion.validFrom),
    validTo: optionalIso(assertion.validTo),
  });

/** Current authority contract revision as a pure authority period. */
export const toTaxSourceAuthorityPeriod = (revision: ContractRevisionRow): TaxSourceAuthorityPeriod => ({
  authorityFrom: DateTime.makeUnsafe(revision.authorityFrom),
  authorityTo: optionalInstant(revision.authorityTo),
  contractId: revision.taxFactAuthorityContractId,
  contractRevisionId: revision.taxFactAuthorityContractRevisionId,
  evidenceSourceRefs: revision.evidenceSourceRefs,
  systemOfRecordRef: revision.systemOfRecordRef,
});

const StoredAssertionSchema = Schema.Struct({
  authorityRole: TaxSourceAuthorityRoleSchema,
  eligibility: TaxSourceEligibilitySchema,
  registrationMeaning: TaxSourceRegistrationMeaningSchema,
});

/** Stored vocabulary echoed from a row; a value outside it is never guessed. */
export const decodeStoredTaxSourceAssertion = (row: TaxSourceAssertionRow) =>
  Schema.decodeUnknownEffect(StoredAssertionSchema)({
    authorityRole: row.authorityRole,
    eligibility: row.eligibility,
    registrationMeaning: row.registrationMeaning,
  }).pipe(Effect.mapError(unavailable));

/**
 * An assertion whose stored eligibility is ELIGIBLE, as resolution input. The stored authority role is recording-time
 * provenance only and is deliberately not carried: resolution derives the role at each evaluated instant
 * (#959 F8, F25). Arrival time is deliberately dropped (#958 F19).
 */
export const eligibleTaxSourceAssertion = Effect.fn('taxSourceAssertion.eligible')(function* eligibleEffect(
  row: TaxSourceAssertionRow,
) {
  const stored = yield* decodeStoredTaxSourceAssertion(row);
  if (stored.eligibility !== 'ELIGIBLE') {
    return Option.none<EligibleTaxSourceAssertion>();
  }
  return Option.some<EligibleTaxSourceAssertion>({
    assertionId: row.taxSourceAssertionId,
    registrationMeaning: stored.registrationMeaning,
    sourceRef: row.sourceRef,
    validFrom: optionalInstant(row.validFrom),
    validTo: optionalInstant(row.validTo),
  });
});

/**
 * #957 acceptance of one stored assertion, evaluated over its claimed validity under the given current contract
 * revisions. It is never stored: a changed authoritative state is a new evaluation (#959 F25).
 */
export const evaluateStoredTaxSourceAcceptance = Effect.fn('taxSourceAssertion.evaluateAcceptance')(
  function* evaluateStoredTaxSourceAcceptanceEffect(
    row: TaxSourceAssertionRow,
    authorities: readonly TaxSourceAuthorityPeriod[],
  ) {
    const stored = yield* decodeStoredTaxSourceAssertion(row);
    return {
      ...stored,
      acceptance: evaluateTaxSourceAssertionAcceptance({
        assertion: {
          eligibility: stored.eligibility,
          registrationMeaning: stored.registrationMeaning,
          sourceRef: row.sourceRef,
          validFrom: optionalInstant(row.validFrom),
          validTo: optionalInstant(row.validTo),
        },
        authorities,
      }),
    };
  },
);

export const decodeTaxSourceConflictDetail = (row: TaxSourceConflictRow) =>
  Schema.decodeEffect(TaxSourceConflictDetailSchema)(row.detail).pipe(Effect.mapError(unavailable));

export interface TaxSourceSnapshot {
  readonly assertions: readonly TaxSourceAssertionRow[];
  readonly contracts: readonly ContractRow[];
  /** Current revision per contract; competitors are never ranked. */
  readonly currentRevisions: readonly ContractRevisionRow[];
}

/**
 * Authority contracts with their revisions and every source assertion of one seller and fact family in ONE
 * statement, hence one snapshot even under READ COMMITTED. The full join on `false` keeps the two sets disjoint
 * rows instead of a cross product. The complete owner set is always consumed; absence of rows is never
 * authoritative absence (#959 F13-F18).
 */
export const loadTaxSourceSnapshot = Effect.fn('taxSourceAssertion.loadSnapshot')(function* loadSnapshotEffect(
  transaction: ScopedTransaction,
  scope: Readonly<{ factFamily: string; legalEntityId: string; tenantId: string }>,
) {
  const rows = yield* query(
    transaction
      .select({
        assertion: taxSourceAssertions,
        contract: taxFactAuthorityContracts,
        revision: taxFactAuthorityContractRevisions,
      })
      .from(taxFactAuthorityContractRevisions)
      .innerJoin(
        taxFactAuthorityContracts,
        and(
          eq(taxFactAuthorityContracts.tenantId, taxFactAuthorityContractRevisions.tenantId),
          eq(taxFactAuthorityContracts.legalEntityId, taxFactAuthorityContractRevisions.legalEntityId),
          eq(
            taxFactAuthorityContracts.taxFactAuthorityContractId,
            taxFactAuthorityContractRevisions.taxFactAuthorityContractId,
          ),
        ),
      )
      .fullJoin(taxSourceAssertions, sql`false`)
      .where(
        or(
          and(
            eq(taxFactAuthorityContractRevisions.tenantId, scope.tenantId),
            eq(taxFactAuthorityContractRevisions.legalEntityId, scope.legalEntityId),
            eq(taxFactAuthorityContracts.factFamily, scope.factFamily),
          ),
          and(
            eq(taxSourceAssertions.tenantId, scope.tenantId),
            eq(taxSourceAssertions.legalEntityId, scope.legalEntityId),
            eq(taxSourceAssertions.factFamily, scope.factFamily),
          ),
        ),
      ),
  );
  const contracts = new Map<string, ContractRow>();
  const revisions: ContractRevisionRow[] = [];
  const assertions: TaxSourceAssertionRow[] = [];
  for (const row of rows) {
    if (row.contract !== null) {
      contracts.set(row.contract.taxFactAuthorityContractId, row.contract);
    }
    if (row.revision !== null) {
      revisions.push(row.revision);
    }
    if (row.assertion !== null) {
      assertions.push(row.assertion);
    }
  }
  return {
    assertions,
    contracts: [...contracts.values()],
    currentRevisions: [...currentContractRevisions(revisions).values()],
  } satisfies TaxSourceSnapshot;
});

export type RecordTaxSourceAssertionOutcome =
  | GovernanceConflict
  | Readonly<{
      acceptanceOutcome: TaxSourceAcceptanceOutcome;
      acceptanceReason: TaxSourceAcceptanceReason;
      assertionId: string;
      authorityRole: TaxSourceAuthorityRole;
      conflictId?: string;
      created: boolean;
      /** Absent with ASSERTION_IDENTITY_CONFLICT, which records no assertion. */
      eligibility?: TaxSourceEligibility;
      meaningFingerprint: string;
    }>;

const replayed = (outcome: RecordTaxSourceAssertionOutcome) => Option.some(outcome);

export interface TaxSourceAssertionPersistence {
  readonly recordAssertion: (
    input: Invocation<RecordTaxSourceAssertionPayload>,
  ) => Effect.Effect<RecordTaxSourceAssertionOutcome, PersistenceUnavailable>;
}

const conflictKindOrder = {
  ASSERTION_INTEGRITY: 0,
  AUTHORITY_CONFIGURATION: 1,
  EVIDENCE_DISAGREEMENT: 3,
  INCOMPATIBLE_AUTHORITATIVE_ASSERTIONS: 2,
} as const satisfies Readonly<Record<TaxSourceConflictKind, number>>;
const conflictKindRank: ReadonlyMap<string, number> = new Map(Object.entries(conflictKindOrder));

/** Stable order of the conflicts one invocation records: by kind, then by counterpart identity. */
const byConflictOrder = (
  left: Readonly<{ conflictKind: string; relatedAssertionId: string | null }>,
  right: Readonly<{ conflictKind: string; relatedAssertionId: string | null }>,
) =>
  (conflictKindRank.get(left.conflictKind) ?? conflictKindRank.size) -
    (conflictKindRank.get(right.conflictKind) ?? conflictKindRank.size) ||
  (left.relatedAssertionId ?? '').localeCompare(right.relatedAssertionId ?? '', 'en');

interface Detection {
  readonly detail: TaxSourceConflictDetail;
  readonly kind: TaxSourceConflictKind;
  readonly relatedAssertionId: string | null;
  readonly subjectAssertionId: string | null;
}

/** First conflict of an invocation in a stable order, so a replay names the same conflict. */
const firstConflictId = (
  rows: readonly Pick<TaxSourceConflictRow, 'conflictKind' | 'relatedAssertionId' | 'taxSourceConflictId'>[],
) => rows.toSorted(byConflictOrder).at(0)?.taxSourceConflictId;

/**
 * Pairwise contradictions of a newly ELIGIBLE assertion against the eligible set of the same snapshot, judged with
 * each source's role under the contract revision covering each contradicting instant (#959 F1-F2, F10-F11, F25,
 * F27): same System of Record → incompatible authoritative assertions (#925 F25); System of Record against listed
 * evidence → explicit disagreement that never creates a second authority. A source outside its authority window,
 * two evidence-only claims, and instants under an authority gap or configuration conflict are not a TAX conflict.
 */
const detectContradictions = (
  recorded: EligibleTaxSourceAssertion,
  eligible: readonly EligibleTaxSourceAssertion[],
  authorities: readonly TaxSourceAuthorityPeriod[],
): readonly Detection[] =>
  eligible.flatMap((other) =>
    Option.match(taxSourceContradiction(recorded, other, authorities), {
      onNone: (): Detection[] => [],
      onSome: (kind): Detection[] => [
        { detail: {}, kind, relatedAssertionId: other.assertionId, subjectAssertionId: recorded.assertionId },
      ],
    }),
  );

/** Same immutable assertion identity with a different meaning: an integrity conflict, never a correction (#958 F11). */
const identityConflict = (assertionId: string, conflictId: string, created: boolean, meaningFingerprint: string) =>
  ({
    acceptanceOutcome: 'REJECTED',
    acceptanceReason: 'ASSERTION_IDENTITY_CONFLICT',
    assertionId,
    authorityRole: 'NONE',
    conflictId,
    created,
    meaningFingerprint,
  }) as const;

export const taxSourceAssertionPersistenceForScope = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
): TaxSourceAssertionPersistence => {
  const assertionByInvocation = (input: GovernedInvocation) =>
    query(
      transaction
        .select()
        .from(taxSourceAssertions)
        .where(
          and(
            eq(taxSourceAssertions.tenantId, input.tenantId),
            eq(taxSourceAssertions.idempotencyKey, input.actionInvocationId),
          ),
        )
        .limit(1),
    );
  /** Conflicts recorded by one invocation, identified by its stored idempotency key. */
  const conflictsByIdempotencyKey = (tenantId: string, idempotencyKey: string) =>
    query(
      transaction
        .select()
        .from(taxSourceConflicts)
        .where(and(eq(taxSourceConflicts.tenantId, tenantId), eq(taxSourceConflicts.idempotencyKey, idempotencyKey))),
    );

  /**
   * Stored eligibility and recording-time role echoed from the row; the #957 acceptance evaluated afresh under the
   * current contract revisions, so a replay after an authority change reports the new evaluation (#959 F25).
   */
  const outcomeOf = Effect.fn('taxSourceAssertion.outcomeOf')(function* outcomeOfEffect(
    row: TaxSourceAssertionRow,
    authorities: readonly TaxSourceAuthorityPeriod[],
    created: boolean,
    conflictId?: string,
  ) {
    const evaluated = yield* evaluateStoredTaxSourceAcceptance(row, authorities);
    const outcome = {
      acceptanceOutcome: evaluated.acceptance.outcome,
      acceptanceReason: evaluated.acceptance.reason,
      assertionId: row.taxSourceAssertionId,
      authorityRole: evaluated.authorityRole,
      created,
      eligibility: evaluated.eligibility,
      meaningFingerprint: row.semanticFingerprint,
    } as const;
    return conflictId === undefined ? outcome : { ...outcome, conflictId };
  });

  const insertConflicts = (input: Invocation<RecordTaxSourceAssertionPayload>, detections: readonly Detection[]) =>
    mutation(
      transaction
        .insert(taxSourceConflicts)
        .values(
          detections.map((detection) => ({
            actionInvocationId: input.actionInvocationId,
            actorPrincipalId: input.actorPrincipalId,
            conflictKind: detection.kind,
            detail: detection.detail,
            detectedAt: input.operationTime,
            factFamily: input.factFamily,
            idempotencyKey: input.actionInvocationId,
            legalEntityId: input.legalEntityId,
            provenanceRef: input.provenanceRef,
            reason: input.reason,
            relatedAssertionId: detection.relatedAssertionId,
            status: 'OPEN',
            subjectAssertionId: detection.subjectAssertionId,
            tenantId: input.tenantId,
          })),
        )
        .returning({
          conflictKind: taxSourceConflicts.conflictKind,
          relatedAssertionId: taxSourceConflicts.relatedAssertionId,
          taxSourceConflictId: taxSourceConflicts.taxSourceConflictId,
        }),
    );

  /** Core-invocation replay: the identical attribution and meaning returns the original outcome (#955 G). */
  const coreReplay = Effect.fn('taxSourceAssertion.coreReplay')(function* coreReplayEffect(
    input: Invocation<RecordTaxSourceAssertionPayload>,
    meaningFingerprint: string,
  ) {
    const [assertion] = yield* assertionByInvocation(input);
    const invocationConflicts = yield* conflictsByIdempotencyKey(input.tenantId, input.actionInvocationId);
    if (assertion !== undefined) {
      const matches =
        sameAttribution(assertion, input) &&
        assertion.sourceRef === input.sourceRef &&
        assertion.sourceAssertionKey === input.sourceAssertionKey &&
        assertion.semanticFingerprint === meaningFingerprint;
      if (!matches) {
        return replayed(conflict('IDEMPOTENCY_REUSED'));
      }
      const { currentRevisions } = yield* loadTaxSourceSnapshot(transaction, input);
      return replayed(
        yield* outcomeOf(
          assertion,
          currentRevisions.map(toTaxSourceAuthorityPeriod),
          false,
          firstConflictId(invocationConflicts),
        ),
      );
    }
    const integrity = invocationConflicts.find((row) => row.conflictKind === 'ASSERTION_INTEGRITY');
    if (integrity === undefined) {
      return invocationConflicts.length === 0
        ? Option.none<RecordTaxSourceAssertionOutcome>()
        : replayed(conflict('IDEMPOTENCY_REUSED'));
    }
    const detail = yield* decodeTaxSourceConflictDetail(integrity);
    const matches =
      sameAttribution(integrity, input) &&
      integrity.subjectAssertionId !== null &&
      detail.sourceRef === input.sourceRef &&
      detail.sourceAssertionKey === input.sourceAssertionKey &&
      detail.deliveredFingerprint === meaningFingerprint;
    return integrity.subjectAssertionId !== null && matches
      ? replayed(
          identityConflict(integrity.subjectAssertionId, integrity.taxSourceConflictId, false, meaningFingerprint),
        )
      : replayed(conflict('IDEMPOTENCY_REUSED'));
  });

  const recordIdentityConflict = Effect.fn('taxSourceAssertion.recordIdentityConflict')(
    function* recordIdentityConflictEffect(
      input: Invocation<RecordTaxSourceAssertionPayload>,
      existing: TaxSourceAssertionRow,
      meaningFingerprint: string,
    ) {
      // A redelivery of the same conflicting meaning names the conflict already recorded (#959 F4-F5).
      const [known] = yield* query(
        transaction
          .select({ conflictId: taxSourceConflicts.taxSourceConflictId })
          .from(taxSourceConflicts)
          .where(
            and(
              eq(taxSourceConflicts.tenantId, input.tenantId),
              eq(taxSourceConflicts.legalEntityId, input.legalEntityId),
              eq(taxSourceConflicts.conflictKind, 'ASSERTION_INTEGRITY'),
              eq(taxSourceConflicts.subjectAssertionId, existing.taxSourceAssertionId),
              sql`${taxSourceConflicts.detail}->>'deliveredFingerprint' = ${meaningFingerprint}`,
            ),
          )
          .limit(1),
      );
      if (known !== undefined) {
        return identityConflict(existing.taxSourceAssertionId, known.conflictId, false, meaningFingerprint);
      }
      const inserted = yield* insertConflicts(input, [
        {
          detail: {
            deliveredFingerprint: meaningFingerprint,
            sourceAssertionKey: existing.sourceAssertionKey,
            sourceRef: existing.sourceRef,
            storedFingerprint: existing.semanticFingerprint,
          },
          kind: 'ASSERTION_INTEGRITY',
          relatedAssertionId: null,
          subjectAssertionId: existing.taxSourceAssertionId,
        },
      ]);
      if ('kind' in inserted) {
        return inserted;
      }
      const [row] = inserted;
      return row === undefined
        ? yield* unavailable()
        : identityConflict(existing.taxSourceAssertionId, row.taxSourceConflictId, true, meaningFingerprint);
    },
  );

  const recordAssertion: TaxSourceAssertionPersistence['recordAssertion'] = Effect.fn(
    'taxSourceAssertionPersistence.recordAssertion',
  )(function* recordAssertionEffect(input) {
    if (!trustedInvocation(scope, input, [])) {
      return yield* unavailable();
    }
    const meaningFingerprint = taxSourceAssertionFingerprint(input.legalEntityId, input);
    const replay = yield* coreReplay(input, meaningFingerprint);
    if (Option.isSome(replay)) {
      return replay.value;
    }
    yield* lockTaxFactFamily(transaction, input, input.factFamily);
    const snapshot = yield* loadTaxSourceSnapshot(transaction, input);
    const authorities = snapshot.currentRevisions.map(toTaxSourceAuthorityPeriod);
    const existing = snapshot.assertions.find(
      (assertion) =>
        assertion.sourceRef === input.sourceRef && assertion.sourceAssertionKey === input.sourceAssertionKey,
    );
    if (existing !== undefined) {
      if (existing.semanticFingerprint !== meaningFingerprint) {
        return yield* recordIdentityConflict(input, existing, meaningFingerprint);
      }
      // Same immutable identity and meaning is a replay; it never creates a second fact transition and echoes the
      // original outcome, including the first conflict its recording invocation detected (#958 F10, F20, #959 F4).
      const recordedConflicts = yield* conflictsByIdempotencyKey(existing.tenantId, existing.idempotencyKey);
      return yield* outcomeOf(existing, authorities, false, firstConflictId(recordedConflicts));
    }
    const covering = authoritiesCoveringInstant(authorities, DateTime.makeUnsafe(input.operationTime));
    // Stored eligibility holds at every instant; the role at recording time is provenance only (#959 F8, F25).
    const eligibility = evaluateTaxSourceEligibility({
      registrationMeaning: input.registrationMeaning,
      validFrom: Option.fromUndefinedOr(input.validFrom),
      validTo: Option.fromUndefinedOr(input.validTo),
    });
    const recordingAuthority = evaluateTaxSourceAuthority({
      authoritiesAtInstant: covering,
      sourceRef: input.sourceRef,
    });
    const inserted = yield* mutation(
      transaction
        .insert(taxSourceAssertions)
        .values({
          actionInvocationId: input.actionInvocationId,
          actorPrincipalId: input.actorPrincipalId,
          authorityContractRevisionId: Option.getOrNull(recordingAuthority.contractRevisionId),
          authorityRole: recordingAuthority.role,
          deliveryRef: input.deliveryRef ?? null,
          eligibility,
          factFamily: input.factFamily,
          idempotencyKey: input.actionInvocationId,
          issuedAt: optionalDate(input.issuedAt),
          jurisdiction: input.jurisdiction,
          legalEntityId: input.legalEntityId,
          observedAt: optionalDate(input.observedAt),
          provenanceRef: input.provenanceRef,
          reason: input.reason,
          registrationMeaning: input.registrationMeaning,
          semanticFingerprint: meaningFingerprint,
          sourceAssertionKey: input.sourceAssertionKey,
          sourceRecordRef: input.sourceRecordRef,
          sourceRef: input.sourceRef,
          tenantId: input.tenantId,
          validFrom: optionalDate(input.validFrom),
          validTo: optionalDate(input.validTo),
        })
        .returning(),
    );
    if ('kind' in inserted) {
      return inserted;
    }
    const [recordedRow] = inserted;
    if (recordedRow === undefined) {
      return yield* unavailable();
    }
    const detections: Detection[] = [];
    // Competing Systems of Record are a configuration defect; no technical winner is chosen (#959 F2-F3, F28). It is
    // detected over the claimed coverage segments the acceptance is evaluated on, never at operation time, so the
    // recorded conflict and the evaluated acceptance reason always agree.
    const competingRevisionIds = taxSourceAuthorityConfigurationConflict({
      assertion: {
        eligibility,
        registrationMeaning: input.registrationMeaning,
        sourceRef: input.sourceRef,
        validFrom: optionalInstant(recordedRow.validFrom),
        validTo: optionalInstant(recordedRow.validTo),
      },
      authorities,
    });
    if (competingRevisionIds.length > 0) {
      detections.push({
        detail: { assertionId: recordedRow.taxSourceAssertionId, contractRevisionIds: [...competingRevisionIds] },
        kind: 'AUTHORITY_CONFIGURATION',
        relatedAssertionId: null,
        subjectAssertionId: null,
      });
    }
    const recorded = yield* eligibleTaxSourceAssertion(recordedRow);
    if (Option.isSome(recorded)) {
      const eligible = yield* Effect.forEach(snapshot.assertions, eligibleTaxSourceAssertion, { concurrency: 1 });
      detections.push(...detectContradictions(recorded.value, eligible.flatMap(Option.toArray), authorities));
    }
    if (detections.length === 0) {
      return yield* outcomeOf(recordedRow, authorities, true);
    }
    const conflicts = yield* insertConflicts(
      input,
      detections.toSorted((left, right) =>
        byConflictOrder(
          { conflictKind: left.kind, relatedAssertionId: left.relatedAssertionId },
          { conflictKind: right.kind, relatedAssertionId: right.relatedAssertionId },
        ),
      ),
    );
    if ('kind' in conflicts) {
      return conflicts;
    }
    return yield* outcomeOf(recordedRow, authorities, true, firstConflictId(conflicts));
  });

  return Object.freeze({ recordAssertion });
};

export const taxSourceAssertionServiceFactory = (transaction: ScopedTransaction, scope: OperationalScope) =>
  Effect.succeed(taxSourceAssertionPersistenceForScope(transaction, scope));
