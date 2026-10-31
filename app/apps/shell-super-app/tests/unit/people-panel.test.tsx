import { getI18nInstance as createModernI18n } from '@modern-js/plugin-i18n/i18n';
import type { I18nInstance } from '@modern-js/plugin-i18n/runtime';
import { ModernI18nProvider } from '@modern-js/plugin-i18n/runtime/consumer';
import { cleanup, render as renderView, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Effect } from 'effect';
import { afterEach, beforeAll, beforeEach, expect, it, rstest } from 'effect-rstest';
import type { PropsWithChildren, ReactElement } from 'react';

import csResource from '../../locales/cs/shell.json';
import { InvitePersonButton } from '../../src/routes/people/invite-person-button.tsx';
import { PeoplePanel } from '../../src/routes/people/people-panel.tsx';

let i18nInstance: I18nInstance;
beforeAll(async () => {
  i18nInstance = await createModernI18n();
  await i18nInstance.init({
    defaultNS: 'shell',
    lng: 'cs',
    ns: ['shell'],
    resources: { cs: { shell: csResource } },
    supportedLngs: ['cs', 'en'],
  });
});
const I18nProvider = ({ children }: PropsWithChildren) => (
  <ModernI18nProvider value={{ i18nInstance, language: 'cs', languages: ['cs', 'en'] }}>{children}</ModernI18nProvider>
);
const render = (ui: ReactElement) => renderView(ui, { wrapper: I18nProvider });

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

it.live('invites a person by email and explicit affiliation, never by principal ID or agent kind', () =>
  Effect.gen(function* invitePerson() {
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
    yield* Effect.promise(() => user.click(screen.getByRole('button', { name: 'Pozvat člověka' })));
    yield* Effect.promise(() => screen.findByRole('dialog'));
    expect(screen.queryByLabelText('ID principála')).toBeNull();
    expect(screen.queryByLabelText('Druh přihlášení')).toBeNull();
    yield* Effect.promise(() => user.type(screen.getByLabelText(/Jméno a příjmení/u), 'Jana Nováková'));
    yield* Effect.promise(() => user.type(screen.getByLabelText(/E-mail/u), 'jana@example.test'));
    yield* Effect.promise(() => user.selectOptions(screen.getByLabelText('Zařazení ve firmě'), 'external'));
    yield* Effect.promise(() => user.click(screen.getByRole('button', { name: 'Vytvořit pozvánku' })));
    yield* Effect.promise(() =>
      waitFor(() =>
        expect(commands.invite).toHaveBeenCalledWith({
          affiliation: 'external',
          displayName: 'Jana Nováková',
          email: 'jana@example.test',
        }),
      ),
    );
    yield* Effect.promise(() =>
      waitFor(() =>
        expect(onCommitted).toHaveBeenCalledWith({ kind: 'membership', result: { membership, projection: 'pending' } }),
      ),
    );
  }),
);

it.live('opens the real person from a governed deep link in the same Shell page', () =>
  Effect.gen(function* openLinkedPerson() {
    render(<PeoplePanel companyId={companyId} linkedPerson={principalRef.principalId} />);
    yield* Effect.promise(() => screen.findByRole('dialog', { name: 'Jana Nováková' }));
    expect(commands.linked).toHaveBeenCalledWith('company', principalRef.principalId);
    expect(screen.getByRole('button', { name: 'Spravovat role' })).toBeDefined();
  }),
);

it.live('keeps committed membership changes processing while the actual projection disagrees', () =>
  Effect.gen(function* keepMembershipPending() {
    const user = userEvent.setup();
    const departed = { ...membership, revision: 2, status: 'departed' } as const;
    commands.membership.mockReturnValue(
      Effect.succeed({ status: 'ok', value: { membership: departed, projection: 'pending' } }),
    );
    render(<PeoplePanel companyId={companyId} />);
    yield* Effect.flatMap(
      Effect.promise(() => screen.findByRole('button', { name: 'Upravit členství' })),
      (awaitedValue0) => Effect.promise(() => user.click(awaitedValue0)),
    );
    yield* Effect.promise(() => user.selectOptions(screen.getByLabelText('Stav členství'), 'departed'));
    yield* Effect.promise(() => user.type(screen.getByLabelText(/Důvod změny/u), 'Odchod z firmy'));
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
    yield* Effect.promise(() => user.click(screen.getByRole('button', { name: 'Potvrdit změnu' })));
    yield* Effect.promise(() => screen.findByText(/Zpracovává se 1 změna\./u));
    expect(screen.getByText(/Osoba odešla z firmy/u)).toBeDefined();
  }),
);

it.live('selects a named role from the governed catalog without exposing identifiers', () =>
  Effect.gen(function* assignNamedRole() {
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
    yield* Effect.flatMap(
      Effect.promise(() => screen.findByRole('button', { name: 'Spravovat role' })),
      (awaitedValue0) => Effect.promise(() => user.click(awaitedValue0)),
    );
    expect(screen.queryByLabelText('Klíč role')).toBeNull();
    expect(screen.queryByText(/SpiceDB/u)).toBeNull();
    yield* Effect.promise(() => user.selectOptions(screen.getByRole('combobox', { name: 'Role' }), 'crm-sales'));
    expect(screen.getByText('Práce s přidělenými klienty.')).toBeDefined();
    yield* Effect.promise(() => user.type(screen.getByLabelText(/Důvod změny/u), 'Převzetí klientů'));
    yield* Effect.promise(() => user.click(screen.getByRole('button', { name: 'Potvrdit změnu' })));
    yield* Effect.promise(() =>
      waitFor(() =>
        expect(commands.role).toHaveBeenCalledWith('company', {
          operation: 'assign',
          principalRef,
          reason: 'Převzetí klientů',
          roleKey: 'crm-sales',
        }),
      ),
    );
  }),
);

it.live('renders role chips with Czech names rather than internal keys', () =>
  Effect.gen(function* displayRoleNames() {
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
    yield* Effect.promise(() => screen.findByText('Obchodník'));
    expect(screen.queryByText(/crm-sales/u)).toBeNull();
    expect(screen.queryByText(/00000000/u)).toBeNull();
  }),
);

it.live('uses Czech cardinal forms as pending changes accumulate', () =>
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
      Effect.fn(function* advancePendingCount(expected: string) {
        yield* Effect.flatMap(
          Effect.promise(() => screen.findByRole('button', { name: 'Spravovat role' })),
          (awaitedValue0) => Effect.promise(() => user.click(awaitedValue0)),
        );
        yield* Effect.promise(() => user.selectOptions(screen.getByRole('combobox', { name: 'Role' }), 'crm-sales'));
        yield* Effect.promise(() => user.type(screen.getByLabelText(/Důvod změny/u), 'Převzetí agendy'));
        yield* Effect.promise(() => user.click(screen.getByRole('button', { name: 'Potvrdit změnu' })));
        const matchesExpectedCount = (text: string) => text.startsWith(`Zpracovává se ${expected}`);
        yield* Effect.promise(() => screen.findByText(matchesExpectedCount));
      }),
      { concurrency: 1, discard: true },
    );
  }),
);

it.live('stacks full-width person-detail actions on narrow screens without fixed-height buttons', () =>
  Effect.gen(function* renderResponsiveActions() {
    const user = userEvent.setup();
    render(<PeoplePanel companyId={companyId} />);
    yield* Effect.flatMap(
      Effect.promise(() => screen.findByRole('button', { name: person.displayName })),
      (awaitedValue0) => Effect.promise(() => user.click(awaitedValue0)),
    );
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
  }),
);

it.live('refreshes a person detail from waiting to the native undeliverable receipt', () =>
  Effect.gen(function* refreshInvitationReceipt() {
    const user = userEvent.setup();
    commands.list.mockReturnValue(
      Effect.succeed({
        status: 'ok',
        value: {
          ...list,
          items: [{ ...person, invitationDelivery: { status: 'pending' } }],
        },
      }),
    );
    render(<PeoplePanel companyId={companyId} />);
    yield* Effect.flatMap(
      Effect.promise(() => screen.findByRole('button', { name: person.displayName })),
      (awaitedValue0) => Effect.promise(() => user.click(awaitedValue0)),
    );
    yield* Effect.promise(() => screen.findByText('E-mail s pozvánkou: čeká na odeslání.'));
    commands.list.mockReturnValue(
      Effect.succeed({
        status: 'ok',
        value: {
          ...list,
          items: [{ ...person, invitationDelivery: { reason: 'recipient_unavailable', status: 'undeliverable' } }],
        },
      }),
    );
    yield* Effect.promise(() => user.click(screen.getByRole('button', { name: 'Zavřít' })));
    yield* Effect.promise(() => user.click(screen.getByRole('button', { name: 'Obnovit seznam' })));
    yield* Effect.flatMap(
      Effect.promise(() => screen.findByRole('button', { name: person.displayName })),
      (awaitedValue0) => Effect.promise(() => user.click(awaitedValue0)),
    );
    yield* Effect.promise(() =>
      screen.findByText('E-mail s pozvánkou: nelze doručit. Na tuto e-mailovou adresu nelze odesílat zprávy.'),
    );
    expect(screen.queryByText(/čeká na odeslání/u)).toBeNull();
    expect(screen.queryByText(/undeliverable_recipient/u)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Poslat pozvánku znovu' })).toBeNull();
  }),
);

it.live('loads the terminal invitation receipt on a fresh person deep link without local invite state', () =>
  Effect.gen(function* loadTerminalInvitationReceipt() {
    commands.linked.mockReturnValue(
      Effect.succeed({
        status: 'ok',
        value: {
          ...list,
          items: [{ ...person, invitationDelivery: { reason: 'recipient_unavailable', status: 'undeliverable' } }],
        },
      }),
    );
    render(<PeoplePanel companyId={companyId} linkedPerson={principalRef.principalId} />);
    yield* Effect.promise(() => screen.findByText(/E-mail s pozvánkou: nelze doručit/u));
    expect(screen.queryByText(/čeká na odeslání/u)).toBeNull();
  }),
);

it.live('distinguishes accepted mail from an unconfirmed interrupted delivery', () =>
  Effect.forEach(
    [
      { delivery: { status: 'sent' }, expected: /E-mail s pozvánkou: odesláno/u },
      { delivery: { status: 'unknown' }, expected: /E-mail s pozvánkou: doručení nelze ověřit/u },
    ] as const,
    ({ delivery, expected }) =>
      Effect.gen(function* displayDeliveryStatus() {
        commands.linked.mockReturnValue(
          Effect.succeed({
            status: 'ok',
            value: {
              ...list,
              items: [{ ...person, invitationDelivery: delivery }],
            },
          }),
        );
        render(<PeoplePanel companyId={companyId} linkedPerson={principalRef.principalId} />);
        yield* Effect.promise(() => screen.findByText(expected));
        expect(screen.queryByText(/čeká na odeslání/u)).toBeNull();
        cleanup();
      }),
    { concurrency: 1, discard: true },
  ),
);
