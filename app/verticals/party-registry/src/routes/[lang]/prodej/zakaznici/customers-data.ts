import { useEffect, useRef, useState } from 'react';
import { DateTime, Effect, Match, Option, Predicate, Random, Ref, Schema } from 'effect';

import { executeAresLookup } from '../../../../api/ares-lookup-client.ts';
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

export interface CustomersSnapshot {
  readonly items: readonly CustomerListItem[];
  readonly nowMillis: number;
}

const correlation = (operation: string) =>
  Effect.map(
    Effect.all([Random.nextInt, Random.nextInt], { concurrency: 1 }),
    ([first, second]) => `party-registry:${operation}:${first}:${second}`,
  );

/** Every current customer, archived included so the Archivovaní stat is real. */
export const loadCustomers = Effect.all(
  {
    items: listCustomers({ includeArchived: true, limit: 500 }),
    now: DateTime.now,
  },
  { concurrency: 1 },
).pipe(Effect.map(({ items, now }): CustomersSnapshot => ({ items, nowMillis: DateTime.toEpochMillis(now) })));

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
