import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Effect } from 'effect';
import { afterEach, describe, expect, it, rstest } from 'effect-rstest';
import { useState } from 'react';

import type { PeopleRoleCatalog, Person } from '../../shared/people-api.ts';
import {
  defaultPeopleFilters,
  filterPeople,
  PersonStatusKeySchema,
  personStatusKey,
  personStatusPresentation,
} from '../../src/routes/people/people-model.ts';
import type { PeopleFilters } from '../../src/routes/people/people-model.ts';
import {
  PeopleTable,
  PeopleToolbar,
  PersonActionsMenu,
  PersonStatusDot,
  RoleChips,
} from '../../src/routes/people/people-table.tsx';

const tenantId = '00000000-0000-4000-8000-000000000001';
const companyId = '00000000-0000-4000-8000-000000000002';
const scope = { _tag: 'company', legalEntityId: companyId } as const;
const role = (roleKey: string) => ({ roleKey, scope, tenantId });
const catalog: PeopleRoleCatalog = {
  items: [
    { description: '', name: 'Obchodník', roleKey: 'crm-sales', scope },
    { description: '', name: 'Správce firmy', roleKey: 'admin', scope },
    { description: '', name: 'Účetní', roleKey: 'accounting', scope },
    { description: '', name: 'Vedení', roleKey: 'management', scope },
  ],
};
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
  return {
    displayName,
    invitationDelivery: null,
    kind: overrides.kind ?? 'human',
    principalRef,
    principalStatus: overrides.principalStatus ?? 'active',
    roleAssignments: (overrides.roles ?? []).map(role),
    selectedCompanyMembership: {
      affiliation: overrides.kind === 'agent' ? null : (overrides.affiliation ?? 'employee'),
      legalEntityId: companyId,
      principalRef,
      revision: 1,
      status: overrides.status ?? 'active',
    },
    selectedCompanyMembershipProjection: { expectedMember: true, observedMember: true },
  };
};

const jana = person('Jana Nováková', { roles: ['crm-sales'] });
const petr = person('Petr Dvořák', { affiliation: 'external', roles: ['accounting'], status: 'invited' });
const agent = person('Asistent provozu', { kind: 'agent' });
const blocked = person('Karel Blokovaný', { principalStatus: 'disabled' });
const departed = person('Eva Odešlá', { status: 'departed' });
const people = [jana, petr, agent, blocked, departed];

afterEach(cleanup);

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

describe('row action menu', () => {
  it.live('offers membership and role changes without opening the row detail', () =>
    Effect.gen(function* chooseAction() {
      const user = userEvent.setup();
      const onEdit = rstest.fn();
      const onOpen = rstest.fn();
      render(
        <PeopleTable
          catalog={catalog}
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
  const names = (filters: Partial<PeopleFilters>) =>
    filterPeople(people, { ...defaultPeopleFilters, ...filters }, catalog).map(({ displayName }) => displayName);

  it('hides ended memberships by default and shows them on request', () => {
    expect(names({})).not.toContain('Eva Odešlá');
    expect(names({ status: 'all' })).toContain('Eva Odešlá');
    expect(names({ status: 'departed' })).toEqual(['Eva Odešlá']);
  });

  it('filters by type, role and status, and searches names, types and role names without diacritics', () => {
    expect(names({ kind: 'agent' })).toEqual(['Asistent provozu']);
    expect(names({ kind: 'external' })).toEqual(['Petr Dvořák']);
    expect(names({ roleKey: 'crm-sales' })).toEqual(['Jana Nováková']);
    expect(names({ status: 'blocked' })).toEqual(['Karel Blokovaný']);
    expect(names({ query: 'novakova' })).toEqual(['Jana Nováková']);
    expect(names({ query: 'ucetni' })).toEqual(['Petr Dvořák']);
    expect(names({ query: 'AI agent' })).toEqual(['Asistent provozu']);
  });

  it.live('narrows the table from the toolbar search and offers to clear filters when nothing matches', () =>
    Effect.gen(function* searchTable() {
      const user = userEvent.setup();
      const Harness = () => {
        const [filters, setFilters] = useState(defaultPeopleFilters);
        return (
          <>
            <PeopleToolbar
              actions={null}
              catalog={catalog}
              companyAvailable
              filters={filters}
              onFiltersChange={setFilters}
              onScopeChange={() => {}}
              scope="company"
            />
            <PeopleTable
              catalog={catalog}
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
