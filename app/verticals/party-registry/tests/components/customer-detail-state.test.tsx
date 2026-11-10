import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, rstest } from 'effect-rstest';
import { DateTime, Effect, Option, Schema } from 'effect';
import { CustomerListItemSchema } from '../../shared/apis/customer-list.ts';
import { CounterpartyReadResponseSchema } from '../../shared/apis/counterparty-read.ts';
import { PartySchema } from '../../shared/domain/identity-contracts.ts';
import { executeCounterpartyRead } from '../../src/api/counterparty-read-client.ts';
import { executePartyDetail } from '../../src/api/party-detail-client.ts';
import { executePartyContactPoints } from '../../src/api/party-contact-points-client.ts';
import { executePartyOfficialIdentifierHistory } from '../../src/api/party-official-identifier-history-client.ts';
import { updateParty } from '../../src/api/party-command-client.ts';
import type { CustomerDetailSnapshot } from '../../src/routes/[lang]/prodej/zakaznici/customers-data.ts';
import { CustomerDetailDialog } from '../../src/routes/[lang]/prodej/zakaznici/customer-detail-dialog.tsx';
import { expectHumanReadable } from '../support/visible-text.ts';

rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({ language: 'cs', t: (key: string) => key }),
}));
/** The router's blocker: `shouldBlock` is what the panel asks it to block on, `status` what the router answers. */
interface Navigation {
  readonly proceed: () => void;
  readonly reset: () => void;
  shouldBlock: () => boolean;
  status: 'blocked' | 'idle';
}
const { navigation } = rstest.hoisted(() => {
  const state: Navigation = {
    proceed: rstest.fn<() => void>(),
    reset: rstest.fn<() => void>(),
    shouldBlock: () => false,
    status: 'idle',
  };
  return { navigation: state };
});
rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  useBlocker: (options: { readonly shouldBlockFn: () => boolean }) => {
    navigation.shouldBlock = options.shouldBlockFn;
    return { proceed: navigation.proceed, reset: navigation.reset, status: navigation.status };
  },
  useRouterState: () => '/cs/prodej/zakaznici',
}));

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
  businessName: 'Before',
  createdAt: instant,
  displayName: 'Before',
  firstName: null,
  lastName: null,
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
      party,
      resolution: { aliasChain: [], canonicalPartyRef: partyRef, kind: 'DIRECT', requestedPartyRef: partyRef },
    },
  },
  now: DateTime.makeUnsafe(instant),
};
const close = rstest.fn();
const saved = rstest.fn();
const afterParty = { ...party, displayName: Option.some('After'), revision: 2 };

beforeEach(() => {
  rstest.clearAllMocks();
  navigation.status = 'idle';
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

const detailDialog = (value?: CustomerDetailSnapshot) => (
  <CustomerDetailDialog
    customer={customer}
    onOpenChange={(open) => {
      close(open);
    }}
    onRenamed={() => {
      saved();
    }}
    onRetry={() => {
      saved();
    }}
    snapshot={value}
  />
);
const fieldById = <T extends HTMLElement>(id: string) => {
  const element = document.querySelector<T>(`[id="${id}"]`);
  if (element === null) {
    throw new Error(`missing field ${id}`);
  }
  return element;
};
const reasonField = () => fieldById<HTMLInputElement>('customer-reason');
const nameField = () => fieldById<HTMLInputElement>('customer-rename');
const saveButton = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Uložit' });
const fillBasis = () => {
  fireEvent.change(fieldById<HTMLInputElement>('customer-evidence'), { target: { value: 'document:42' } });
  fireEvent.change(reasonField(), { target: { value: 'Reviewed document' } });
};

it('shows the customer name without exposing party or business-context identifiers', () => {
  render(detailDialog(snapshot));
  expect(screen.getByRole('heading', { name: 'Before' })).toBeTruthy();
  expect(document.body.textContent).not.toContain(partyId);
  expect(document.body.textContent).not.toContain(counterpartyId);
  expectHumanReadable();
});

it('keeps the typed reason when the same customer snapshot passes through a loading refresh', () => {
  const { rerender } = render(detailDialog(snapshot));
  fireEvent.change(reasonField(), { target: { value: 'Reviewed document' } });
  rerender(detailDialog());
  rerender(detailDialog(snapshot));
  expect(reasonField().value).toBe('Reviewed document');
});

it.live('typing and waiting write nothing until the one Save button is pressed', () =>
  Effect.gen(function* explicitSave() {
    render(detailDialog(snapshot));
    fillBasis();
    fireEvent.change(nameField(), { target: { value: 'After' } });
    yield* Effect.sleep('1 second');
    expect(updateParty).not.toHaveBeenCalled();
    expect(saveButton().disabled).toBe(false);
    fireEvent.click(saveButton());
    yield* Effect.promise(() => waitFor(() => expect(updateParty).toHaveBeenCalledTimes(1)));
    // Saved: the detail re-reads the owner's version, which the clean draft then shows.
    yield* Effect.promise(() =>
      waitFor(() =>
        expect(['idle', 'saved']).toContain(
          document.querySelector<HTMLElement>('[data-save-state]')?.dataset['saveState'],
        ),
      ),
    );
    expect(saveButton().disabled).toBe(true);
    expect(updateParty).toHaveBeenCalledTimes(1);
  }),
);

it.live('an empty name leaves Save disabled and writes nothing', () =>
  Effect.gen(function* invalidDraft() {
    render(detailDialog(snapshot));
    fillBasis();
    fireEvent.change(nameField(), { target: { value: '' } });
    yield* Effect.sleep('1 second');
    expect(saveButton().disabled).toBe(true);
    expect(updateParty).not.toHaveBeenCalled();
  }),
);

it.live('closing with unsaved text asks first and leaving discards without writing', () =>
  Effect.gen(function* leaveAsks() {
    render(detailDialog(snapshot));
    fillBasis();
    fireEvent.change(nameField(), { target: { value: 'After' } });
    fireEvent.click(screen.getByRole('button', { name: 'party-registry.pages.customers.detail.cancel' }));
    expect(close).not.toHaveBeenCalled();
    yield* Effect.promise(() => waitFor(() => expect(screen.getByRole('button', { name: 'Zůstat' })).toBeTruthy()));
    fireEvent.click(screen.getByRole('button', { name: 'Zahodit změny' }));
    yield* Effect.sleep('1 second');
    expect(close).toHaveBeenCalledWith(false);
    expect(updateParty).not.toHaveBeenCalled();
  }),
);

it.live('a route change from the peek panel with unsaved text asks first; Zůstat keeps the draft', () =>
  Effect.gen(function* routeChangeAsks() {
    const { rerender } = render(detailDialog(snapshot));
    expect(navigation.shouldBlock()).toBe(false);
    fillBasis();
    fireEvent.change(nameField(), { target: { value: 'After' } });
    yield* Effect.promise(() => waitFor(() => expect(navigation.shouldBlock()).toBe(true)));
    // A Shell link next to the peek panel: the router holds the navigation and the panel asks.
    navigation.status = 'blocked';
    rerender(detailDialog(snapshot));
    yield* Effect.promise(() => waitFor(() => expect(screen.getByRole('button', { name: 'Zůstat' })).toBeTruthy()));
    fireEvent.click(screen.getByRole('button', { name: 'Zůstat' }));
    expect(navigation.reset).toHaveBeenCalledTimes(1);
    expect(navigation.proceed).not.toHaveBeenCalled();
    expect(nameField().value).toBe('After');
    expect(updateParty).not.toHaveBeenCalled();
  }),
);
