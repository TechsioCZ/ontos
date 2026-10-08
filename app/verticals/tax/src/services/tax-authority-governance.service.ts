import type { OperationalScope } from '@app/core-runtime';
import { and, eq, inArray } from 'drizzle-orm';
import { DateTime, Effect } from 'effect';

import type {
  EndTaxFactAuthorityContractPayload,
  EstablishTaxFactAuthorityContractPayload,
  ReviseTaxFactAuthorityContractPayload,
  TaxFactAuthorityContent,
} from '../../shared/actions/tax-governance.ts';
import { taxFactAuthorityContractRevisions, taxFactAuthorityContracts } from '../database/schema.ts';
import { taxMeaningFingerprint } from './tax-governance-fingerprint.ts';
import {
  conflict,
  isOwnerId,
  lockTaxFactFamily,
  mutation,
  notBackdated,
  notFound,
  query,
  sameAttribution,
  sameInstant,
  staleBasis,
  trustedInvocation,
  unavailable,
} from './tax-governance-persistence.ts';
import type {
  GovernanceConflict,
  GovernanceNotFound,
  GovernanceStale,
  GovernedInvocation,
  PersistenceUnavailable,
  ScopedTransaction,
} from './tax-governance-persistence.ts';

const MODULE_KEY = 'commerce.tax' as const;
const CONTRACT_TYPE = 'commerce.tax.tax-fact-authority-contract' as const;

type ContractRow = typeof taxFactAuthorityContracts.$inferSelect;
type ContractRevisionRow = typeof taxFactAuthorityContractRevisions.$inferSelect;
type FactFamily = ContractRow['factFamily'];
type Invocation<Payload> = Payload & GovernedInvocation;

export const taxFactAuthorityContractRef = (tenantId: string, resourceId: string) => ({
  moduleId: MODULE_KEY,
  resourceId,
  resourceType: CONTRACT_TYPE,
  tenantId,
});

/** Authority period stored on one immutable contract revision. */
interface AuthorityPeriod {
  readonly authorityFrom: Date;
  readonly authorityTo: Date | null;
}

const authorityMeaning = (
  factFamily: string,
  authority: Readonly<{
    authorityFrom: string;
    authorityTo: string | null;
    evidenceSourceRefs: readonly string[];
    systemOfRecordRef: string;
  }>,
) => ({
  authorityFrom: authority.authorityFrom,
  authorityTo: authority.authorityTo,
  evidenceSourceRefs: authority.evidenceSourceRefs.toSorted((left, right) => left.localeCompare(right, 'en')),
  factFamily,
  systemOfRecordRef: authority.systemOfRecordRef,
});

/** Semantic fingerprint of one authority revision; evidence roles are part of meaning but never authority. */
export const taxFactAuthorityContentFingerprint = (factFamily: string, content: TaxFactAuthorityContent): string =>
  taxMeaningFingerprint(
    authorityMeaning(factFamily, {
      authorityFrom: DateTime.formatIso(content.authorityFrom),
      authorityTo: content.authorityTo === undefined ? null : DateTime.formatIso(content.authorityTo),
      evidenceSourceRefs: content.evidenceSourceRefs,
      systemOfRecordRef: content.systemOfRecordRef,
    }),
  );

/** Expected-current basis of a contract: its current revision identity and meaning (#949 F20, #955). */
export const taxFactAuthorityContractBasisFingerprint = (
  revision: Pick<
    ContractRevisionRow,
    'revisionNumber' | 'semanticFingerprint' | 'taxFactAuthorityContractId' | 'taxFactAuthorityContractRevisionId'
  >,
): string =>
  taxMeaningFingerprint({
    contractId: revision.taxFactAuthorityContractId,
    revisionId: revision.taxFactAuthorityContractRevisionId,
    revisionNumber: revision.revisionNumber,
    semanticFingerprint: revision.semanticFingerprint,
  });

const startsBeforeEnd = (start: Date, end: Date | null): boolean =>
  end === null || DateTime.isLessThan(DateTime.makeUnsafe(start), DateTime.makeUnsafe(end));

/** Half-open authority periods `[from, to)` overlap when each starts before the other ends. */
export const authorityPeriodsOverlap = (left: AuthorityPeriod, right: AuthorityPeriod): boolean =>
  startsBeforeEnd(left.authorityFrom, right.authorityTo) && startsBeforeEnd(right.authorityFrom, left.authorityTo);

/** Half-open authority membership: the period starting at the instant covers it, the one ending there does not. */
export const authorityCoversInstant = (period: AuthorityPeriod, at: DateTime.Utc): boolean =>
  DateTime.isLessThanOrEqualTo(DateTime.makeUnsafe(period.authorityFrom), at) &&
  (period.authorityTo === null || DateTime.isLessThan(at, DateTime.makeUnsafe(period.authorityTo)));

/**
 * The contract chain's current revision is its last governed amendment; competitors are never ranked. Revising never
 * moves the System of Record or the authority window and ending only shortens it, so the current revision's window
 * is the contract's effective authority window at every instant (#949 F30-F32, F44).
 */
export const currentContractRevisions = (
  revisions: readonly ContractRevisionRow[],
): ReadonlyMap<string, ContractRevisionRow> => {
  const current = new Map<string, ContractRevisionRow>();
  for (const revision of revisions) {
    const known = current.get(revision.taxFactAuthorityContractId);
    if (known === undefined || known.revisionNumber < revision.revisionNumber) {
      current.set(revision.taxFactAuthorityContractId, revision);
    }
  }
  return current;
};

type ContractOutcome = Readonly<{
  contractId: string;
  created: boolean;
  meaningFingerprint: string;
  revisionId: string;
  revisionNumber: number;
}>;
export type EstablishOutcome = ContractOutcome | GovernanceConflict;
export type ReviseOutcome = ContractOutcome | GovernanceConflict | GovernanceNotFound | GovernanceStale;

export interface TaxAuthorityGovernancePersistence {
  readonly endContract: (
    input: Invocation<EndTaxFactAuthorityContractPayload>,
  ) => Effect.Effect<ReviseOutcome, PersistenceUnavailable>;
  readonly establishContract: (
    input: Invocation<EstablishTaxFactAuthorityContractPayload>,
  ) => Effect.Effect<EstablishOutcome, PersistenceUnavailable>;
  readonly reviseContract: (
    input: Invocation<ReviseTaxFactAuthorityContractPayload>,
  ) => Effect.Effect<ReviseOutcome, PersistenceUnavailable>;
}

const toPeriod = (content: TaxFactAuthorityContent): AuthorityPeriod => ({
  authorityFrom: DateTime.toDateUtc(content.authorityFrom),
  authorityTo: content.authorityTo === undefined ? null : DateTime.toDateUtc(content.authorityTo),
});

/** A revision keeps the System of Record and the whole authority window; only evidence roles may change. */
const keepsAuthority = (current: ContractRevisionRow, next: TaxFactAuthorityContent): boolean => {
  const period = toPeriod(next);
  return (
    current.systemOfRecordRef === next.systemOfRecordRef &&
    sameInstant(current.authorityFrom, period.authorityFrom) &&
    sameInstant(current.authorityTo, period.authorityTo)
  );
};

export const taxAuthorityGovernancePersistenceForScope = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
): TaxAuthorityGovernancePersistence => {
  const lockFactFamily = (input: GovernedInvocation, factFamily: FactFamily) =>
    lockTaxFactFamily(transaction, input, factFamily);

  /** Complete current authority set for one fact family and seller (#949 F24-F32). */
  const loadFamily = Effect.fn('taxAuthorityGovernancePersistence.loadFamily')(function* loadFamilyEffect(
    input: GovernedInvocation,
    factFamily: FactFamily,
  ) {
    const contracts = yield* query(
      transaction
        .select()
        .from(taxFactAuthorityContracts)
        .where(
          and(
            eq(taxFactAuthorityContracts.tenantId, input.tenantId),
            eq(taxFactAuthorityContracts.legalEntityId, input.legalEntityId),
            eq(taxFactAuthorityContracts.factFamily, factFamily),
          ),
        ),
    );
    const contractIds = contracts.map((contract) => contract.taxFactAuthorityContractId);
    const revisions =
      contractIds.length === 0
        ? []
        : yield* query(
            transaction
              .select()
              .from(taxFactAuthorityContractRevisions)
              .where(
                and(
                  eq(taxFactAuthorityContractRevisions.tenantId, input.tenantId),
                  eq(taxFactAuthorityContractRevisions.legalEntityId, input.legalEntityId),
                  inArray(taxFactAuthorityContractRevisions.taxFactAuthorityContractId, contractIds),
                ),
              ),
          );
    return currentContractRevisions(revisions);
  });

  /** Competing System-of-Record authority from another contract at any shared instant is a conflict. */
  const competes = (current: ReadonlyMap<string, ContractRevisionRow>, contractId: string, period: AuthorityPeriod) =>
    [...current.values()].some(
      (revision) => revision.taxFactAuthorityContractId !== contractId && authorityPeriodsOverlap(revision, period),
    );

  const revisionByInvocation = (input: GovernedInvocation) =>
    query(
      transaction
        .select()
        .from(taxFactAuthorityContractRevisions)
        .where(
          and(
            eq(taxFactAuthorityContractRevisions.tenantId, input.tenantId),
            eq(taxFactAuthorityContractRevisions.idempotencyKey, input.actionInvocationId),
          ),
        )
        .limit(1),
    );

  const establishContract: TaxAuthorityGovernancePersistence['establishContract'] = Effect.fn(
    'taxAuthorityGovernancePersistence.establishContract',
  )(function* establishContractEffect(input) {
    if (!trustedInvocation(scope, input, [])) {
      return yield* unavailable();
    }
    const meaningFingerprint = taxFactAuthorityContentFingerprint(input.factFamily, input.authority);
    const [replay] = yield* query(
      transaction
        .select()
        .from(taxFactAuthorityContracts)
        .where(
          and(
            eq(taxFactAuthorityContracts.tenantId, input.tenantId),
            eq(taxFactAuthorityContracts.idempotencyKey, input.actionInvocationId),
          ),
        )
        .limit(1),
    );
    if (replay !== undefined) {
      const [replayRevision] = yield* revisionByInvocation(input);
      const matches =
        replayRevision !== undefined &&
        sameAttribution(replay, input) &&
        sameAttribution(replayRevision, input) &&
        replay.factFamily === input.factFamily &&
        replay.stableCode === input.stableCode &&
        replayRevision.taxFactAuthorityContractId === replay.taxFactAuthorityContractId &&
        replayRevision.revisionNumber === 1 &&
        replayRevision.semanticFingerprint === meaningFingerprint;
      return matches
        ? {
            contractId: replay.taxFactAuthorityContractId,
            created: false,
            meaningFingerprint,
            revisionId: replayRevision.taxFactAuthorityContractRevisionId,
            revisionNumber: 1,
          }
        : conflict('IDEMPOTENCY_REUSED');
    }
    yield* lockFactFamily(input, input.factFamily);
    const [duplicate] = yield* query(
      transaction
        .select({ contractId: taxFactAuthorityContracts.taxFactAuthorityContractId })
        .from(taxFactAuthorityContracts)
        .where(
          and(
            eq(taxFactAuthorityContracts.tenantId, input.tenantId),
            eq(taxFactAuthorityContracts.legalEntityId, input.legalEntityId),
            eq(taxFactAuthorityContracts.stableCode, input.stableCode),
          ),
        )
        .limit(1),
    );
    if (duplicate !== undefined) {
      return conflict('STABLE_CODE');
    }
    const current = yield* loadFamily(input, input.factFamily);
    if (competes(current, '', toPeriod(input.authority))) {
      return conflict('AUTHORITY_CONFLICT');
    }
    const contracts = yield* mutation(
      transaction
        .insert(taxFactAuthorityContracts)
        .values({
          actionInvocationId: input.actionInvocationId,
          actorPrincipalId: input.actorPrincipalId,
          factFamily: input.factFamily,
          idempotencyKey: input.actionInvocationId,
          legalEntityId: input.legalEntityId,
          provenanceRef: input.provenanceRef,
          reason: input.reason,
          stableCode: input.stableCode,
          tenantId: input.tenantId,
        })
        .returning({ contractId: taxFactAuthorityContracts.taxFactAuthorityContractId }),
    );
    if ('kind' in contracts) {
      return contracts;
    }
    const [contract] = contracts;
    if (contract === undefined) {
      return yield* unavailable();
    }
    const period = toPeriod(input.authority);
    const revision = yield* mutation(
      transaction
        .insert(taxFactAuthorityContractRevisions)
        .values({
          actionInvocationId: input.actionInvocationId,
          actorPrincipalId: input.actorPrincipalId,
          authorityFrom: period.authorityFrom,
          authorityTo: period.authorityTo,
          evidenceSourceRefs: input.authority.evidenceSourceRefs,
          idempotencyKey: input.actionInvocationId,
          legalEntityId: input.legalEntityId,
          provenanceRef: input.provenanceRef,
          reason: input.reason,
          revisionNumber: 1,
          semanticFingerprint: meaningFingerprint,
          systemOfRecordRef: input.authority.systemOfRecordRef,
          taxFactAuthorityContractId: contract.contractId,
          tenantId: input.tenantId,
        })
        .returning({ revisionId: taxFactAuthorityContractRevisions.taxFactAuthorityContractRevisionId }),
    );
    if ('kind' in revision) {
      return revision;
    }
    const [inserted] = revision;
    return inserted === undefined
      ? yield* unavailable()
      : {
          contractId: contract.contractId,
          created: true,
          meaningFingerprint,
          revisionId: inserted.revisionId,
          revisionNumber: 1,
        };
  });

  /** Appends the next contract revision after expected-current and complete-set conflict checks. */
  const appendRevision = Effect.fn('taxAuthorityGovernancePersistence.appendRevision')(function* appendRevisionEffect(
    input: GovernedInvocation &
      Readonly<{
        contractId: string;
        expectedBasisFingerprint: string;
        provenanceRef: string;
        reason: string;
      }>,
    nextContent: (
      current: ContractRevisionRow,
    ) => Readonly<{ content: TaxFactAuthorityContent } | { lifecycleConflict: true }>,
  ) {
    const [replay] = yield* revisionByInvocation(input);
    if (replay !== undefined) {
      return { kind: 'replay' as const, replay };
    }
    if (!isOwnerId(input.contractId)) {
      return notFound;
    }
    const [contract] = yield* query(
      transaction
        .select()
        .from(taxFactAuthorityContracts)
        .where(
          and(
            eq(taxFactAuthorityContracts.tenantId, input.tenantId),
            eq(taxFactAuthorityContracts.legalEntityId, input.legalEntityId),
            eq(taxFactAuthorityContracts.taxFactAuthorityContractId, input.contractId),
          ),
        )
        .limit(1),
    );
    if (contract === undefined) {
      return notFound;
    }
    yield* lockFactFamily(input, contract.factFamily);
    const family = yield* loadFamily(input, contract.factFamily);
    const current = family.get(input.contractId);
    if (current === undefined) {
      return yield* unavailable();
    }
    if (input.expectedBasisFingerprint !== taxFactAuthorityContractBasisFingerprint(current)) {
      return staleBasis;
    }
    const next = nextContent(current);
    if ('lifecycleConflict' in next) {
      return conflict('LIFECYCLE');
    }
    const period = toPeriod(next.content);
    if (competes(family, input.contractId, period)) {
      return conflict('AUTHORITY_CONFLICT');
    }
    const meaningFingerprint = taxFactAuthorityContentFingerprint(contract.factFamily, next.content);
    const revisionNumber = current.revisionNumber + 1;
    const inserted = yield* mutation(
      transaction
        .insert(taxFactAuthorityContractRevisions)
        .values({
          actionInvocationId: input.actionInvocationId,
          actorPrincipalId: input.actorPrincipalId,
          authorityFrom: period.authorityFrom,
          authorityTo: period.authorityTo,
          evidenceSourceRefs: next.content.evidenceSourceRefs,
          idempotencyKey: input.actionInvocationId,
          legalEntityId: input.legalEntityId,
          provenanceRef: input.provenanceRef,
          reason: input.reason,
          revisionNumber,
          semanticFingerprint: meaningFingerprint,
          systemOfRecordRef: next.content.systemOfRecordRef,
          taxFactAuthorityContractId: input.contractId,
          tenantId: input.tenantId,
        })
        .returning({ revisionId: taxFactAuthorityContractRevisions.taxFactAuthorityContractRevisionId }),
    );
    if ('kind' in inserted) {
      return inserted;
    }
    const [row] = inserted;
    return row === undefined
      ? yield* unavailable()
      : { contractId: input.contractId, created: true, meaningFingerprint, revisionId: row.revisionId, revisionNumber };
  });

  const reviseContract: TaxAuthorityGovernancePersistence['reviseContract'] = Effect.fn(
    'taxAuthorityGovernancePersistence.reviseContract',
  )(function* reviseContractEffect(input) {
    if (!trustedInvocation(scope, input, [input.contractRef.tenantId])) {
      return yield* unavailable();
    }
    // Revising only changes evidence roles; an authority transition is an end plus a successor contract (#949 F30).
    const outcome = yield* appendRevision({ ...input, contractId: input.contractRef.resourceId }, (current) =>
      keepsAuthority(current, input.authority) ? { content: input.authority } : { lifecycleConflict: true as const },
    );
    if (!('kind' in outcome) || outcome.kind !== 'replay') {
      return outcome;
    }
    const { replay } = outcome;
    const [contract] = yield* query(
      transaction
        .select({ factFamily: taxFactAuthorityContracts.factFamily })
        .from(taxFactAuthorityContracts)
        .where(
          and(
            eq(taxFactAuthorityContracts.tenantId, input.tenantId),
            eq(taxFactAuthorityContracts.legalEntityId, input.legalEntityId),
            eq(taxFactAuthorityContracts.taxFactAuthorityContractId, replay.taxFactAuthorityContractId),
          ),
        )
        .limit(1),
    );
    const meaningFingerprint =
      contract === undefined ? '' : taxFactAuthorityContentFingerprint(contract.factFamily, input.authority);
    const matches =
      sameAttribution(replay, input) &&
      replay.taxFactAuthorityContractId === input.contractRef.resourceId &&
      replay.semanticFingerprint === meaningFingerprint;
    return matches
      ? {
          contractId: replay.taxFactAuthorityContractId,
          created: false,
          meaningFingerprint,
          revisionId: replay.taxFactAuthorityContractRevisionId,
          revisionNumber: replay.revisionNumber,
        }
      : conflict('IDEMPOTENCY_REUSED');
  });

  const endContract: TaxAuthorityGovernancePersistence['endContract'] = Effect.fn(
    'taxAuthorityGovernancePersistence.endContract',
  )(function* endContractEffect(input) {
    if (!trustedInvocation(scope, input, [input.contractRef.tenantId])) {
      return yield* unavailable();
    }
    const authorityTo = DateTime.toDateUtc(input.authorityTo);
    // Ending appends a final revision that only shortens the current authority period and is never backdated.
    const outcome = yield* appendRevision({ ...input, contractId: input.contractRef.resourceId }, (current) =>
      notBackdated(authorityTo, input) &&
      startsBeforeEnd(current.authorityFrom, authorityTo) &&
      startsBeforeEnd(authorityTo, current.authorityTo)
        ? {
            content: {
              authorityFrom: DateTime.makeUnsafe(current.authorityFrom),
              authorityTo: input.authorityTo,
              evidenceSourceRefs: current.evidenceSourceRefs,
              systemOfRecordRef: current.systemOfRecordRef,
            },
          }
        : { lifecycleConflict: true as const },
    );
    if (!('kind' in outcome) || outcome.kind !== 'replay') {
      return outcome;
    }
    const { replay } = outcome;
    const matches =
      sameAttribution(replay, input) &&
      replay.taxFactAuthorityContractId === input.contractRef.resourceId &&
      replay.authorityTo !== null &&
      sameInstant(replay.authorityTo, authorityTo);
    return matches
      ? {
          contractId: replay.taxFactAuthorityContractId,
          created: false,
          meaningFingerprint: replay.semanticFingerprint,
          revisionId: replay.taxFactAuthorityContractRevisionId,
          revisionNumber: replay.revisionNumber,
        }
      : conflict('IDEMPOTENCY_REUSED');
  });

  return Object.freeze({ endContract, establishContract, reviseContract });
};

export const taxAuthorityGovernanceServiceFactory = (transaction: ScopedTransaction, scope: OperationalScope) =>
  Effect.succeed(taxAuthorityGovernancePersistenceForScope(transaction, scope));
