import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, rstest } from 'effect-rstest';
import { DateTime, Deferred, Effect, Option, Schema } from 'effect';

import { PartyDetailResponseSchema } from '../../shared/apis/party-detail.ts';
import type { PartyRef } from '../../shared/resources/party.ts';
import type {
  PartyIdentityReadyInput,
  PartyIdentityReaders,
  PartyIdentityReadView,
  PartyIdentityView,
  PartyContactView,
  PartyIdentifierView,
} from '../../src/routes/[lang]/prodej/strany/[partyId]/party-identity-data.ts';
import { usePartyIdentityRead } from '../../src/routes/[lang]/prodej/strany/[partyId]/party-identity-read.ts';
import { PartyIdentityPageView } from '../../src/routes/[lang]/prodej/strany/[partyId]/party-identity-view.tsx';
import { routeMeta } from '../../src/routes/[lang]/prodej/strany/[partyId]/route.meta.ts';
import { expectHumanReadable } from '../support/visible-text.ts';

rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({ language: 'cs', t: (key: string) => key }),
}));
rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  useNavigate: () => rstest.fn(),
  useParams: () => ({ partyId: '40000000-0000-4000-8000-000000000001' }),
  useRouterState: () => '/cs/prodej/strany/40000000-0000-4000-8000-000000000001',
}));

const tenantId = '10000000-0000-4000-8000-000000000001';
const partyId = '40000000-0000-4000-8000-000000000001';
const otherPartyId = '40000000-0000-4000-8000-000000000002';
const instant = '2026-10-15T10:00:00.000Z';
const partyRef = {
  moduleId: 'party.registry',
  resourceId: partyId,
  resourceType: 'party.registry.party',
  tenantId,
} as const;
const otherPartyRef = { ...partyRef, resourceId: otherPartyId } as const;
const context = {
  displayName: 'Staff',
  legalEntityId: '70000000-0000-4000-8000-000000000001',
  principalId: '80000000-0000-4000-8000-000000000001',
  tenantId,
} as const;
const readyInput: PartyIdentityReadyInput = { context, partyId, partyRef, status: 'ready' };
const otherInput: PartyIdentityReadyInput = {
  context,
  partyId: otherPartyId,
  partyRef: otherPartyRef,
  status: 'ready',
};

const identityView: PartyIdentityView = {
  aliasResolved: false,
  archived: false,
  createdAt: DateTime.makeUnsafe(instant),
  displayName: 'Eva Bílá',
  facts: [
    {
      factKind: 'DISPLAY_NAME',
      recordedAt: DateTime.makeUnsafe(instant),
      validFrom: DateTime.makeUnsafe(instant),
      value: 'Eva Bílá',
    },
  ],
  partyType: 'PERSON',
  revision: 7,
  updatedAt: DateTime.makeUnsafe(instant),
};
const identifier: PartyIdentifierView = {
  current: true,
  identifierType: 'ICO',
  recordedAt: DateTime.makeUnsafe(instant),
  state: 'ACTIVE',
  validFrom: DateTime.makeUnsafe(instant),
  validTo: Option.none(),
  value: '12345678',
  verification: 'VERIFIED',
};
const contact: PartyContactView = {
  contactType: 'EMAIL',
  displayValue: 'eva@example.cz',
  preferred: true,
  purposes: [],
  verification: 'VERIFIED',
};

const readyRead: PartyIdentityReadView = {
  contacts: { status: 'ready', value: [contact] },
  identifiers: { status: 'ready', value: [identifier] },
  identity: { status: 'ready', value: identityView },
  status: 'identity',
};

const identityResponse = (ref: PartyRef, displayName: string) =>
  Schema.decodeSync(PartyDetailResponseSchema)({
    currentFactAssertions: [],
    factHistory: null,
    party: {
      archivedAt: null,
      createdAt: instant,
      displayName,
      partyRef: ref,
      partyType: 'PERSON',
      revision: ref.resourceId === partyId ? 7 : 8,
      updatedAt: instant,
    },
    resolution: {
      aliasChain: [],
      canonicalPartyRef: ref,
      kind: 'DIRECT',
      requestedPartyRef: ref,
    },
  });

const noop = (): void => {
  // The pure view tests assert rendering; the callbacks deliberately do nothing.
};

const ViewWithRead = ({
  input,
  readers,
}: {
  readonly input: PartyIdentityReadyInput;
  readonly readers: PartyIdentityReaders;
}) => {
  const read = usePartyIdentityRead(input, readers);
  const handleReload = read.retry;
  return <PartyIdentityPageView input={input} onBack={noop} onReload={handleReload} read={read.view} />;
};

afterEach(cleanup);

it('renders the exact Party identity, identifiers and contacts without technical identifiers', () => {
  render(<PartyIdentityPageView input={readyInput} onBack={noop} onReload={noop} read={readyRead} />);

  expect(screen.getByRole('heading', { name: 'Eva Bílá' })).toBeTruthy();
  expect(screen.getByText('party-registry.pages.partyIdentity.sections.identity')).toBeTruthy();
  expect(screen.getByText('party-registry.pages.partyIdentity.sections.facts')).toBeTruthy();
  expect(screen.getByText(/12345678/u)).toBeTruthy();
  expect(screen.getByText('eva@example.cz')).toBeTruthy();
  expect(document.body.textContent).not.toContain(partyId);
  expect(document.body.textContent).not.toContain('counterparty');
  expectHumanReadable();
});

it('shows a contact refusal without hiding a ready identity or identifiers', () => {
  render(
    <PartyIdentityPageView
      input={readyInput}
      onBack={noop}
      onReload={noop}
      read={{ ...readyRead, contacts: { status: 'forbidden' } }}
    />,
  );

  expect(screen.getByText('party-registry.pages.partyIdentity.contacts.forbidden')).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Eva Bílá' })).toBeTruthy();
  expect(screen.getByText(/12345678/u)).toBeTruthy();
});

it('shows a Party permission denial without a record, revision or section actions', () => {
  render(
    <PartyIdentityPageView
      input={readyInput}
      onBack={noop}
      onReload={noop}
      read={{ identity: { status: 'forbidden' }, status: 'identity' }}
    />,
  );

  expect(screen.getByText('party-registry.pages.partyIdentity.forbidden')).toBeTruthy();
  expect(screen.queryByText('Eva Bílá')).toBeNull();
  expect(screen.queryByText('party-registry.pages.partyIdentity.sections.identifiers')).toBeNull();
  expect(screen.queryByRole('button', { name: 'party-registry.pages.partyIdentity.reload' })).toBeNull();
});

it('shows missing and unavailable identities honestly with retry only for unavailable', () => {
  render(
    <PartyIdentityPageView
      input={readyInput}
      onBack={noop}
      onReload={noop}
      read={{ identity: { status: 'not-found' }, status: 'identity' }}
    />,
  );
  expect(screen.getByText('party-registry.pages.partyIdentity.notFound')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'party-registry.pages.partyIdentity.reload' })).toBeNull();
  cleanup();

  render(
    <PartyIdentityPageView
      input={readyInput}
      onBack={noop}
      onReload={noop}
      read={{ identity: { status: 'unavailable' }, status: 'identity' }}
    />,
  );
  expect(screen.getByText('party-registry.pages.partyIdentity.unavailable')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'party-registry.pages.partyIdentity.reload' })).toBeTruthy();
});

it.effect('discards the previous identity immediately when the route id changes', () =>
  Effect.gen(function* discardPreviousIdentity() {
    const gate = Deferred.makeUnsafe<null>();
    let mode: 'ready' | 'pending' = 'ready';
    const readers: PartyIdentityReaders = {
      contacts: () => Effect.succeed({ status: 'ready', value: { items: [] } }),
      identifiers: () => Effect.succeed({ status: 'ready', value: { items: [] } }),
      identity: (ref) =>
        mode === 'ready'
          ? Effect.succeed({
              status: 'ready',
              value: identityResponse(ref, ref.resourceId === partyId ? 'Eva Bílá' : 'Petr Novák'),
            })
          : Deferred.await(gate).pipe(
              Effect.as({
                status: 'ready' as const,
                value: identityResponse(otherPartyRef, 'Petr Novák'),
              }),
            ),
    };
    const { rerender } = render(<ViewWithRead input={readyInput} readers={readers} />);
    yield* Effect.promise(() => waitFor(() => expect(screen.getByRole('heading', { name: 'Eva Bílá' })).toBeTruthy()));

    mode = 'pending';
    rerender(<ViewWithRead input={otherInput} readers={readers} />);
    expect(screen.queryByRole('heading', { name: 'Eva Bílá' })).toBeNull();
    expect(screen.getByText('party-registry.pages.partyIdentity.loading')).toBeTruthy();

    act(() => {
      Deferred.doneUnsafe(gate, Effect.succeed(null));
    });
    yield* Effect.promise(() =>
      waitFor(() => expect(screen.getByRole('heading', { name: 'Petr Novák' })).toBeTruthy()),
    );
  }),
);

it.effect('does not keep ready details when a reload is refused', () =>
  Effect.gen(function* refuseReload() {
    const gate = Deferred.makeUnsafe<null>();
    let mode: 'ready' | 'refused' = 'ready';
    const readers: PartyIdentityReaders = {
      contacts: () => Effect.succeed({ status: 'ready', value: { items: [] } }),
      identifiers: () => Effect.succeed({ status: 'ready', value: { items: [] } }),
      identity: (ref) =>
        mode === 'ready'
          ? Effect.succeed({
              status: 'ready',
              value: identityResponse(ref, 'Eva Bílá'),
            })
          : Deferred.await(gate).pipe(Effect.as({ status: 'forbidden' as const })),
    };
    render(<ViewWithRead input={readyInput} readers={readers} />);
    yield* Effect.promise(() => waitFor(() => expect(screen.getByRole('heading', { name: 'Eva Bílá' })).toBeTruthy()));

    mode = 'refused';
    fireEvent.click(screen.getByRole('button', { name: 'party-registry.pages.partyIdentity.reload' }));
    expect(screen.queryByRole('heading', { name: 'Eva Bílá' })).toBeNull();
    expect(screen.getByText('party-registry.pages.partyIdentity.loading')).toBeTruthy();

    act(() => {
      Deferred.doneUnsafe(gate, Effect.succeed(null));
    });
    yield* Effect.promise(() =>
      waitFor(() => expect(screen.getByText('party-registry.pages.partyIdentity.forbidden')).toBeTruthy()),
    );
    expect(screen.queryByRole('heading', { name: 'Eva Bílá' })).toBeNull();
  }),
);

it('never renders a customer or Counterparty route', () => {
  render(<PartyIdentityPageView input={readyInput} onBack={noop} onReload={noop} read={readyRead} />);

  expect(document.querySelector('a[href*="zakaznici"]')).toBeNull();
  expect(document.body.textContent).not.toContain('party-registry.pages.customers');
  expect(document.body.textContent?.toLowerCase()).not.toContain('counterparty');
});

it('declares the generated exact Party identity route contract', () => {
  expect(routeMeta.canonicalPath).toBe('/prodej/strany/:partyId');
  expect(routeMeta.localisedPaths).toEqual({
    cs: '/prodej/strany/:partyId',
    en: '/prodej/strany/:partyId',
  });
  expect(routeMeta.entrypoint.entrypointKey).toBe('party.registry.page.party-identity');
  expect(routeMeta.public).toBe(false);
});
