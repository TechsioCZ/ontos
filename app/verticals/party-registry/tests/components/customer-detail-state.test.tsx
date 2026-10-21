import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, rstest } from 'effect-rstest';
import { DateTime, Deferred, Effect, Exit, Option, Schema } from 'effect';
import { CustomerListItemSchema } from '../../shared/apis/customer-list.ts';
import {
  CounterpartyReadForbiddenProblemSchema,
  CounterpartyReadResponseSchema,
} from '../../shared/apis/counterparty-read.ts';
import { PartyDetailForbiddenProblemSchema } from '../../shared/apis/party-detail.ts';
import { PartySchema } from '../../shared/domain/identity-contracts.ts';
import { PartyCommandConflictProblemSchema, PartyCommandForbiddenProblemSchema } from '../../shared/command-api.ts';
import { executeCounterpartyRead } from '../../src/api/counterparty-read-client.ts';
import { executePartyDetail } from '../../src/api/party-detail-client.ts';
import { executePartyContactPoints } from '../../src/api/party-contact-points-client.ts';
import { executePartyOfficialIdentifierHistory } from '../../src/api/party-official-identifier-history-client.ts';
import { updateParty } from '../../src/api/party-command-client.ts';
import { loadCustomerDetail, useCustomerDetail } from '../../src/routes/[lang]/prodej/zakaznici/customers-data.ts';
import { relatedCustomerUrl } from '../../src/routes/[lang]/prodej/zakaznici/customers-model.ts';
import type { CustomerDetailSnapshot } from '../../src/routes/[lang]/prodej/zakaznici/customers-data.ts';

rstest.mock('../../src/api/party-command-client.ts');
rstest.mock('../../src/api/counterparty-read-client.ts');
rstest.mock('../../src/api/party-detail-client.ts');
rstest.mock('../../src/api/party-contact-points-client.ts');
rstest.mock('../../src/api/party-official-identifier-history-client.ts');

const tenantId = '10000000-0000-4000-8000-000000000001';
const partyId = '40000000-0000-4000-8000-000000000001';
const counterpartyId = '30000000-0000-4000-8000-000000000001';
const instant = '2026-10-15T10:00:00.000Z';
const partyRef = {
  moduleId: 'party.registry' as const,
  resourceId: partyId,
  resourceType: 'party.registry.party' as const,
  tenantId,
};
const counterpartyRef = {
  moduleId: 'party.registry' as const,
  resourceId: counterpartyId,
  resourceType: 'party.registry.counterparty' as const,
  tenantId,
};
const customer = Schema.decodeSync(CustomerListItemSchema)({
  city: null,
  companyId: null,
  counterpartyId,
  counterpartyRef,
  createdAt: instant,
  displayName: 'Before',
  email: null,
  partyId,
  partyRef,
  partyRevision: 1,
  phone: null,
  status: 'ACTIVE',
  vatId: null,
});
const party = Schema.decodeSync(PartySchema)({
  archivedAt: null,
  createdAt: instant,
  displayName: 'Before',
  partyRef,
  partyType: 'ORGANIZATION',
  revision: 1,
  updatedAt: instant,
});
const snapshot: CustomerDetailSnapshot = {
  contacts: { status: 'ready', value: { items: [] } },
  counterparty: Schema.decodeSync(CounterpartyReadResponseSchema)({
    counterpartyRef,
    createdAt: instant,
    currentRoles: [],
    legalEntityRef: {
      moduleId: 'core.identity',
      resourceId: '60000000-0000-4000-8000-000000000001',
      resourceType: 'core.identity.legal-entity',
      tenantId,
    },
    party: {
      archived: false,
      canonicalPartyRef: partyRef,
      displayName: 'Before',
      partyType: 'ORGANIZATION',
      storedPartyRef: partyRef,
    },
  }),
  identifiers: { status: 'ready', value: { items: [] } },
  identity: {
    status: 'ready',
    value: {
      currentFactAssertions: [],
      factHistory: Option.none(),
      party,
      resolution: { aliasChain: [], canonicalPartyRef: partyRef, kind: 'DIRECT', requestedPartyRef: partyRef },
    },
  },
  now: DateTime.makeUnsafe(instant),
};
const close = rstest.fn();
const saved = rstest.fn();
const changed = rstest.fn();
const navigate = rstest.fn();
const translate = (key: string) => key;
const useDetail = () =>
  useCustomerDetail(
    customer,
    snapshot,
    (open) => {
      close(open);
    },
    () => {
      changed();
    },
    () => {
      saved();
    },
    translate,
    (href) => {
      navigate(href);
    },
  );
const afterParty = { ...party, displayName: Option.some('After'), revision: 2 };

beforeEach(() => {
  rstest.clearAllMocks();
  rstest.mocked(executeCounterpartyRead).mockReturnValue(Effect.succeed(snapshot.counterparty));
  if (snapshot.identity.status === 'ready') {
    rstest
      .mocked(executePartyDetail)
      .mockReturnValue(Effect.succeed({ ...snapshot.identity.value, party: afterParty }));
  }
  rstest.mocked(executePartyContactPoints).mockReturnValue(Effect.succeed({ items: [] }));
  rstest.mocked(executePartyOfficialIdentifierHistory).mockReturnValue(Effect.succeed({ items: [] }));
  rstest.mocked(updateParty).mockReturnValue(Effect.succeed(afterParty));
});
afterEach(cleanup);

const prepare = (model: ReturnType<typeof useDetail>) => {
  model.changeDraft('name', 'After', 'Before');
  model.changeDraft('new-EMAIL-value', 'pending@example.cz');
  model.setReason('Reviewed document');
  model.setEvidence('document:42');
};

it.effect('a confirmed section refreshes its revision and keeps unrelated drafts open', () =>
  Effect.gen(function* confirmedSection() {
    const { result } = renderHook(useDetail);
    act(() => prepare(result.current));
    act(() => result.current.save({ kind: 'name', party, value: 'After' }, ['name']));
    yield* Effect.promise(() => waitFor(() => expect(saved).toHaveBeenCalledTimes(1)));
    yield* Effect.promise(() => waitFor(() => expect(result.current.busy).toBe(false)));
    expect(result.current.party?.revision).toBe(2);
    expect(result.current.draft).toEqual({ 'new-EMAIL-value': 'pending@example.cz' });
    act(() => result.current.requestClose(false));
    expect(result.current.discardOpen).toBe(true);
    expect(close).not.toHaveBeenCalled();
  }),
);

it.effect('a revision conflict preserves the draft and requires a reload before another write', () =>
  Effect.gen(function* revisionConflict() {
    const failure = yield* Schema.decodeEffect(PartyCommandConflictProblemSchema)({
      _tag: 'PartyCommandConflictProblem',
      code: 'party_lifecycle_conflict',
      detail: 'Revision changed',
      status: 409,
      title: 'Conflict',
      type: 'urn:test:conflict',
    });
    rstest.mocked(updateParty).mockReturnValue(Effect.fail(failure));
    const { result } = renderHook(useDetail);
    act(() => prepare(result.current));
    act(() => result.current.save({ kind: 'name', party, value: 'After' }, ['name']));
    yield* Effect.promise(() => waitFor(() => expect(result.current.stale).toBe(true)));
    expect(result.current.draft['name']).toBe('After');
    act(() => result.current.save({ kind: 'name', party, value: 'After' }, ['name']));
    expect(updateParty).toHaveBeenCalledTimes(1);
    expect(saved).not.toHaveBeenCalled();
  }),
);

it.effect('a denied write keeps every draft and reports permission refusal', () =>
  Effect.gen(function* deniedWrite() {
    const failure = yield* Schema.decodeEffect(PartyCommandForbiddenProblemSchema)({
      _tag: 'PartyCommandForbiddenProblem',
      detail: 'Denied',
      status: 403,
      title: 'Forbidden',
      type: 'urn:test:forbidden',
    });
    rstest.mocked(updateParty).mockReturnValue(Effect.fail(failure));
    const { result } = renderHook(useDetail);
    act(() => prepare(result.current));
    act(() => result.current.save({ kind: 'name', party, value: 'After' }, ['name']));
    yield* Effect.promise(() =>
      waitFor(() => expect(result.current.notice).toBe('party-registry.pages.customers.detail.forbidden')),
    );
    expect(result.current.draft['name']).toBe('After');
    expect(saved).not.toHaveBeenCalled();
  }),
);

it.effect('a commercial-context denial stops broader identity and contact reads before they start', () =>
  Effect.gen(function* commercialDenied() {
    const failure = yield* Schema.decodeEffect(CounterpartyReadForbiddenProblemSchema)({
      _tag: 'CounterpartyReadForbiddenProblem',
      detail: 'Denied context',
      status: 403,
      title: 'Forbidden',
      type: 'urn:test:forbidden',
    });
    rstest.mocked(executeCounterpartyRead).mockReturnValue(Effect.fail(failure));
    const result = yield* Effect.exit(loadCustomerDetail(customer));
    expect(Exit.isFailure(result)).toBe(true);
    expect(executePartyDetail).not.toHaveBeenCalled();
    expect(executePartyContactPoints).not.toHaveBeenCalled();
  }),
);

it.effect(
  'a tenant Party-read denial keeps the authorized Counterparty summary without broadening its projection',
  () =>
    Effect.gen(function* identityDenied() {
      const failure = yield* Schema.decodeEffect(PartyDetailForbiddenProblemSchema)({
        _tag: 'PartyDetailForbiddenProblem',
        detail: 'Denied identity',
        status: 403,
        title: 'Forbidden',
        type: 'urn:test:forbidden',
      });
      rstest.mocked(executePartyDetail).mockReturnValue(Effect.fail(failure));
      const result = yield* loadCustomerDetail(customer);
      expect(result.counterparty).toEqual(snapshot.counterparty);
      expect(result.identity).toEqual({ status: 'forbidden' });
      expect(result.counterparty.party).not.toHaveProperty('officialIdentifiers');
    }),
);

it.effect('a committed section is never resubmitted when its refresh fails', () =>
  Effect.gen(function* committedReloadFailure() {
    const failure = yield* Schema.decodeEffect(CounterpartyReadForbiddenProblemSchema)({
      _tag: 'CounterpartyReadForbiddenProblem',
      detail: 'Access revoked',
      status: 403,
      title: 'Forbidden',
      type: 'urn:test:forbidden',
    });
    rstest.mocked(executeCounterpartyRead).mockReturnValue(Effect.fail(failure));
    const { result } = renderHook(useDetail);
    act(() => prepare(result.current));
    act(() => result.current.save({ kind: 'name', party, value: 'After' }, ['name']));
    yield* Effect.promise(() => waitFor(() => expect(result.current.stale).toBe(true)));
    expect(saved).toHaveBeenCalledTimes(1);
    expect(result.current.draft).toEqual({ 'new-EMAIL-value': 'pending@example.cz' });
    act(() => result.current.save({ kind: 'name', party, value: 'After' }, ['name']));
    expect(updateParty).toHaveBeenCalledTimes(1);
  }),
);

it('keeps a dirty draft when related navigation is cancelled and confirms only the latest intended URL', () => {
  const { result } = renderHook(useDetail);
  const opportunityUrl = relatedCustomerUrl('cs', '/prodej/prilezitosti', customer, false);
  const invoiceUrl = relatedCustomerUrl('cs', '/finance', customer, true);
  act(() => result.current.changeDraft('new-PHONE-value', '+420123456789'));
  act(() => result.current.requestNavigation(opportunityUrl));
  expect(result.current.discardOpen).toBe(true);
  expect(navigate).not.toHaveBeenCalled();
  act(() => result.current.setDiscardOpen(false));
  expect(result.current.draft['new-PHONE-value']).toBe('+420123456789');
  act(() => result.current.confirmDiscard());
  expect(navigate).not.toHaveBeenCalled();
  act(() => result.current.requestNavigation(invoiceUrl));
  act(() => result.current.confirmDiscard());
  expect(navigate).toHaveBeenCalledExactlyOnceWith(invoiceUrl);
  expect(invoiceUrl).toContain(`counterpartyId=${counterpartyId}`);
  expect(invoiceUrl).toContain(`tenantId=${tenantId}`);
  expect(close).not.toHaveBeenCalled();
});

it('navigates directly only when the customer editor is clean', () => {
  const { result } = renderHook(useDetail);
  const href = relatedCustomerUrl('cs', '/ukoly', customer, false);
  act(() => result.current.requestNavigation(href));
  expect(navigate).toHaveBeenCalledExactlyOnceWith(href);
  expect(result.current.discardOpen).toBe(false);
});

it.effect('blocks related navigation and document unload during an unfinished save', () =>
  Effect.gen(function* busyNavigation() {
    const pending = yield* Deferred.make<typeof party>();
    rstest.mocked(updateParty).mockReturnValue(Deferred.await(pending));
    const { result } = renderHook(useDetail);
    act(() => prepare(result.current));
    act(() => result.current.save({ kind: 'name', party, value: 'After' }, ['name']));
    expect(result.current.busy).toBe(true);
    act(() => result.current.requestNavigation('/cs/prodej/prilezitosti?partyId=blocked'));
    expect(navigate).not.toHaveBeenCalled();
    expect(result.current.discardOpen).toBe(false);
    const unload = new Event('beforeunload', { cancelable: true });
    globalThis.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    yield* Deferred.succeed(pending, afterParty);
    yield* Effect.promise(() => waitFor(() => expect(result.current.busy).toBe(false)));
  }),
);

it('protects document unload while dirty, grants one confirmed navigation, and removes the guard on unmount', () => {
  const { result, unmount } = renderHook(useDetail);
  const clean = new Event('beforeunload', { cancelable: true });
  globalThis.dispatchEvent(clean);
  expect(clean.defaultPrevented).toBe(false);
  act(() => result.current.changeDraft('new-PHONE-value', '+420123456789'));
  const dirty = new Event('beforeunload', { cancelable: true });
  globalThis.dispatchEvent(dirty);
  expect(dirty.defaultPrevented).toBe(true);
  act(() => result.current.requestNavigation('/cs/ukoly?partyId=confirmed'));
  act(() => result.current.confirmDiscard());
  const confirmed = new Event('beforeunload', { cancelable: true });
  globalThis.dispatchEvent(confirmed);
  expect(confirmed.defaultPrevented).toBe(false);
  const another = new Event('beforeunload', { cancelable: true });
  globalThis.dispatchEvent(another);
  expect(another.defaultPrevented).toBe(true);
  unmount();
  const afterUnmount = new Event('beforeunload', { cancelable: true });
  globalThis.dispatchEvent(afterUnmount);
  expect(afterUnmount.defaultPrevented).toBe(false);
});
