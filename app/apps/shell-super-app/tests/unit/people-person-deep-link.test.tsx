import { cleanup, render, screen } from '@testing-library/react';
import { Effect } from 'effect';
import { afterEach, beforeEach, expect, it, rstest } from 'effect-rstest';
import type { ReactNode } from 'react';

import { PeopleView } from '../../src/routes/people/people-view.tsx';
import type { PeoplePageModel } from '../../src/routes/people/people-page-model.ts';
import type { DetailSearch, PeopleDetailQuery } from '../../src/routes/people/people-detail-selection.ts';
import { authenticatedShellFixture } from './routes/authenticated-shell-fixture.ts';

const { commands, state } = rstest.hoisted(() => ({
  commands: {
    catalog: rstest.fn(),
    list: rstest.fn(),
  },
  state: {
    search: {},
  },
}));

rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  useRouterState: ({
    select,
  }: {
    readonly select: (value: { readonly location: { readonly search: DetailSearch } }) => PeopleDetailQuery;
  }) => select({ location: { search: state.search } }),
}));
rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({ language: 'cs', t: (key: string) => key }),
}));
rstest.mock('../../src/routes/shell-content-layout.tsx', () => ({
  ShellContentLayout: ({ children }: { readonly children?: ReactNode }) => <div>{children}</div>,
}));
rstest.mock('../../src/routes/sign-in-redirect.tsx', () => ({
  SignInRedirect: () => null,
}));
rstest.mock('../../src/routes/use-shell-controls.ts', () => ({
  useShellControls: () => ({ reloadRequired: false }),
}));
rstest.mock('../../src/routes/people/agent-entities-section.tsx', () => ({
  AgentEntitiesSection: () => null,
}));
rstest.mock('../../src/routes/people/invite-person-button.tsx', () => ({
  InvitePersonButton: () => null,
}));
rstest.mock('../../src/routes/people/people-client.ts', () => ({
  changeCompanyMembership: rstest.fn(),
  changeScopedRole: rstest.fn(),
  invitePerson: rstest.fn(),
  loadAllPeople: commands.list,
  loadRoleCatalog: commands.catalog,
}));

const companyId = '20000000-0000-4000-8000-000000000001';
const otherCompanyId = '20000000-0000-4000-8000-000000000002';
const tenantId = '00000000-0000-4000-8000-000000000001';
const otherTenantId = '00000000-0000-4000-8000-000000000002';
const principalId = '00000000-0000-4000-8000-000000000003';
const missingPrincipalId = '00000000-0000-4000-8000-000000000004';
const principalRef = { principalId, tenantId };
const membership = {
  affiliation: 'external',
  legalEntityId: companyId,
  principalRef,
  revision: 1,
  status: 'invited',
} as const;
const person = {
  displayName: 'Jana Nováková',
  invitationDelivery: null,
  kind: 'human',
  principalRef,
  principalStatus: 'active',
  roleAssignments: [],
  selectedCompanyMembership: membership,
  selectedCompanyMembershipProjection: { expectedMember: false, observedMember: false },
} as const;
const list = {
  items: [person],
  nextOffset: null,
  scope: { _tag: 'company', legalEntityId: companyId },
  tenantId,
} as const;
const model = (): PeoplePageModel => ({ peoplePage: true, shell: authenticatedShellFixture() });

afterEach(cleanup);
beforeEach(() => {
  state.search = {};
  commands.catalog.mockReturnValue(Effect.succeed({ status: 'ok', value: { items: [] } }));
  commands.list.mockReturnValue(Effect.succeed({ status: 'ok', value: list }));
});

it.live('a cold company-qualified link opens the real person detail and its existing administration actions', () =>
  Effect.gen(function* qualifiedColdLink() {
    state.search = { person: `${companyId}.${principalId}` };
    render(<PeopleView model={model()} />);
    yield* Effect.promise(() => screen.findByRole('dialog', { name: 'Jana Nováková' }));
    expect(screen.getByRole('button', { name: 'Spravovat role' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Upravit členství' })).toBeDefined();
  }),
);

it.live('a link qualified with another company is refused instead of selecting the same principal locally', () =>
  Effect.gen(function* foreignCompany() {
    state.search = { person: `${otherCompanyId}.${principalId}` };
    render(<PeopleView model={model()} />);
    yield* Effect.promise(() => screen.findByText('shell.people.detail.foreignCompany'));
    expect(screen.queryByRole('dialog')).toBeNull();
  }),
);

it('a malformed person link is refused while a valid agent link keeps its own tab', () => {
  state.search = { agent: '00000000-0000-4000-8000-000000000099', person: 'broken-person' };
  render(<PeopleView model={model()} />);
  expect(screen.getByRole('button', { name: 'AI agenti' }).getAttribute('aria-pressed')).toBe('true');
  expect(screen.queryByRole('dialog')).toBeNull();
});

it.live('a qualified person absent from the governed directory stays a truthful missing state', () =>
  Effect.gen(function* missingPerson() {
    state.search = { person: `${companyId}.${missingPrincipalId}` };
    render(<PeopleView model={model()} />);
    yield* Effect.promise(() =>
      screen.findByText('Osoba z odkazu neexistuje nebo k ní v tomto rozsahu nemáte přístup.'),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  }),
);

it.live('a forbidden governed directory read shows its denial and never claims or opens a person', () =>
  Effect.gen(function* forbiddenRead() {
    state.search = { person: `${companyId}.${principalId}` };
    commands.list.mockReturnValue(
      Effect.succeed({ message: 'K této správě nemáte oprávnění.', status: 'failed' as const }),
    );
    render(<PeopleView model={model()} />);
    yield* Effect.promise(() => screen.findByText('K této správě nemáte oprávnění.'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
  }),
);

it.live('a refused reread removes a previously opened person and administration actions', () =>
  Effect.gen(function* refusedReread() {
    state.search = { person: `${companyId}.${principalId}` };
    render(<PeopleView model={model()} />);
    yield* Effect.promise(() => screen.findByRole('dialog', { name: 'Jana Nováková' }));
    commands.list.mockReturnValue(
      Effect.succeed({ message: 'K této správě nemáte oprávnění.', status: 'failed' as const }),
    );
    document.dispatchEvent(new Event('visibilitychange'));
    yield* Effect.promise(() => screen.findByText('K této správě nemáte oprávnění.'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Spravovat role' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Upravit členství' })).toBeNull();
  }),
);

it.live('a row with the same principal but another company membership is not the linked person', () =>
  Effect.gen(function* foreignMembership() {
    state.search = { person: `${companyId}.${principalId}` };
    commands.list.mockReturnValue(
      Effect.succeed({
        status: 'ok',
        value: {
          ...list,
          items: [{ ...person, selectedCompanyMembership: { ...membership, legalEntityId: otherCompanyId } }],
        },
      }),
    );
    render(<PeopleView model={model()} />);
    yield* Effect.promise(() =>
      screen.findByText('Osoba z odkazu neexistuje nebo k ní v tomto rozsahu nemáte přístup.'),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  }),
);

it.live('a row from another tenant is not the linked person', () =>
  Effect.gen(function* foreignTenant() {
    state.search = { person: `${companyId}.${principalId}` };
    commands.list.mockReturnValue(
      Effect.succeed({
        status: 'ok',
        value: {
          ...list,
          items: [{ ...person, principalRef: { ...principalRef, tenantId: otherTenantId } }],
        },
      }),
    );
    render(<PeopleView model={model()} />);
    yield* Effect.promise(() =>
      screen.findByText('Osoba z odkazu neexistuje nebo k ní v tomto rozsahu nemáte přístup.'),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  }),
);

it.live('the existing people page still lists people without a deep link', () =>
  Effect.gen(function* existingPage() {
    render(<PeopleView model={model()} />);
    yield* Effect.promise(() => screen.findByRole('table'));
    expect(screen.getByText('Jana Nováková')).toBeDefined();
    expect(screen.queryByRole('dialog')).toBeNull();
  }),
);

it.live('the existing unqualified person bookmark keeps working', () =>
  Effect.gen(function* legacyBookmark() {
    state.search = { person: principalId };
    render(<PeopleView model={model()} />);
    yield* Effect.promise(() => screen.findByRole('dialog', { name: 'Jana Nováková' }));
  }),
);
