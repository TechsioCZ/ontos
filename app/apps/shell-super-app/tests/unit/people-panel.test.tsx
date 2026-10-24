import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Effect } from 'effect';
import { afterEach, beforeEach, expect, it, rstest } from 'effect-rstest';

import { InvitePersonButton } from '../../src/routes/people/invite-person-button.tsx';
import { PeoplePanel } from '../../src/routes/people/people-panel.tsx';

const { commands } = rstest.hoisted(() => ({
  commands: {
    catalog: rstest.fn(),
    invite: rstest.fn(),
    linked: rstest.fn(),
    list: rstest.fn(),
    membership: rstest.fn(),
    role: rstest.fn(),
  },
}));
rstest.mock('../../src/routes/people/people-client.ts', () => ({
  changeCompanyMembership: commands.membership,
  changeScopedRole: commands.role,
  invitePerson: commands.invite,
  loadPeople: commands.list,
  loadPeopleForPerson: commands.linked,
  loadRoleCatalog: commands.catalog,
}));

const tenantId = '00000000-0000-4000-8000-000000000001';
const companyId = '00000000-0000-4000-8000-000000000002';
const principalRef = { principalId: '00000000-0000-4000-8000-000000000003', tenantId };
const membership = {
  affiliation: 'external',
  legalEntityId: companyId,
  principalRef,
  revision: 1,
  status: 'invited',
} as const;
const person = {
  displayName: 'Jana Nováková',
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
afterEach(cleanup);
beforeEach(() => {
  commands.catalog.mockReturnValue(
    Effect.succeed({
      status: 'ok',
      value: {
        items: [
          { description: 'Práce s přidělenými klienty.', name: 'Obchodník', roleKey: 'crm-sales', scope: list.scope },
        ],
      },
    }),
  );
  commands.list.mockReturnValue(Effect.succeed({ status: 'ok', value: list }));
  commands.linked.mockReturnValue(Effect.succeed({ status: 'ok', value: list }));
});

// oxlint-disable-next-line effect-native/no-promise-shaped-port -- Testing Library uses Promise-based DOM interactions at the test boundary; remove-when: rule recognizes Rstest callbacks.
it('invites a person by email and explicit affiliation, never by principal ID or agent kind', async () => {
  const user = userEvent.setup();
  const onCommitted = rstest.fn();
  commands.invite.mockReturnValue(
    Effect.succeed({
      status: 'ok',
      value: { delivery: 'pending', invitationId: '00000000-0000-4000-8000-000000000009', membership, principalRef },
    }),
  );
  render(
    <InvitePersonButton
      onCommitted={(change) => {
        onCommitted(change);
      }}
    />,
  );
  await user.click(screen.getByRole('button', { name: 'Pozvat člověka' }));
  await screen.findByRole('dialog');
  expect(screen.queryByLabelText('ID principála')).toBeNull();
  expect(screen.queryByLabelText('Druh přihlášení')).toBeNull();
  await user.type(screen.getByLabelText(/Jméno a příjmení/u), 'Jana Nováková');
  await user.type(screen.getByLabelText(/E-mail/u), 'jana@example.test');
  await user.selectOptions(screen.getByLabelText('Zařazení ve firmě'), 'external');
  await user.click(screen.getByRole('button', { name: 'Vytvořit pozvánku' }));
  await waitFor(() =>
    expect(commands.invite).toHaveBeenCalledWith({
      affiliation: 'external',
      displayName: 'Jana Nováková',
      email: 'jana@example.test',
    }),
  );
  await waitFor(() =>
    expect(onCommitted).toHaveBeenCalledWith({ kind: 'membership', result: { membership, projection: 'pending' } }),
  );
});

// oxlint-disable-next-line effect-native/no-promise-shaped-port -- Testing Library uses Promise-based DOM interactions at the test boundary; remove-when: rule recognizes Rstest callbacks.
it('opens the real person from a governed deep link in the same Shell page', async () => {
  render(<PeoplePanel companyId={companyId} linkedPerson={principalRef.principalId} />);
  await screen.findByRole('dialog', { name: 'Jana Nováková' });
  expect(commands.linked).toHaveBeenCalledWith('company', principalRef.principalId);
  expect(screen.getByRole('button', { name: 'Spravovat role' })).toBeDefined();
});

// oxlint-disable-next-line effect-native/no-promise-shaped-port -- Testing Library uses Promise-based DOM interactions at the test boundary; remove-when: rule recognizes Rstest callbacks.
it('keeps committed membership changes processing while the actual projection disagrees', async () => {
  const user = userEvent.setup();
  const departed = { ...membership, revision: 2, status: 'departed' } as const;
  commands.membership.mockReturnValue(
    Effect.succeed({ status: 'ok', value: { membership: departed, projection: 'pending' } }),
  );
  render(<PeoplePanel companyId={companyId} />);
  await user.click(await screen.findByRole('button', { name: 'Upravit členství' }));
  await user.selectOptions(screen.getByLabelText('Stav členství'), 'departed');
  await user.type(screen.getByLabelText(/Důvod změny/u), 'Odchod z firmy');
  commands.list.mockReturnValue(
    Effect.succeed({
      status: 'ok',
      value: {
        ...list,
        items: [
          {
            ...person,
            selectedCompanyMembership: departed,
            selectedCompanyMembershipProjection: { expectedMember: false, observedMember: true },
          },
        ],
      },
    }),
  );
  await user.click(screen.getByRole('button', { name: 'Potvrdit změnu' }));
  await screen.findByText(/Zpracovává se 1 změna\./u);
  expect(screen.getByText(/Osoba odešla z firmy/u)).toBeDefined();
});

// oxlint-disable-next-line effect-native/no-promise-shaped-port -- Testing Library DOM interactions are Promise-based; remove-when: rule recognizes Rstest callbacks.
it('selects a named role from the governed catalog without exposing identifiers', async () => {
  const user = userEvent.setup();
  commands.role.mockReturnValue(
    Effect.succeed({
      status: 'ok',
      value: {
        operation: 'assign',
        principalRef,
        projection: 'pending',
        role: { roleKey: 'crm-sales', scope: list.scope, tenantId },
      },
    }),
  );
  render(<PeoplePanel companyId={companyId} />);
  await user.click(await screen.findByRole('button', { name: 'Spravovat role' }));
  expect(screen.queryByLabelText('Klíč role')).toBeNull();
  expect(screen.queryByText(/SpiceDB/u)).toBeNull();
  await user.selectOptions(screen.getByRole('combobox', { name: 'Role' }), 'crm-sales');
  expect(screen.getByText('Práce s přidělenými klienty.')).toBeDefined();
  await user.type(screen.getByLabelText(/Důvod změny/u), 'Převzetí klientů');
  await user.click(screen.getByRole('button', { name: 'Potvrdit změnu' }));
  await waitFor(() =>
    expect(commands.role).toHaveBeenCalledWith('company', {
      operation: 'assign',
      principalRef,
      reason: 'Převzetí klientů',
      roleKey: 'crm-sales',
    }),
  );
});

// oxlint-disable-next-line effect-native/no-promise-shaped-port -- Testing Library DOM interactions are Promise-based; remove-when: rule recognizes Rstest callbacks.
it('renders role chips with Czech names rather than internal keys', async () => {
  commands.list.mockReturnValue(
    Effect.succeed({
      status: 'ok',
      value: {
        ...list,
        items: [{ ...person, roleAssignments: [{ roleKey: 'crm-sales', scope: list.scope, tenantId }] }],
      },
    }),
  );
  render(<PeoplePanel companyId={companyId} />);
  await screen.findByText('Obchodník');
  expect(screen.queryByText(/crm-sales/u)).toBeNull();
  expect(screen.queryByText(/00000000/u)).toBeNull();
});

it.effect('uses Czech cardinal forms as pending changes accumulate', () =>
  Effect.gen(function* pendingCounts() {
    const user = userEvent.setup();
    commands.role.mockReturnValue(
      Effect.succeed({
        status: 'ok',
        value: {
          operation: 'assign',
          principalRef,
          projection: 'pending',
          role: { roleKey: 'crm-sales', scope: list.scope, tenantId },
        },
      }),
    );
    render(<PeoplePanel companyId={companyId} />);
    yield* Effect.forEach(
      ['1 změna.', '2 změny.', '3 změny.', '4 změny.', '5 změn.'],
      (expected) =>
        Effect.promise(async () => {
          await user.click(await screen.findByRole('button', { name: 'Spravovat role' }));
          await user.selectOptions(screen.getByRole('combobox', { name: 'Role' }), 'crm-sales');
          await user.type(screen.getByLabelText(/Důvod změny/u), 'Převzetí agendy');
          await user.click(screen.getByRole('button', { name: 'Potvrdit změnu' }));
          await screen.findByText((text) => text.startsWith(`Zpracovává se ${expected}`));
        }),
      { concurrency: 1, discard: true },
    );
  }),
);

// oxlint-disable-next-line effect-native/no-promise-shaped-port -- Testing Library DOM interactions are Promise-based; remove-when: rule recognizes Rstest callbacks.
it('stacks full-width person-detail actions on narrow screens without fixed-height buttons', async () => {
  const user = userEvent.setup();
  render(<PeoplePanel companyId={companyId} />);
  await user.click(await screen.findByRole('button', { name: person.displayName }));
  const dialog = screen.getByRole('dialog');
  const roles = within(dialog).getByRole('button', { name: 'Spravovat role' });
  const membershipAction = within(dialog).getByRole('button', { name: 'Upravit členství' });
  expect(roles.parentElement).toBe(membershipAction.parentElement);
  expect(roles.parentElement?.className).toContain('grid w-full');
  for (const button of [roles, membershipAction]) {
    expect(button.className).toContain('w-full');
    expect(button.className).toContain('whitespace-normal');
    expect(button.className).not.toMatch(/(?:^|\s)h-/u);
  }
});
