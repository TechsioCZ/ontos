import { getI18nInstance as createModernI18n } from '@modern-js/plugin-i18n/i18n';
import type { I18nInstance } from '@modern-js/plugin-i18n/runtime';
import { ModernI18nProvider } from '@modern-js/plugin-i18n/runtime/consumer';
import { cleanup, render as renderView, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { saveLabelsFor } from '@app/admin-ui';
import { moduleChangeEvent } from '@app/shared-contracts/page-data';
import { Effect, Schema } from 'effect';
import { afterEach, beforeAll, beforeEach, expect, it, rstest } from 'effect-rstest';
import type { PropsWithChildren, ReactElement } from 'react';

import csResource from '../../locales/cs/shell.json';
import {
  ListAccessPeopleOptionsResponseSchema,
  ListAccessPeopleResponseSchema,
} from '../../shared/access-admin-api.ts';
import { InvitePersonButton } from '../../src/routes/people/invite-person-button.tsx';
import { PeoplePanel } from '../../src/routes/people/people-panel.tsx';
import type { PeopleAccessView } from '../../src/routes/people/people-model.ts';

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
    access: rstest.fn(),
    invite: rstest.fn(),
    list: rstest.fn(),
    membership: rstest.fn(),
    role: rstest.fn(),
  },
}));
// Outside a router: no route change is ever blocked here.
rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  useBlocker: () => ({ status: 'idle' }),
}));
rstest.mock('../../src/routes/people/people-client.ts', () => ({
  changeCompanyMembership: commands.membership,
  changePersonRole: commands.role,
  invitePerson: commands.invite,
  loadAllPeople: commands.list,
  loadPeopleAccess: commands.access,
}));

const labels = saveLabelsFor('cs');
const tenantId = '00000000-0000-4000-8000-000000000001';
const companyId = '00000000-0000-4000-8000-000000000002';
const principalId = '00000000-0000-4000-8000-000000000003';
const principalRef = { principalId, tenantId };
const roleId = '00000000-0000-4000-8000-0000000000a1';
const roleRevisionId = '00000000-0000-4000-8000-0000000000b1';
const revision = 'people-revision-1';
const companyScope = { kind: 'company', legalEntityId: companyId } as const;
const membership = {
  affiliation: 'external',
  legalEntityId: companyId,
  principalRef,
  revision: 1,
  status: 'invited',
} as const;
/** Organisation data of the directory read: no role assignment and no trailing membership projection. */
const person = {
  displayName: 'Jana Nováková',
  invitationDelivery: null,
  kind: 'human',
  principalRef,
  principalStatus: 'active',
  selectedCompanyMembership: membership,
} as const;
const list = {
  items: [person],
  nextOffset: null,
  scope: { _tag: 'company', legalEntityId: companyId },
  tenantId,
} as const;

/** The canonical access view: the released role choices and the assignments of the same person. */
const accessRole = {
  capabilityKeys: [],
  latestRevisionId: roleRevisionId,
  name: 'Obchodník',
  risk: 'sensitive',
  roleId,
  scope: companyScope,
} as const;
type EncodedAssignments = (typeof ListAccessPeopleResponseSchema.Encoded)['items'][number]['assignments'];
const accessPerson = (assignments: EncodedAssignments) => ({
  assignments,
  delegations: [],
  displayName: person.displayName,
  memberships: [],
  ownership: { administersScopes: [], soleAdministratorScopes: [] },
  principalId,
  suspended: false,
  teams: [],
});
const accessView = (assignments: EncodedAssignments): PeopleAccessView => ({
  options: Schema.decodeUnknownSync(ListAccessPeopleOptionsResponseSchema)({
    capabilities: [],
    managers: [],
    people: [],
    revision,
    roles: [accessRole],
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
    items: [accessPerson(assignments)],
    nextCursor: null,
    revision,
  }),
});

afterEach(cleanup);
beforeEach(() => {
  commands.access.mockReturnValue(Effect.succeed({ status: 'ok', value: accessView([]) }));
  commands.list.mockReturnValue(Effect.succeed({ status: 'ok', value: list }));
});

/** Row actions live in the compact ⋯ menu of each row. */
const chooseRowAction = (user: ReturnType<typeof userEvent.setup>, name: string, action: string) =>
  Effect.gen(function* rowAction() {
    yield* Effect.promise(async () => await user.click(await screen.findByRole('button', { name: `Akce: ${name}` })));
    yield* Effect.promise(async () => await user.click(await screen.findByRole('menuitem', { name: action })));
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
    // Typing sends nothing; the one shared Save button sends the invitation once.
    expect(commands.invite).not.toHaveBeenCalled();
    yield* Effect.promise(() => user.click(screen.getByRole('button', { name: labels.save })));
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
    expect(commands.invite).toHaveBeenCalledTimes(1);
    // The sent invitation closes its dialog.
    yield* Effect.promise(() => waitFor(() => expect(screen.queryByLabelText(/Jméno a příjmení/u)).toBeNull()));
  }),
);

it.live('an invitation with typed input asks before closing; an untouched one closes at once', () =>
  Effect.gen(function* inviteLeave() {
    const user = userEvent.setup();
    render(<InvitePersonButton onCommitted={() => {}} />);
    yield* Effect.promise(() => user.click(screen.getByRole('button', { name: 'Pozvat člověka' })));
    yield* Effect.promise(() => user.click(screen.getByRole('button', { name: 'Zrušit' })));
    yield* Effect.promise(() => waitFor(() => expect(screen.queryByLabelText(/Jméno a příjmení/u)).toBeNull()));

    yield* Effect.promise(() => user.click(screen.getByRole('button', { name: 'Pozvat člověka' })));
    yield* Effect.promise(() => user.type(screen.getByLabelText(/Jméno a příjmení/u), 'Jana'));
    yield* Effect.promise(() => user.click(screen.getByRole('button', { name: 'Zrušit' })));
    const discard = yield* Effect.promise(() => screen.findByRole('button', { name: labels.discard }));
    yield* Effect.promise(() => user.click(discard));
    yield* Effect.promise(() =>
      waitFor(() => expect(screen.queryByLabelText(/Jméno a příjmení/u, { selector: 'input' })).toBeNull()),
    );
    expect(commands.invite).not.toHaveBeenCalled();
  }),
);

it.live('opens the real person from a governed deep link in the same Shell page', () =>
  Effect.gen(function* openLinkedPerson() {
    render(<PeoplePanel companyId={companyId} linkedPerson={principalRef.principalId} />);
    yield* Effect.promise(() => screen.findByRole('dialog', { name: 'Jana Nováková' }));
    expect(commands.list).toHaveBeenCalledWith('company');
    expect(commands.access).toHaveBeenCalledWith('company', companyId);
    expect(screen.getByRole('button', { name: 'Spravovat role' })).toBeDefined();
  }),
);

it.live('confirms a committed membership change from the organisation row it reads back', () =>
  Effect.gen(function* confirmMembership() {
    const user = userEvent.setup();
    const departed = { ...membership, revision: 2, status: 'departed' } as const;
    commands.membership.mockReturnValue(
      Effect.succeed({ status: 'ok', value: { membership: departed, projection: 'pending' } }),
    );
    render(<PeoplePanel companyId={companyId} />);
    yield* chooseRowAction(user, person.displayName, 'Upravit členství');
    yield* Effect.promise(() => user.selectOptions(screen.getByLabelText('Stav členství'), 'departed'));
    yield* Effect.promise(() => user.type(screen.getByLabelText(/Důvod změny/u), 'Odchod z firmy'));
    commands.list.mockReturnValue(
      Effect.succeed({
        status: 'ok',
        value: { ...list, items: [{ ...person, selectedCompanyMembership: departed }] },
      }),
    );
    // Filling in the change sends nothing; the one Save button sends it once.
    expect(screen.getAllByRole('button', { name: labels.save })).toHaveLength(1);
    yield* Effect.sleep('1 second');
    expect(commands.membership).not.toHaveBeenCalled();
    yield* Effect.promise(() => user.click(screen.getByRole('button', { name: 'Uložit' })));
    yield* Effect.promise(() =>
      waitFor(() =>
        expect(commands.membership).toHaveBeenCalledWith({
          affiliation: 'external',
          expectedRevision: 1,
          principalRef,
          reason: 'Odchod z firmy',
          status: 'departed',
        }),
      ),
    );
    expect(commands.membership).toHaveBeenCalledTimes(1);
    // The row read back is the confirmation, so the change never stays pending.
    yield* Effect.promise(() => waitFor(() => expect(screen.queryByText(/Zpracovává se/u)).toBeNull()));
    // An ended membership leaves the default view of current members, but stays one filter away.
    yield* Effect.promise(() => screen.findByText('Filtrům nikdo neodpovídá.'));
    yield* Effect.promise(() => user.click(screen.getByRole('button', { name: 'Zrušit filtry' })));
    const table = yield* Effect.promise(() => screen.findByRole('table'));
    yield* Effect.promise(() => within(table).findByText('Ukončený'));
  }),
);

it.live('assigns a named canonical role by its identity, never by a role key', () =>
  Effect.gen(function* assignNamedRole() {
    const user = userEvent.setup();
    const incarnationId = '00000000-0000-4000-8000-0000000000c1';
    commands.role.mockReturnValue(
      Effect.succeed({
        status: 'ok',
        value: { change: { incarnationId, present: true, principalId }, kind: 'role' },
      }),
    );
    render(<PeoplePanel companyId={companyId} />);
    yield* chooseRowAction(user, person.displayName, 'Spravovat role');
    expect(screen.queryByLabelText('Klíč role')).toBeNull();
    expect(screen.queryByText(/SpiceDB/u)).toBeNull();
    yield* Effect.promise(() => user.selectOptions(screen.getByRole('combobox', { name: 'Role' }), roleId));
    yield* Effect.promise(() => user.type(screen.getByLabelText(/Důvod změny/u), 'Převzetí klientů'));
    yield* Effect.promise(() => user.click(screen.getByRole('button', { name: labels.save })));
    yield* Effect.promise(() =>
      waitFor(() =>
        expect(commands.role).toHaveBeenCalledWith({
          operation: 'assign',
          payload: {
            expectedRevision: revision,
            expectedRoleRevisionId: roleRevisionId,
            principalId,
            roleId,
            scope: companyScope,
          },
        }),
      ),
    );
  }),
);

it.live('renders role chips from the canonical assignment names rather than internal keys', () =>
  Effect.gen(function* displayRoleNames() {
    commands.access.mockReturnValue(
      Effect.succeed({
        status: 'ok',
        value: accessView([
          {
            incarnationId: '00000000-0000-4000-8000-0000000000c1',
            principalId,
            roleId,
            roleName: 'Obchodník',
            scope: companyScope,
            status: 'active',
            validFrom: '2026-01-01T00:00:00.000Z',
            validUntil: null,
          },
        ]),
      }),
    );
    render(<PeoplePanel companyId={companyId} />);
    yield* Effect.promise(() => screen.findAllByText('Obchodník'));
    expect(screen.queryByText(/crm-sales/u)).toBeNull();
    expect(screen.queryByText(/00000000/u)).toBeNull();
  }),
);

it.live('uses Czech cardinal forms as pending canonical role changes accumulate', () =>
  Effect.gen(function* pendingCounts() {
    const user = userEvent.setup();
    let incarnation = 0;
    commands.role.mockImplementation(() => {
      incarnation += 1;
      return Effect.succeed({
        status: 'ok',
        value: {
          change: {
            incarnationId: `00000000-0000-4000-8000-${String(incarnation).padStart(12, '0')}`,
            present: true,
            principalId,
          },
          kind: 'role',
        },
      });
    });
    render(<PeoplePanel companyId={companyId} />);
    yield* Effect.forEach(
      ['1 změna.', '2 změny.', '3 změny.', '4 změny.', '5 změn.'],
      Effect.fn(function* advancePendingCount(expected: string) {
        yield* chooseRowAction(user, person.displayName, 'Spravovat role');
        yield* Effect.promise(() => user.selectOptions(screen.getByRole('combobox', { name: 'Role' }), roleId));
        yield* Effect.promise(() => user.type(screen.getByLabelText(/Důvod změny/u), 'Převzetí agendy'));
        yield* Effect.promise(() => user.click(screen.getByRole('button', { name: labels.save })));
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
    yield* Effect.promise(async () => await user.click(await screen.findByText(person.displayName)));
    const dialog = yield* Effect.promise(() => screen.findByRole('dialog'));
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

it.live('updates an open person detail from waiting to the native undeliverable receipt without a refresh button', () =>
  Effect.gen(function* refreshInvitationReceipt() {
    const user = userEvent.setup();
    commands.list.mockReturnValue(
      Effect.succeed({
        status: 'ok',
        value: { ...list, items: [{ ...person, invitationDelivery: { status: 'pending' } }] },
      }),
    );
    render(<PeoplePanel companyId={companyId} />);
    expect(screen.queryByRole('button', { name: 'Obnovit seznam' })).toBeNull();
    yield* Effect.promise(async () => await user.click(await screen.findByText(person.displayName)));
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
    // Returning to the tab reloads the list in place; the open detail follows the new receipt.
    document.dispatchEvent(new Event('visibilitychange'));
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
    commands.list.mockReturnValue(
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
        commands.list.mockReturnValue(
          Effect.succeed({
            status: 'ok',
            value: { ...list, items: [{ ...person, invitationDelivery: delivery }] },
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

it.live('reloads on a live change of Core-owned people data, not on other modules or a timer', () =>
  Effect.gen(function* followLiveChanges() {
    render(<PeoplePanel companyId={companyId} />);
    yield* Effect.promise(() => screen.findByText(person.displayName));
    const reads = () => commands.list.mock.calls.length;
    const before = reads();
    globalThis.dispatchEvent(new CustomEvent(moduleChangeEvent, { detail: { apps: ['crm'] } }));
    yield* Effect.sleep('50 millis');
    expect(reads()).toBe(before);
    commands.list.mockReturnValue(
      Effect.succeed({ status: 'ok', value: { ...list, items: [{ ...person, displayName: 'Jana Svobodová' }] } }),
    );
    globalThis.dispatchEvent(new CustomEvent(moduleChangeEvent, { detail: { apps: ['shell'] } }));
    yield* Effect.promise(() => screen.findByText('Jana Svobodová'));
    expect(reads()).toBe(before + 1);
  }),
);
