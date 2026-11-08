import { getI18nInstance as createModernI18n } from '@modern-js/plugin-i18n/i18n';
import type { I18nInstance } from '@modern-js/plugin-i18n/runtime';
import { ModernI18nProvider } from '@modern-js/plugin-i18n/runtime/consumer';
import { cleanup, render as renderView, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Effect, Schema } from 'effect';
import { afterEach, beforeAll, beforeEach, describe, expect, it, rstest } from 'effect-rstest';
import type { PropsWithChildren, ReactElement } from 'react';
import { useState } from 'react';

import csResource from '../../locales/cs/shell.json';
import enResource from '../../locales/en/shell.json';

import {
  ListAccessPeopleOptionsResponseSchema,
  ListAccessPeopleResponseSchema,
} from '../../shared/access-admin-api.ts';
import type { Person } from '../../shared/people-api.ts';
import {
  defaultPeopleFilters,
  filterPeople,
  PersonStatusKeySchema,
  personStatusKey,
  personStatusPresentation,
} from '../../src/routes/people/people-model.ts';
import type { PeopleAccessView, PeopleFilters } from '../../src/routes/people/people-model.ts';
import {
  PeopleTable,
  PeopleToolbar,
  PersonActionsMenu,
  PersonStatusDot,
  RoleChips,
} from '../../src/routes/people/people-table.tsx';

let i18nInstance: I18nInstance;
beforeAll(async () => {
  i18nInstance = await createModernI18n();
  await i18nInstance.init({
    defaultNS: 'shell',
    lng: 'cs',
    ns: ['shell'],
    resources: { cs: { shell: csResource }, en: { shell: enResource } },
    supportedLngs: ['cs', 'en'],
  });
});
beforeEach(async () => {
  await i18nInstance.changeLanguage?.('cs');
});
const I18nProvider = ({ children }: PropsWithChildren) => (
  <ModernI18nProvider value={{ i18nInstance, language: i18nInstance.language, languages: ['cs', 'en'] }}>
    {children}
  </ModernI18nProvider>
);
const render = (ui: ReactElement) => renderView(ui, { wrapper: I18nProvider });

const tenantId = '00000000-0000-4000-8000-000000000001';
const companyId = '00000000-0000-4000-8000-000000000002';
const companyScope = { kind: 'company', legalEntityId: companyId } as const;
const accessRevision = 'people-revision-1';
const roleRevisionId = '00000000-0000-4000-8000-0000000000b1';
/** The released canonical roles of the scope: a role is named and identified, never addressed by a key. */
const allRoles = [
  { name: 'Obchodník', roleId: '00000000-0000-4000-8000-0000000000a1' },
  { name: 'Správce firmy', roleId: '00000000-0000-4000-8000-0000000000a2' },
  { name: 'Účetní', roleId: '00000000-0000-4000-8000-0000000000a3' },
  { name: 'Vedení', roleId: '00000000-0000-4000-8000-0000000000a4' },
] as const;
const roleIdOf = (name: string) => allRoles.find((role) => role.name === name)?.roleId ?? allRoles[0].roleId;
/** The canonical assignments of each principal, keyed by principal id, as the access read reports them. */
const assignedRoleNames = new Map<string, readonly string[]>();
const accessViewFor = (people: readonly Person[]): PeopleAccessView => ({
  options: Schema.decodeUnknownSync(ListAccessPeopleOptionsResponseSchema)({
    capabilities: [],
    managers: [],
    people: [],
    revision: accessRevision,
    roles: allRoles.map((role) => ({
      capabilityKeys: [],
      latestRevisionId: roleRevisionId,
      name: role.name,
      risk: 'sensitive' as const,
      roleId: role.roleId,
      scope: companyScope,
    })),
    scopes: [{ label: 'Firma', scope: companyScope }],
    teams: [],
    writeAvailability: {
      canAssign: true,
      canDelegate: false,
      canManageTeams: false,
      canRevokeDelegation: false,
      canTransferOwnership: false,
      canUnassign: true,
    },
  }),
  people: Schema.decodeUnknownSync(ListAccessPeopleResponseSchema)({
    items: people.map((person) => ({
      assignments: (assignedRoleNames.get(person.principalRef.principalId) ?? []).map((name, index) => ({
        incarnationId: `00000000-0000-4000-8000-0000000000${String(index + 1).padStart(2, '0')}`,
        principalId: person.principalRef.principalId,
        roleId: roleIdOf(name),
        roleName: name,
        scope: companyScope,
        status: 'active' as const,
        validFrom: '2026-01-01T00:00:00.000Z',
        validUntil: null,
      })),
      delegations: [],
      displayName: person.displayName,
      memberships: [],
      ownership: { administersScopes: [], soleAdministratorScopes: [] },
      principalId: person.principalRef.principalId,
      suspended: false,
      teams: [],
    })),
    nextCursor: null,
    revision: accessRevision,
  }),
});
let next = 10;
const person = (
  displayName: string,
  overrides: Partial<{
    affiliation: 'employee' | 'external' | null;
    kind: Person['kind'];
    principalStatus: Person['principalStatus'];
    roles: readonly string[];
    status: 'active' | 'departed' | 'disabled' | 'invited';
  }> = {},
): Person => {
  next += 1;
  const principalRef = { principalId: `00000000-0000-4000-8000-0000000000${next}`, tenantId };
  assignedRoleNames.set(principalRef.principalId, overrides.roles ?? []);
  return {
    displayName,
    invitationDelivery: null,
    kind: overrides.kind ?? 'human',
    principalRef,
    principalStatus: overrides.principalStatus ?? 'active',
    selectedCompanyMembership: {
      affiliation: overrides.kind === 'agent' ? null : (overrides.affiliation ?? 'employee'),
      legalEntityId: companyId,
      principalRef,
      revision: 1,
      status: overrides.status ?? 'active',
    },
  };
};

const jana = person('Jana Nováková', { roles: ['Obchodník'] });
const petr = person('Petr Dvořák', { affiliation: 'external', roles: ['Účetní'], status: 'invited' });
const agent = person('Asistent provozu', { kind: 'agent' });
const blocked = person('Karel Blokovaný', { principalStatus: 'disabled' });
const departed = person('Eva Odešlá', { status: 'departed' });
const people = [jana, petr, agent, blocked, departed];

const names = (filters: Partial<PeopleFilters>) =>
  filterPeople(people, { ...defaultPeopleFilters, ...filters }, accessViewFor(people)).map(
    ({ displayName }) => displayName,
  );

const Harness = () => {
  const [filters, setFilters] = useState(defaultPeopleFilters);
  return (
    <>
      <PeopleToolbar
        access={accessViewFor(people)}
        actions={null}
        companyAvailable
        filters={filters}
        onFiltersChange={setFilters}
        onScopeChange={() => {}}
        scope="company"
      />
      <PeopleTable
        access={accessViewFor(people)}
        filters={filters}
        loading={false}
        onEdit={() => {}}
        onFiltersChange={setFilters}
        onOpen={() => {}}
        people={people}
        scope="company"
      />
    </>
  );
};

afterEach(() => {
  cleanup();
  rstest.restoreAllMocks();
});

describe('status dot', () => {
  it('always pairs the decorative colour dot with a visible Czech label', () => {
    for (const status of PersonStatusKeySchema.literals) {
      const { container } = render(<PersonStatusDot status={status} />);
      const dot = container.querySelector('[data-tone]');
      expect(dot?.getAttribute('aria-hidden')).toBe('true');
      // The meaning is in the accessible text, never only in the colour.
      expect(container.textContent).toBe(personStatusPresentation[status].label);
      cleanup();
    }
  });

  it('gives active, invited, deactivated and blocked distinct labels and colour tones', () => {
    const shown = (['active', 'invited', 'deactivated', 'blocked'] as const).map((status) => {
      const { container } = render(<PersonStatusDot status={status} />);
      const result = { label: container.textContent, tone: container.querySelector('[data-tone]')?.className };
      cleanup();
      return result;
    });
    expect(shown.map(({ label }) => label)).toEqual(['Aktivní', 'Pozvaný', 'Deaktivovaný', 'Zablokovaný']);
    expect(shown.map(({ tone }) => tone?.match(/bg-[a-z-]+/u)?.[0])).toEqual([
      'bg-success',
      'bg-warning',
      'bg-fg-secondary',
      'bg-danger',
    ]);
  });

  it('lets a blocked login win over an otherwise active membership', () => {
    expect(personStatusKey(blocked)).toBe('blocked');
    expect(personStatusKey(petr)).toBe('invited');
    expect(personStatusKey(departed)).toBe('departed');
  });
});

describe('role chips', () => {
  it('shows two roles and announces the rest behind a +N chip', () => {
    render(<RoleChips names={['Obchodník', 'Správce firmy', 'Účetní', 'Vedení']} />);
    expect(screen.getByText('Obchodník')).toBeDefined();
    expect(screen.getByText('Správce firmy')).toBeDefined();
    expect(screen.getByText('+2')).toBeDefined();
    expect(screen.getByText('a další role: Účetní, Vedení')).toBeDefined();
  });
});

describe('translations', () => {
  it.live.each([
    {
      language: 'cs',
      list: 'Lidé a role',
      loading: 'Načítám lidi a role…',
      name: 'Jméno',
      noMemberships: 'V tomto rozsahu nejsou žádná evidovaná členství.',
      personActions: 'Akce: Jana Nováková',
      searchLabel: 'Hledat podle jména, typu nebo role',
      searchPlaceholder: 'Hledat jméno, typ nebo roli',
    },
    {
      language: 'en',
      list: 'People and roles',
      loading: 'Loading people and roles…',
      name: 'Name',
      noMemberships: 'There are no recorded memberships in this scope.',
      personActions: 'Actions: Jana Nováková',
      searchLabel: 'Search by name, type or role',
      searchPlaceholder: 'Search name, type or role',
    },
  ])('renders toolbar, table and compact states in $language', (copy) =>
    Effect.gen(function* localizedTable() {
      yield* Effect.promise(async () => await i18nInstance.changeLanguage?.(copy.language));
      render(<Harness />);
      expect(screen.getByRole('searchbox', { name: copy.searchLabel }).getAttribute('placeholder')).toBe(
        copy.searchPlaceholder,
      );
      expect(screen.getByRole('columnheader', { name: copy.name })).toBeDefined();
      expect(screen.getByRole('button', { name: copy.personActions })).toBeDefined();
      cleanup();

      const media = globalThis.matchMedia('(min-width: 48rem)');
      rstest.spyOn(media, 'matches', 'get').mockReturnValue(false);
      rstest.spyOn(globalThis, 'matchMedia').mockReturnValue(media);
      const table = render(
        <PeopleTable
          access={accessViewFor(people)}
          filters={defaultPeopleFilters}
          loading
          onEdit={() => {}}
          onFiltersChange={() => {}}
          onOpen={() => {}}
          people={[]}
          scope="company"
        />,
      );
      expect(screen.getByRole('status').textContent).toBe(copy.loading);
      table.rerender(
        <PeopleTable
          access={accessViewFor(people)}
          filters={defaultPeopleFilters}
          loading={false}
          onEdit={() => {}}
          onFiltersChange={() => {}}
          onOpen={() => {}}
          people={[]}
          scope="company"
        />,
      );
      expect(screen.getByText(copy.noMemberships)).toBeDefined();
      table.rerender(
        <PeopleTable
          access={accessViewFor(people)}
          filters={defaultPeopleFilters}
          loading={false}
          onEdit={() => {}}
          onFiltersChange={() => {}}
          onOpen={() => {}}
          people={[jana]}
          scope="company"
        />,
      );
      expect(screen.getByRole('list', { name: copy.list })).toBeDefined();
      expect(screen.getByRole('button', { name: copy.personActions })).toBeDefined();
      expect(document.body.textContent).not.toContain('shell.people.');
    }),
  );

  it.live('uses English invitation notes, overflow announcements and menu labels with unchanged action values', () =>
    Effect.gen(function* englishActions() {
      yield* Effect.promise(async () => await i18nInstance.changeLanguage?.('en'));
      const user = userEvent.setup();
      const onEdit = rstest.fn();
      const invited = { ...petr, invitationDelivery: { status: 'pending' } } as const;
      render(
        <>
          <RoleChips names={['Obchodník', 'Správce firmy', 'Účetní', 'Vedení']} />
          <PeopleTable
            access={accessViewFor(people)}
            filters={defaultPeopleFilters}
            loading={false}
            onEdit={(kind, edited) => {
              onEdit(kind, edited);
            }}
            onFiltersChange={() => {}}
            onOpen={() => {}}
            people={[invited]}
            scope="company"
          />
        </>,
      );
      expect(screen.getByText('and more roles: Účetní, Vedení')).toBeDefined();
      expect(screen.getByText('Invitation waiting to be sent')).toBeDefined();
      yield* Effect.promise(() => user.click(screen.getByRole('button', { name: 'Actions: Petr Dvořák' })));
      expect(yield* Effect.promise(() => screen.findByRole('menuitem', { name: 'Manage roles' }))).toBeDefined();
      yield* Effect.promise(() => user.click(screen.getByRole('menuitem', { name: 'Edit membership' })));
      expect(onEdit).toHaveBeenCalledWith('membership', invited);
    }),
  );
});

describe('row action menu', () => {
  it.live('offers membership and role changes without opening the row detail', () =>
    Effect.gen(function* chooseAction() {
      const user = userEvent.setup();
      const onEdit = rstest.fn();
      const onOpen = rstest.fn();
      render(
        <PeopleTable
          access={accessViewFor(people)}
          filters={defaultPeopleFilters}
          loading={false}
          onEdit={(kind, edited) => {
            onEdit(kind, edited);
          }}
          onFiltersChange={() => {}}
          onOpen={(opened) => {
            onOpen(opened);
          }}
          people={[jana]}
          scope="company"
        />,
      );
      yield* Effect.promise(() => user.click(screen.getByRole('button', { name: 'Akce: Jana Nováková' })));
      expect(yield* Effect.promise(() => screen.findByRole('menuitem', { name: 'Upravit členství' }))).toBeDefined();
      yield* Effect.promise(() => user.click(screen.getByRole('menuitem', { name: 'Spravovat role' })));
      expect(onEdit).toHaveBeenCalledWith('role', jana);
      expect(onOpen).not.toHaveBeenCalled();
      yield* Effect.promise(() => user.click(screen.getByText('Jana Nováková')));
      expect(onOpen).toHaveBeenCalledWith(jana);
    }),
  );

  it.live('offers only role changes for the whole organisation', () =>
    Effect.gen(function* tenantActions() {
      const user = userEvent.setup();
      render(<PersonActionsMenu onEdit={() => {}} person={jana} scope="tenant" />);
      yield* Effect.promise(() => user.click(screen.getByRole('button', { name: 'Akce: Jana Nováková' })));
      expect(yield* Effect.promise(() => screen.findByRole('menuitem', { name: 'Spravovat role' }))).toBeDefined();
      expect(screen.queryByRole('menuitem', { name: 'Upravit členství' })).toBeNull();
    }),
  );
});

describe('filters', () => {
  it('hides ended memberships by default and shows them on request', () => {
    expect(names({})).not.toContain('Eva Odešlá');
    expect(names({ status: 'all' })).toContain('Eva Odešlá');
    expect(names({ status: 'departed' })).toEqual(['Eva Odešlá']);
  });

  it('hides retired accounts (blocked login without a current membership or role) by default, never a merely blocked one', () => {
    const retired = person('Bývalý účet', { principalStatus: 'disabled', status: 'departed' });
    const tenantRetired = {
      ...person('Bývalý účet firmy', { principalStatus: 'disabled' }),
      selectedCompanyMembership: null,
    };
    const tenantBlocked = {
      ...person('Blokovaný s rolí', { principalStatus: 'disabled', roles: ['Obchodník'] }),
      selectedCompanyMembership: null,
    };
    const visible = (status: PeopleFilters['status']) =>
      filterPeople(
        [blocked, retired, tenantRetired, tenantBlocked],
        { ...defaultPeopleFilters, status },
        accessViewFor([blocked, retired, tenantRetired, tenantBlocked]),
      ).map(({ displayName }) => displayName);
    expect(visible('current')).toEqual(['Karel Blokovaný', 'Blokovaný s rolí']);
    expect(visible('all')).toEqual(['Karel Blokovaný', 'Bývalý účet', 'Bývalý účet firmy', 'Blokovaný s rolí']);
    expect(visible('blocked')).toEqual(['Karel Blokovaný', 'Bývalý účet', 'Bývalý účet firmy', 'Blokovaný s rolí']);
  });

  it('filters by type, role and status, and searches names, types and role names without diacritics', () => {
    expect(names({ kind: 'agent' })).toEqual(['Asistent provozu']);
    expect(names({ kind: 'external' })).toEqual(['Petr Dvořák']);
    expect(names({ roleId: roleIdOf('Obchodník') })).toEqual(['Jana Nováková']);
    expect(names({ status: 'blocked' })).toEqual(['Karel Blokovaný']);
    expect(names({ query: 'novakova' })).toEqual(['Jana Nováková']);
    expect(names({ query: 'ucetni' })).toEqual(['Petr Dvořák']);
    expect(names({ query: 'AI agent' })).toEqual(['Asistent provozu']);
  });

  it.live('narrows the table from the toolbar search and offers to clear filters when nothing matches', () =>
    Effect.gen(function* searchTable() {
      const user = userEvent.setup();
      render(<Harness />);
      expect(screen.queryByRole('button', { name: 'Obnovit seznam' })).toBeNull();
      const search = screen.getByRole('searchbox', { name: 'Hledat podle jména, typu nebo role' });
      yield* Effect.promise(() => user.type(search, 'dvorak'));
      const table = screen.getByRole('table');
      expect(within(table).getByText('Petr Dvořák')).toBeDefined();
      expect(within(table).queryByText('Jana Nováková')).toBeNull();
      expect(within(table).getByText('Pozvaný')).toBeDefined();
      yield* Effect.promise(() => user.clear(search));
      yield* Effect.promise(() => user.type(search, 'nikdo takový'));
      yield* Effect.promise(() => screen.findByText('Filtrům nikdo neodpovídá.'));
      yield* Effect.promise(() => user.click(screen.getByRole('button', { name: 'Zrušit filtry' })));
      expect(within(screen.getByRole('table')).getByText('Eva Odešlá')).toBeDefined();
      expect(document.body.textContent).not.toMatch(/00000000-|crm-sales/u);
    }),
  );
});
