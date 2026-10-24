import { useEffect, useRef, useState } from 'react';
import { DateTime, Effect, Exit, Match, Option, Predicate, Random, Ref, Schema } from 'effect';

import { definePageData, modulePagePreload } from '@app/shared-contracts/page-data';

import { executeAresLookup } from '../../../../api/ares-lookup-client.ts';
import { executeDuplicateCandidateList } from '../../../../api/duplicate-candidate-list-client.ts';
import { executeDuplicateCandidateDetail } from '../../../../api/duplicate-candidate-detail-client.ts';
import type { DuplicateCandidateListResponse } from '../../../../../shared/apis/duplicate-candidate-list.ts';
import type { DuplicateCandidateCaseRefSchema } from '../../../../../shared/resources/duplicate-candidate-case.ts';
import type { DuplicateCaseResolutionResult } from '../../../../../shared/domain/matching-contracts.ts';
import { DuplicateCaseResolutionPayloadSchema } from '../../../../../shared/domain/matching-contracts.ts';
import { ResolveDuplicateCandidateMatchPayloadSchema } from '../../../../../shared/actions/resolve-duplicate-candidate-match.ts';

import type { CustomerSegment } from '../../../../api/customer-segments-client.ts';
import { customerSegmentsFor } from '../../../../api/customer-segments-client.ts';
import type { CustomerListItem } from '../../../../api/customers-client.ts';
import { createCustomer, listCustomers, archiveCustomer } from '../../../../api/customers-client.ts';
import { AresLookupRequestSchema } from '../../../../../shared/apis/ares-lookup.ts';
import { PartyCommandForbiddenProblemSchema } from '../../../../../shared/command-api.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { executeCounterpartyRead } from '../../../../api/counterparty-read-client.ts';
import { executePartyDetail } from '../../../../api/party-detail-client.ts';
import { executePartyContactPoints } from '../../../../api/party-contact-points-client.ts';
import { executePartyOfficialIdentifierHistory } from '../../../../api/party-official-identifier-history-client.ts';
import {
  addContactPoint,
  addPartyOfficialIdentifier,
  correctPartyFact,
  dismissDuplicateCandidate,
  markDuplicateCandidateNeedsEvidence,
  resolveDuplicateCandidateCreate,
  resolveDuplicateCandidateMatch,
  resolvePartyCommandCommit,
  endContactPoint,
  endPartyOfficialIdentifier,
  unarchiveParty,
  updateContactPoint,
  updateParty,
} from '../../../../api/party-command-client.ts';
import { CorrectPartyFactPayloadSchema } from '../../../../../shared/actions/correct-party-fact.ts';
import { ContactPointInputSchema } from '../../../../../shared/domain/contact-point.ts';
import type { ContactPointInput, PartyContactPoint } from '../../../../../shared/domain/contact-point.ts';
import { OfficialIdentifierInputSchema } from '../../../../../shared/domain/identifier-contracts.ts';
import type { OfficialIdentifierAssertion } from '../../../../../shared/domain/identifier-contracts.ts';
import type { Party } from '../../../../../shared/domain/identity-contracts.ts';
import type { PartyRef } from '../../../../../shared/resources/party.ts';
import {
  customerContactRows,
  customerIdentifierRows,
  customerHistoryRows,
  discardCustomerDraftKeys,
} from './customers-model.ts';
import type { CreateDraft } from './customers-model.ts';

type DuplicateCandidateCaseRef = typeof DuplicateCandidateCaseRefSchema.Type;

export interface CustomersSnapshot {
  readonly items: readonly CustomerListItem[];
  readonly nowMillis: number;
  /** Current segment per party id. None when the best-effort segment lookup failed, so the column is left out. */
  readonly segments: Option.Option<ReadonlyMap<string, CustomerSegment>>;
}

const correlation = (operation: string) =>
  Effect.map(
    Effect.all([Random.nextInt, Random.nextInt], { concurrency: 1 }),
    ([first, second]) => `party-registry:${operation}:${first}:${second}`,
  );

/**
 * Set once the segment owner refuses (a non-transient failure) in this document. A role only changes with a
 * sign-out, which reloads the document, so later reads skip the lookup instead of logging the same refusal again.
 */
const segmentsRefusal = browserRuntime.runSync(Ref.make(false));

/** Segments are best effort: any failure, defects included, yields none instead of failing the customer list. */
const segmentsOf = Effect.fn('CustomersData.segmentsOf')(function* segmentsOf(items: readonly CustomerListItem[]) {
  if (yield* Ref.get(segmentsRefusal)) {
    return Option.none<ReadonlyMap<string, CustomerSegment>>();
  }
  const exit = yield* Effect.exit(customerSegmentsFor(items));
  if (Option.exists(Exit.findErrorOption(exit), (failure) => !failure.retryable)) {
    yield* Ref.set(segmentsRefusal, true);
  }
  return Exit.getSuccess(exit);
});

/** Every current customer, archived included so the Archivovaní stat is real, with their segments. */
export const loadCustomers = Effect.all(
  {
    items: listCustomers({ includeArchived: true, limit: 500 }),
    now: DateTime.now,
  },
  { concurrency: 1 },
).pipe(
  Effect.flatMap(({ items, now }) =>
    Effect.map(segmentsOf(items), (segments): CustomersSnapshot => ({
      items,
      nowMillis: DateTime.toEpochMillis(now),
      segments,
    })),
  ),
);

/** The page reads the whole register and filters it locally, so there is one dataset. */
export const allCustomers = 'all';
type CustomersQuery = typeof allCustomers;

/**
 * The customer list of the signed-in principal. The Shell fills it through `preloadPage` before it reveals the
 * page, so rows, stats and segment labels render in the first commit.
 */
export const customersData = definePageData({
  key: (query: CustomersQuery) => query,
  load: (_query: CustomersQuery) => loadCustomers,
  runtime: browserRuntime,
});

/** `preloadPage` of the customers page. */
export const preloadCustomers = modulePagePreload(() => customersData.preload(allCustomers));

export const lookupAres = Effect.fn('CustomersData.lookupAres')(function* lookupAresEffect(ico: string) {
  const payload = yield* Schema.decodeEffect(AresLookupRequestSchema)({ ico });
  const requestCorrelation = yield* correlation('ares-lookup');
  return yield* executeAresLookup(payload, requestCorrelation);
});

/** The client trims every field, drops empty ones and sends an address only when two of its parts are present. */
export const createCustomerFromDraft = (draft: CreateDraft) =>
  createCustomer({
    address: { city: draft.city, countryCode: 'CZ', postalCode: draft.postalCode, street: draft.street },
    companyId: draft.ico,
    displayName: draft.name.trim(),
    email: draft.email,
    phone: draft.phone,
    vatId: draft.vatId,
  });

/** True for the owner's 403 on a customer write (create, archive). */
export const isCustomerWriteForbidden = Schema.is(PartyCommandForbiddenProblemSchema);

/**
 * Set once the owner refuses a customer write with 403 in this document. A role only changes with a sign-out, which
 * reloads the document, so from then on the page hides its write actions instead of letting each one wait for the
 * owner's refusal again.
 */
const customerWriteRefusal = browserRuntime.runSync(Ref.make(false));
export const customerWritesRefused = (): boolean => browserRuntime.runSync(Ref.get(customerWriteRefusal));
export const rememberCustomerWriteRefusal = (): void => browserRuntime.runSync(Ref.set(customerWriteRefusal, true));

/** Translation key (under `create`) for a failed ARES lookup. */
export const aresFailureKey = (error: Effect.Error<ReturnType<typeof lookupAres>>) =>
  Predicate.isTagged(error, 'AresLookupNotFoundProblem') ? 'aresNotFound' : 'aresUnavailable';

/** Translation key (under `create`) for a failed create. A 403 says so instead of suggesting a retry. */
export const createFailureKey = (error: Effect.Error<ReturnType<typeof createCustomerFromDraft>>) => {
  if (Predicate.isTagged(error, 'CustomerCreateAmbiguous')) {
    return 'errorAmbiguous';
  }
  return isCustomerWriteForbidden(error) ? 'errorForbidden' : 'errorGeneric';
};

/** Detail reads retain their individual authorization outcomes. A Counterparty grant never grants Party Read. */
export type CustomerSection<Value> =
  | { readonly status: 'ready'; readonly value: Value }
  | { readonly status: 'forbidden' | 'unavailable' };

const section = <Value, Failure>(operation: Effect.Effect<Value, Failure>) =>
  operation.pipe(
    Effect.match({
      onFailure: (error): CustomerSection<Value> => ({
        status: Schema.is(Schema.Struct({ status: Schema.Literal(403) }))(error) ? 'forbidden' : 'unavailable',
      }),
      onSuccess: (value): CustomerSection<Value> => ({ status: 'ready', value }),
    }),
  );

export const loadCustomerDetail = Effect.fn('CustomersData.loadDetail')(function* loadDetail(
  customer: CustomerListItem,
) {
  const id = yield* correlation('customer-detail');
  // First prove access to this exact commercial context, independently of broader identity permissions.
  const counterparty = yield* executeCounterpartyRead({ counterpartyRef: customer.counterpartyRef }, id);
  const identity = yield* section(
    executePartyDetail({ includeFactHistory: true, partyRef: counterparty.party.canonicalPartyRef }, id),
  );
  const partyRef = identity.status === 'ready' ? identity.value.resolution.canonicalPartyRef : customer.partyRef;
  const { contacts, identifiers } = yield* Effect.all(
    {
      contacts: section(executePartyContactPoints({ includeHistorical: true, partyRef }, id)),
      identifiers: section(executePartyOfficialIdentifierHistory({ partyRef }, id)),
    },
    { concurrency: 2 },
  );
  return { contacts, counterparty, identifiers, identity, now: yield* DateTime.now };
});
export type CustomerDetailSnapshot = Effect.Success<ReturnType<typeof loadCustomerDetail>>;

export type CustomerFactChange =
  | { readonly kind: 'name'; readonly value: string; readonly party: Party }
  | { readonly kind: 'lifecycle'; readonly party: Party }
  | { readonly kind: 'endContact'; readonly existing: PartyContactPoint }
  | { readonly kind: 'endIdentifier'; readonly existing: OfficialIdentifierAssertion }
  | { readonly kind: 'contact'; readonly existing: PartyContactPoint | undefined; readonly value: ContactPointInput }
  | {
      readonly kind: 'identifier';
      readonly existing: OfficialIdentifierAssertion | undefined;
      readonly identifierType: 'ICO' | 'CZ_DIC';
      readonly value: string;
    };

/** One button submits one existing Action. Confirmed sections remain saved if another section fails. */
export const saveCustomerFact = Effect.fn('CustomersData.saveFact')(function* saveFact(
  partyRef: PartyRef,
  change: CustomerFactChange,
  reason: string,
  evidenceReference: string,
) {
  const id = yield* correlation('customer-fact');
  const now = yield* DateTime.now;
  const options = { correlationId: id, idempotencyKey: id };
  const provenance = {
    authoritative: false,
    evidenceReference,
    method: 'MANUAL_CONFIRMATION' as const,
    source: 'USER_ASSERTION' as const,
  };
  return yield* Match.value(change).pipe(
    Match.discriminatorsExhaustive('kind')({
      name: (item) =>
        updateParty(
          {
            displayName: item.value.trim(),
            expectedRevision: item.party.revision,
            partyRef,
            provenanceMethod: 'MANUAL_ENTRY',
            provenanceSource: evidenceReference,
            validFrom: now,
          },
          options,
        ),
      lifecycle: Effect.fn('CustomersData.lifecycle')(function* lifecycle(
        item: Extract<CustomerFactChange, { readonly kind: 'lifecycle' }>,
      ) {
        if (Option.isSome(item.party.archivedAt)) {
          return yield* unarchiveParty({ expectedRevision: item.party.revision, partyRef, reason }, options);
        }
        return yield* archiveCustomer({ partyRef, partyRevision: item.party.revision }, reason);
      }),
      endContact: (item) =>
        endContactPoint(
          {
            contactPointRef: item.existing.contactPointRef,
            effectiveEnd: now,
            provenance,
            reason,
            target: { type: 'WHOLE_CONTACT_POINT' },
          },
          options,
        ),
      endIdentifier: (item) =>
        endPartyOfficialIdentifier(
          { officialIdentifierRef: item.existing.officialIdentifierRef, reason, validTo: now },
          options,
        ),
      contact: Effect.fn('CustomersData.contact')(function* contact(
        item: Extract<CustomerFactChange, { readonly kind: 'contact' }>,
      ) {
        const contactPoint = yield* Schema.decodeEffect(ContactPointInputSchema)(item.value);
        if (item.existing === undefined) {
          return yield* addContactPoint(
            {
              contactPoint,
              partyRef,
              privacyClassification: 'BUSINESS_SENSITIVE',
              provenance,
              validFrom: now,
              verification: { state: 'UNVERIFIED' },
            },
            options,
          );
        }
        return yield* updateContactPoint(
          {
            change: {
              evidenceReferences: [evidenceReference],
              reason,
              replacement: {
                contactPoint,
                privacyClassification: item.existing.privacyClassification,
                provenance,
                validFrom: now,
                verification: { state: 'UNVERIFIED' },
              },
              type: 'CORRECT_CONTACT_POINT',
            },
            contactPointRef: item.existing.contactPointRef,
            expectedRevision: item.existing.revision,
            provenance,
          },
          options,
        );
      }),
      identifier: Effect.fn('CustomersData.identifier')(function* saveIdentifier(
        item: Extract<CustomerFactChange, { readonly kind: 'identifier' }>,
      ) {
        const identifier = yield* Schema.decodeEffect(OfficialIdentifierInputSchema)({
          identifierType: item.identifierType,
          value: item.value,
          verification: 'UNVERIFIED',
        });
        if (item.existing === undefined) {
          return yield* addPartyOfficialIdentifier(
            {
              identifier,
              partyRef,
              provenanceMethod: 'MANUAL_ENTRY',
              provenanceSource: evidenceReference,
              validFrom: now,
            },
            options,
          );
        }
        // Decode branded identities at the owner contract; never coerce an assertion or Party ID.
        const payload = yield* Schema.decodeEffect(CorrectPartyFactPayloadSchema)({
          evidenceRefs: [evidenceReference],
          evidenceSource: 'MANUAL_REVIEW',
          factKind: 'OFFICIAL_IDENTIFIER',
          partyId: partyRef.resourceId,
          policyVersion: 'party-correction.v1',
          provenance: { method: 'MANUAL_REVIEW', source: 'party-registry.customers' },
          reasonCode: 'WRONG_IDENTITY_VALUE',
          reasonDetail: reason,
          replacementValue: identifier.value,
          targetAssertionId: item.existing.officialIdentifierRef.resourceId,
        });
        return yield* correctPartyFact(payload, options);
      }),
    }),
  );
});

export const customerDetailFailureKey = (
  error: Effect.Error<ReturnType<typeof saveCustomerFact> | ReturnType<typeof loadCustomerDetail>>,
): string => {
  if (Schema.is(Schema.Struct({ status: Schema.Literal(403) }))(error)) {
    return 'forbidden';
  }
  if (Schema.is(Schema.Struct({ status: Schema.Literal(409) }))(error)) {
    return 'conflict';
  }
  if (
    Schema.is(Schema.Struct({ status: Schema.Literals([400, 422]) }))(error) ||
    Predicate.isTagged(error, 'SchemaError')
  ) {
    return 'validation';
  }
  return 'unavailable';
};

export interface CustomerDetailLoadState {
  readonly failure?: 'forbidden' | 'unavailable';
  readonly id: string;
  readonly value?: CustomerDetailSnapshot;
}

export const loadCustomerDetailInto = (
  customer: CustomerListItem,
  onLoaded: (next: CustomerDetailLoadState) => void,
) => {
  void browserRuntime.runPromise(
    loadCustomerDetail(customer).pipe(
      Effect.match({
        onFailure: (error) =>
          onLoaded({
            failure: Predicate.isTagged(error, 'CounterpartyReadForbiddenProblem') ? 'forbidden' : 'unavailable',
            id: customer.counterpartyId,
          }),
        onSuccess: (value) => onLoaded({ id: customer.counterpartyId, value }),
      }),
    ),
  );
};

type CustomerLeaveIntent = { readonly kind: 'close' } | { readonly href: string; readonly kind: 'navigate' };
const navigateCustomerDocument = (href: string): void => globalThis.location.assign(href);

/** Application state stays with the owning feature. Each mutation retains unrelated drafts. */
export const useCustomerDetail = (
  customer: CustomerListItem,
  initialSnapshot: CustomerDetailSnapshot | undefined,
  onOpenChange: (open: boolean) => void,
  onRenamed: () => void,
  onSaved: () => void,
  t: (key: string, values?: Record<string, string>) => string,
  navigate: (href: string) => void = navigateCustomerDocument,
) => {
  const KEY = 'party-registry.pages.customers.detail';
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [evidence, setEvidence] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [leaveIntent, setLeaveIntent] = useState<CustomerLeaveIntent>();
  const allowDocumentLeave = useRef(false);
  const discardOpen = leaveIntent !== undefined;
  const dirty = Object.keys(draft).length > 0;
  const identity = snapshot?.identity;
  const party = identity?.status === 'ready' ? identity.value.party : undefined;
  const value = (key: string, original = '') => draft[key] ?? original;
  const changeDraft = (key: string, next: string, original = '') =>
    setDraft((current) => (next === original ? discardCustomerDraftKeys(current, [key]) : { ...current, [key]: next }));

  // A confirmed related link consumes one unload allowance. Any cancelled browser unload stays guarded.
  useEffect(() => {
    const guardDocumentLeave = (event: BeforeUnloadEvent) => {
      if (allowDocumentLeave.current) {
        allowDocumentLeave.current = false;
        return;
      }
      if (dirty || busy) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    globalThis.addEventListener('beforeunload', guardDocumentLeave);
    return () => globalThis.removeEventListener('beforeunload', guardDocumentLeave);
  }, [busy, dirty]);

  const completeLeave = (intent: CustomerLeaveIntent) =>
    Match.value(intent).pipe(
      Match.discriminatorsExhaustive('kind')({
        close: () => onOpenChange(false),
        navigate: ({ href }) => {
          allowDocumentLeave.current = true;
          navigate(href);
        },
      }),
    );
  const requestLeave = (intent: CustomerLeaveIntent) => {
    if (busy) {
      return;
    }
    if (dirty) {
      setLeaveIntent(intent);
      return;
    }
    completeLeave(intent);
  };
  const requestClose = (open: boolean) => {
    if (open) {
      onOpenChange(true);
    } else {
      requestLeave({ kind: 'close' });
    }
  };
  const requestNavigation = (href: string) => requestLeave({ href, kind: 'navigate' });
  const setDiscardOpen = (open: boolean) => {
    if (!open) {
      setLeaveIntent(undefined);
    }
  };
  const confirmDiscard = () => {
    if (!busy && leaveIntent !== undefined) {
      setLeaveIntent(undefined);
      completeLeave(leaveIntent);
    }
  };

  const refresh = () => {
    setBusy(true);
    void browserRuntime.runPromise(
      loadCustomerDetail(customer).pipe(
        Effect.match({
          onFailure: (error) => {
            setStale(true);
            setNotice(t(`${KEY}.${customerDetailFailureKey(error)}`));
          },
          onSuccess: (next) => {
            setSnapshot(next);
            setStale(false);
            setNotice(null);
          },
        }),
        Effect.ensuring(Effect.sync(() => setBusy(false))),
      ),
    );
  };

  const save = (change: CustomerFactChange, keys: readonly string[]) => {
    if (party === undefined || busy || stale) {
      return;
    }
    if (reason.trim() === '' || evidence.trim() === '' || (change.kind === 'name' && change.value.trim() === '')) {
      setNotice(t(`${KEY}.validation`));
      return;
    }
    setBusy(true);
    setNotice(null);
    void browserRuntime.runPromise(
      saveCustomerFact(party.partyRef, change, reason.trim(), evidence.trim()).pipe(
        Effect.matchEffect({
          onFailure: (error) =>
            Effect.sync(() => {
              setNotice(t(`${KEY}.${customerDetailFailureKey(error)}`));
              if (customerDetailFailureKey(error) === 'conflict') {
                setStale(true);
              }
            }),
          onSuccess: (result) => {
            if (Schema.is(Schema.Struct({ outcome: Schema.Literal('BLOCKED') }))(result)) {
              return Effect.sync(() => setNotice(t(`${KEY}.restoreBlocked`)));
            }
            // Clear only the confirmed section. Other drafts survive errors and subsequent snapshot refreshes.
            return Effect.sync(() => {
              setDraft((current) => discardCustomerDraftKeys(current, keys));
              onRenamed();
              onSaved();
            }).pipe(
              Effect.andThen(loadCustomerDetail(customer)),
              Effect.match({
                onFailure: (error) => {
                  setStale(true);
                  setNotice(t(`${KEY}.savedReloadFailed`, { reason: t(`${KEY}.${customerDetailFailureKey(error)}`) }));
                },
                onSuccess: (next) => setSnapshot(next),
              }),
            );
          },
        }),
        Effect.ensuring(Effect.sync(() => setBusy(false))),
      ),
    );
  };

  const contacts = snapshot?.contacts.status === 'ready' ? snapshot.contacts.value.items : [];
  const identifiers = snapshot?.identifiers.status === 'ready' ? snapshot.identifiers.value.items : [];
  const contactRows = customerContactRows(contacts);
  const identifierRows = customerIdentifierRows(
    identifiers,
    snapshot === undefined ? '' : DateTime.formatIso(snapshot.now),
  );
  const history = customerHistoryRows(contacts, identifiers);
  return {
    busy,
    changeDraft,
    contactRows,
    confirmDiscard,
    history,
    identifierRows,
    dirty,
    discardOpen,
    draft,
    evidence,
    identity,
    notice,
    party,
    reason,
    refresh,
    requestClose,
    requestNavigation,
    save,
    setDiscardOpen,
    setEvidence,
    setReason,
    snapshot,
    stale,
    value,
  };
};

/** The latest opening owns its response, including rapidly reopening the same customer. */
export const useCustomerDetailSelection = () => {
  const [detail, setDetail] = useState<CustomerListItem | null>(null);
  const [detailSnapshot, setDetailSnapshot] = useState<CustomerDetailLoadState>();
  const request = useRef(0);
  const openDetail = (customer: CustomerListItem) => {
    request.current += 1;
    const opening = request.current;
    setDetail(customer);
    setDetailSnapshot({ id: customer.counterpartyId });
    loadCustomerDetailInto(customer, (next) => {
      if (request.current === opening) {
        setDetailSnapshot(next);
      }
    });
  };
  const retryDetail = () => {
    if (detail !== null) {
      openDetail(detail);
    }
  };
  const closeDetail = (open: boolean) => {
    if (!open) {
      request.current += 1;
      setDetail(null);
      setDetailSnapshot(undefined);
    }
  };
  return {
    closeDetail,
    detail,
    detailFailure: detailSnapshot?.failure,
    detailValue: detailSnapshot?.value,
    openDetail,
    retryDetail,
  };
};

export const loadCustomerDuplicateQueue = (afterCaseRef?: DuplicateCandidateCaseRef) =>
  correlation('duplicate-list').pipe(
    Effect.flatMap((id) => executeDuplicateCandidateList(afterCaseRef === undefined ? {} : { afterCaseRef }, id)),
  );

export const loadCustomerDuplicateDetail = Effect.fn('CustomersData.loadDuplicate')(function* loadDuplicate(
  caseRef: DuplicateCandidateCaseRef,
) {
  const id = yield* correlation('duplicate-detail');
  const candidateCase = yield* executeDuplicateCandidateDetail({ caseRef }, id);
  const parties = yield* Effect.forEach(
    candidateCase.candidateParties,
    (partyRef) =>
      Effect.all(
        {
          identity: section(executePartyDetail({ partyRef }, id)),
          contacts: section(executePartyContactPoints({ includeHistorical: false, partyRef }, id)),
        },
        { concurrency: 1 },
      ).pipe(Effect.map((value) => ({ ...value, partyRef }))),
    { concurrency: 2 },
  );
  return { candidateCase, parties };
});
type CustomerDuplicateDetail = Effect.Success<ReturnType<typeof loadCustomerDuplicateDetail>>;
export type CustomerDuplicateResolution = Exclude<
  DuplicateCaseResolutionResult['outcome'],
  'CONFIRMED_DUPLICATE_PARTIES'
>;
interface CustomerDuplicateAttempt {
  readonly caseRef: DuplicateCandidateCaseRef;
  readonly expectedRevision: number;
  readonly reason: string;
  readonly id: string;
  readonly resolution: CustomerDuplicateResolution;
  readonly selectedPartyRef: PartyRef | undefined;
}

const duplicateActionKeys = {
  MATCH_EXISTING: 'party.registry.resolve-duplicate-candidate-match',
  CREATE_NEW: 'party.registry.resolve-duplicate-candidate-create',
  NEEDS_EVIDENCE: 'party.registry.mark-duplicate-candidate-needs-evidence',
  DISMISSED_AS_NON_SUBJECT: 'party.registry.dismiss-duplicate-candidate',
} as const;

/** Resolution never creates a Counterparty, merges Parties, or bypasses the owner's canonical recheck. */
export const resolveCustomerDuplicate = Effect.fn('CustomersData.resolveDuplicate')(function* resolveDuplicate(
  attempt: CustomerDuplicateAttempt,
) {
  const payload = yield* Schema.decodeEffect(DuplicateCaseResolutionPayloadSchema)(attempt);
  const options = { correlationId: attempt.id, idempotencyKey: attempt.id };
  return yield* Match.value(attempt.resolution).pipe(
    Match.when('MATCH_EXISTING', () =>
      Schema.decodeUnknownEffect(ResolveDuplicateCandidateMatchPayloadSchema)({
        ...payload,
        selectedPartyRef: attempt.selectedPartyRef,
      }).pipe(Effect.flatMap((matchPayload) => resolveDuplicateCandidateMatch(matchPayload, options))),
    ),
    Match.when('CREATE_NEW', () => resolveDuplicateCandidateCreate(payload, options)),
    Match.when('NEEDS_EVIDENCE', () => markDuplicateCandidateNeedsEvidence(payload, options)),
    Match.when('DISMISSED_AS_NON_SUBJECT', () => dismissDuplicateCandidate(payload, options)),
    Match.exhaustive,
  );
});

type DuplicateFailure = Effect.Error<
  | ReturnType<typeof loadCustomerDuplicateQueue>
  | ReturnType<typeof loadCustomerDuplicateDetail>
  | ReturnType<typeof resolveCustomerDuplicate>
  | ReturnType<typeof resolvePartyCommandCommit>
>;
export const customerDuplicateFailureKey = (failure: DuplicateFailure) => {
  if (Schema.is(Schema.Struct({ status: Schema.Literal(401) }))(failure)) {
    return 'authentication';
  }
  if (Schema.is(Schema.Struct({ status: Schema.Literal(404) }))(failure)) {
    return 'notFound';
  }
  if (Schema.is(Schema.Struct({ status: Schema.Literal(403) }))(failure)) {
    return 'forbidden';
  }
  if (Schema.is(Schema.Struct({ status: Schema.Literal(409) }))(failure)) {
    return 'conflict';
  }
  if (
    Schema.is(Schema.Struct({ status: Schema.Literals([400, 422]) }))(failure) ||
    Predicate.isTagged(failure, 'SchemaError')
  ) {
    return 'validation';
  }
  return 'unavailable';
};
type DuplicateFailureKey = ReturnType<typeof customerDuplicateFailureKey>;
type DuplicateRead<Value> =
  | { readonly status: 'idle' | 'loading' }
  | { readonly status: 'failed'; readonly failure: DuplicateFailureKey }
  | { readonly status: 'ready'; readonly value: Value };

const duplicateReadState = <Value, Failure extends DuplicateFailure>(operation: Effect.Effect<Value, Failure>) =>
  operation.pipe(
    Effect.match({
      onFailure: (failure): DuplicateRead<Value> => ({
        failure: customerDuplicateFailureKey(failure),
        status: 'failed',
      }),
      onSuccess: (value): DuplicateRead<Value> => ({ status: 'ready', value }),
    }),
  );

/** User-opened review state. Request generations prevent an old selection from replacing the current case. */
export const useCustomerIdentityReview = (onResolved: () => void) => {
  const [open, setOpen] = useState(false);
  const [queue, setQueue] = useState<DuplicateRead<DuplicateCandidateListResponse>>({ status: 'idle' });
  const [detail, setDetail] = useState<DuplicateRead<CustomerDuplicateDetail>>({ status: 'idle' });
  const [selectedPartyId, setSelectedPartyId] = useState('');
  const [reason, setReason] = useState('');
  const [notice, setNotice] = useState<{ readonly key: string; readonly success: boolean }>();
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  const [committed, setCommitted] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const queueRequest = useRef(0);
  const detailRequest = useRef(0);
  const caseSelection = useRef<DuplicateCandidateCaseRef | null>(null);
  const writing = useRef(false);
  const pending = useRef<CustomerDuplicateAttempt | null>(null);

  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if (busy || uncertain) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    globalThis.addEventListener('beforeunload', guard);
    return () => globalThis.removeEventListener('beforeunload', guard);
  }, [busy, uncertain]);
  useEffect(
    () => () => {
      queueRequest.current += 1;
      detailRequest.current += 1;
    },
    [],
  );

  const loadQueue = (afterCaseRef?: DuplicateCandidateCaseRef) => {
    if (writing.current || pending.current !== null) {
      return;
    }
    queueRequest.current += 1;
    const request = queueRequest.current;
    setQueue({ status: 'loading' });
    void browserRuntime.runPromise(
      loadCustomerDuplicateQueue(afterCaseRef).pipe(
        Effect.match({
          onFailure: (failure) => {
            if (queueRequest.current === request) {
              setQueue({ status: 'failed', failure: customerDuplicateFailureKey(failure) });
            }
          },
          onSuccess: (value) => {
            if (queueRequest.current === request) {
              setQueue({ status: 'ready', value });
            }
          },
        }),
      ),
    );
  };
  const selectCase = (caseRef: DuplicateCandidateCaseRef) => {
    if (writing.current || pending.current !== null) {
      return;
    }
    detailRequest.current += 1;
    const request = detailRequest.current;
    caseSelection.current = caseRef;
    setDetail({ status: 'loading' });
    setSelectedPartyId('');
    setReason('');
    setNotice(undefined);
    setStale(false);
    setCommitted(false);
    void browserRuntime.runPromise(
      loadCustomerDuplicateDetail(caseRef).pipe(
        Effect.match({
          onFailure: (failure) => {
            if (detailRequest.current === request) {
              setDetail({ status: 'failed', failure: customerDuplicateFailureKey(failure) });
            }
          },
          onSuccess: (value) => {
            if (detailRequest.current === request) {
              setDetail({ status: 'ready', value });
            }
          },
        }),
      ),
    );
  };

  const refreshAfterSaved = () =>
    Effect.sync(() => {
      pending.current = null;
      setUncertain(false);
      setCommitted(true);
      setQueue({ status: 'loading' });
      setDetail({ status: 'loading' });
      onResolved();
    }).pipe(
      // Each governed read keeps its own outcome: a denied queue must not leave old rows visible,
      // and a failed detail read must not discard a successfully refreshed queue.
      Effect.andThen(
        Effect.all(
          {
            queue: duplicateReadState(loadCustomerDuplicateQueue()),
            detail:
              caseSelection.current === null
                ? Effect.succeed<DuplicateRead<CustomerDuplicateDetail>>({ status: 'idle' })
                : duplicateReadState(loadCustomerDuplicateDetail(caseSelection.current)),
          },
          { concurrency: 2 },
        ),
      ),
      Effect.flatMap((next) =>
        Effect.sync(() => {
          setQueue(next.queue);
          setDetail(next.detail);
          const failed = next.queue.status === 'failed' || next.detail.status === 'failed';
          setStale(failed);
          setNotice({ key: failed ? 'savedReloadFailed' : 'saved', success: true });
        }),
      ),
    );
  const executeAttempt = (attempt: CustomerDuplicateAttempt) =>
    resolveCustomerDuplicate(attempt).pipe(
      Effect.matchEffect({
        onSuccess: refreshAfterSaved,
        onFailure: (failure) => {
          if (Predicate.isTagged(failure, 'PartyCommandAlreadyCommittedProblem')) {
            return refreshAfterSaved();
          }
          return Effect.sync(() => {
            const key = customerDuplicateFailureKey(failure);
            if (key === 'unavailable') {
              // A lost acknowledgement is not permission to issue a fresh command.
              setUncertain(true);
              setNotice({ key: 'uncertain', success: false });
            } else {
              pending.current = null;
              setUncertain(false);
              setStale(key === 'conflict' || key === 'notFound');
              setNotice({ key, success: false });
            }
          });
        },
      }),
    );
  const finishWrite = () => {
    writing.current = false;
    setBusy(false);
  };
  const canResolve =
    detail.status === 'ready' &&
    ['OPEN', 'NEEDS_EVIDENCE'].includes(detail.value.candidateCase.lifecycleState) &&
    !busy &&
    !stale &&
    !committed &&
    !uncertain;
  const resolve = (resolution: CustomerDuplicateResolution) => {
    if (writing.current || !canResolve || detail.status !== 'ready') {
      return;
    }
    const selected = detail.value.parties.find((item) => item.partyRef.resourceId === selectedPartyId);
    if (
      reason.trim() === '' ||
      (resolution === 'MATCH_EXISTING' &&
        (selected?.identity.status !== 'ready' ||
          selected.identity.value.resolution.kind !== 'DIRECT' ||
          Option.isSome(selected.identity.value.party.archivedAt)))
    ) {
      setNotice({ key: 'validation', success: false });
      return;
    }
    writing.current = true;
    queueRequest.current += 1;
    detailRequest.current += 1;
    setBusy(true);
    setNotice(undefined);
    const { candidateCase } = detail.value;
    void browserRuntime.runPromise(
      correlation('duplicate-resolve').pipe(
        Effect.flatMap((id) => {
          const attempt: CustomerDuplicateAttempt = {
            caseRef: candidateCase.caseRef,
            expectedRevision: candidateCase.revision,
            id,
            reason: reason.trim(),
            resolution,
            selectedPartyRef: selected?.partyRef,
          };
          pending.current = attempt;
          return executeAttempt(attempt);
        }),
        Effect.ensuring(Effect.sync(finishWrite)),
      ),
    );
  };
  const checkStatus = () => {
    const attempt = pending.current;
    if (writing.current || attempt === null) {
      return;
    }
    writing.current = true;
    setBusy(true);
    void browserRuntime.runPromise(
      resolvePartyCommandCommit(
        {
          actionKey: duplicateActionKeys[attempt.resolution],
          idempotencyKey: attempt.id,
        },
        { correlationId: attempt.id },
      ).pipe(
        Effect.matchEffect({
          onFailure: (failure) =>
            Effect.sync(() => setNotice({ key: customerDuplicateFailureKey(failure), success: false })),
          onSuccess: (resolution) => {
            if (resolution.state === 'COMMITTED') {
              return refreshAfterSaved();
            }
            if (resolution.retryCommand) {
              return executeAttempt(attempt);
            }
            return Effect.sync(() => {
              if (resolution.state === 'REJECTED') {
                pending.current = null;
                setUncertain(false);
                setNotice({ key: 'forbidden', success: false });
              } else {
                setNotice({ key: 'uncertain', success: false });
              }
            });
          },
        }),
        Effect.ensuring(Effect.sync(finishWrite)),
      ),
    );
  };
  return {
    busy,
    canResolve,
    checkStatus,
    committed,
    detail,
    loading: queue.status === 'loading' || detail.status === 'loading',
    loadQueue,
    notice,
    open,
    queue,
    reason,
    resolve,
    selectedPartyId,
    setReason,
    setSelectedPartyId,
    stale,
    uncertain,
    openReview: () => {
      setOpen(true);
      if (queue.status === 'idle') {
        loadQueue();
      }
    },
    closeReview: (next: boolean) => {
      if (!writing.current) {
        setOpen(next);
      }
    },
    selectCase,
    refreshDetail: () => {
      if (caseSelection.current !== null) {
        selectCase(caseSelection.current);
      }
    },
  };
};
