import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Effect } from 'effect';
import { afterEach, beforeEach, expect, it, rstest } from 'effect-rstest';

import { InvitePersonButton } from '../../src/routes/people/invite-person-button.tsx';
import { PeoplePanel } from '../../src/routes/people/people-panel.tsx';

const { commands } = rstest.hoisted(() => ({
  commands: {
    invite: rstest.fn(),
    list: rstest.fn(),
    linked: rstest.fn(),
    membership: rstest.fn(),
    role: rstest.fn(),
  },
}));
rstest.mock('../../src/routes/people/people-client.ts', () => ({
  invitePerson: commands.invite,
  loadPeople: commands.list,
  loadPeopleForPerson: commands.linked,
  changeCompanyMembership: commands.membership,
  changeScopedRole: commands.role,
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
  commands.list.mockReturnValue(Effect.succeed({ status: 'ok', value: list }));
  commands.linked.mockReturnValue(Effect.succeed({ status: 'ok', value: list }));
});

it('invites a person by email and explicit affiliation, never by principal ID or agent kind', async () => {
  const user = userEvent.setup();
  const onCommitted = rstest.fn();
  commands.invite.mockReturnValue(
    Effect.succeed({
      status: 'ok',
      value: { delivery: 'pending', invitationId: '00000000-0000-4000-8000-000000000009', membership, principalRef },
    }),
  );
  render(<InvitePersonButton onCommitted={onCommitted} />);
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

it('opens the real person from a governed deep link in the same Shell page', async () => {
  render(<PeoplePanel companyId={companyId} linkedPerson={principalRef.principalId} />);
  await screen.findByRole('dialog', { name: 'Jana Nováková' });
  expect(commands.linked).toHaveBeenCalledWith('company', principalRef.principalId);
  expect(screen.getByRole('button', { name: 'Spravovat role' })).toBeDefined();
});

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
  await screen.findByText(/Zpracovává se 1 změn/u);
  expect(screen.getByText(/Osoba odešla z firmy/u)).toBeDefined();
});
