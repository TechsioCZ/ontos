// @rstest-environment happy-dom
import { requiredLabelFor, saveLabelsFor } from '@app/admin-ui';
import { acted, waitUntil } from '@app/admin-ui/testing/module-ui';
import { moduleChangeEvent } from '@app/shared-contracts/page-data';
import { browserNetwork, networkIdle, pinTestDocument, serveApi } from '@app/shared-contracts/testing/http-double';
import { HttpApi, HttpApiGroup } from '@modern-js/bff-effect/effect-client';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Effect, Layer, Schema } from 'effect';
import { afterEach, beforeEach, expect, it } from 'effect-rstest';
import type { ReactElement } from 'react';

import {
  accessAdminPeopleGroup,
  AccessPeopleMutationResponseSchema,
  ListAccessPeopleOptionsResponseSchema,
  ListAccessPeopleResponseSchema,
} from '../../shared/access-admin-api.ts';
import type { AssignAccessRolePayload, ListAccessPeoplePayload } from '../../shared/access-admin-api.ts';
import { ShellAuthenticationApi, shellAuthenticationApiContract } from '../../shared/browser-api.ts';
import {
  InvitePeopleResponseSchema,
  PeopleListResponseSchema,
  SetPeopleCompanyMembershipResponseSchema,
} from '../../shared/people-api.ts';
import type {
  InvitePeopleRequest,
  PeopleListRequest,
  SetPeopleCompanyMembershipRequest,
} from '../../shared/people-api.ts';
import { InvitePersonButton } from '../../src/routes/people/invite-person-button.tsx';
import { PeoplePanel } from '../../src/routes/people/people-panel.tsx';
import type { PeopleAccessView, PendingPeopleChange } from '../../src/routes/people/people-model.ts';
import { shellLocaleCopy } from '../support/shell-i18n.tsx';
import { makeShellRouter, renderShellRoute } from '../support/shell-router.tsx';

const render = (element: ReactElement) =>
  renderShellRoute(
    makeShellRouter({ page: { component: () => element, path: 'people' }, url: '/cs/people' }),
    shellLocaleCopy('cs'),
  );

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
    admissionCandidates: [],
    capabilities: [],
    managers: [],
    people: [],
    revision,
    roles: [accessRole],
    scopes: [{ label: 'Firma', scope: companyScope }],
    teams: [],
    writeAvailability: {
      canAdmitMember: false,
      canAssign: true,
      canDelegate: false,
      canEndMembership: false,
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

const assignment = (incarnationId: string) => ({
  incarnationId,
  principalId,
  roleId,
  roleName: 'Obchodník',
  scope: companyScope,
  status: 'active',
  validFrom: '2026-01-01T00:00:00.000Z',
  validUntil: null,
});
const inviteAnswer = Schema.decodeUnknownSync(InvitePeopleResponseSchema)({
  delivery: 'pending',
  invitationId: '00000000-0000-4000-8000-000000000009',
  membership,
  principalRef,
});
let listAnswer = Schema.decodeUnknownSync(PeopleListResponseSchema)(list);
let accessAnswer = accessView([]);
let membershipAnswer = Schema.decodeUnknownSync(SetPeopleCompanyMembershipResponseSchema)({
  membership,
  projection: 'pending',
});
const assignedRole = Schema.decodeUnknownSync(AccessPeopleMutationResponseSchema)({
  assignment: assignment('00000000-0000-4000-8000-0000000000c1'),
  revision,
});
let roleAnswer = Effect.succeed(assignedRole);
const invites: InvitePeopleRequest[] = [];
const memberships: SetPeopleCompanyMembershipRequest[] = [];
const roles: { readonly operation: 'assign'; readonly payload: AssignAccessRolePayload }[] = [];
const lists: { readonly payload: PeopleListRequest; readonly scope: 'company' }[] = [];
const accessReads: { readonly kind: 'options' | 'people'; readonly payload: ListAccessPeoplePayload }[] = [];

// The shared Shell double omits these endpoints; compose only the real contracts this panel calls.
const peopleEndpoints = ShellAuthenticationApi.groups.peopleAdministration.endpoints;
const accessEndpoints = accessAdminPeopleGroup.endpoints;
const PeopleApi = HttpApi.make('peoplePanelTest')
  .add(
    HttpApiGroup.make('peopleAdministration')
      .add(peopleEndpoints.invitePerson)
      .add(peopleEndpoints.listCompanyPeople)
      .add(peopleEndpoints.setPeopleCompanyMembership),
  )
  .add(
    HttpApiGroup.make('accessAdminPeople')
      .add(accessEndpoints.listAccessPeopleOptions)
      .add(accessEndpoints.listAccessPeople)
      .add(accessEndpoints.assignAccessRole),
  )
  .prefix(shellAuthenticationApiContract.apiPrefix);
const handlers = Layer.mergeAll(
  HttpApiBuilder.group(PeopleApi, 'peopleAdministration', (group) =>
    group
      .handle('invitePerson', ({ payload }) =>
        Effect.sync(() => {
          invites.push(payload);
          return inviteAnswer;
        }),
      )
      .handle('listCompanyPeople', ({ payload }) =>
        Effect.sync(() => {
          lists.push({ payload, scope: 'company' });
          return listAnswer;
        }),
      )
      .handle('setPeopleCompanyMembership', ({ payload }) =>
        Effect.sync(() => {
          memberships.push(payload);
          return membershipAnswer;
        }),
      ),
  ),
  HttpApiBuilder.group(PeopleApi, 'accessAdminPeople', (group) =>
    group
      .handle('listAccessPeopleOptions', ({ payload }) =>
        Effect.sync(() => {
          accessReads.push({ kind: 'options', payload });
          return accessAnswer.options;
        }),
      )
      .handle('listAccessPeople', ({ payload }) =>
        Effect.sync(() => {
          accessReads.push({ kind: 'people', payload });
          return accessAnswer.people;
        }),
      )
      .handle('assignAccessRole', ({ payload }) =>
        Effect.sync(() => {
          roles.push({ operation: 'assign', payload });
        }).pipe(Effect.andThen(() => roleAnswer)),
      ),
  ),
);
const network = browserNetwork(serveApi(PeopleApi, handlers));

afterEach(cleanup);
beforeEach(() => {
  listAnswer = Schema.decodeUnknownSync(PeopleListResponseSchema)(list);
  accessAnswer = accessView([]);
  membershipAnswer = Schema.decodeUnknownSync(SetPeopleCompanyMembershipResponseSchema)({
    membership,
    projection: 'pending',
  });
  roleAnswer = Effect.succeed(assignedRole);
  invites.length = 0;
  memberships.length = 0;
  roles.length = 0;
  lists.length = 0;
  accessReads.length = 0;
});

/** Row actions live in the compact ⋯ menu of each row. */
const chooseRowAction = (user: ReturnType<typeof userEvent.setup>, name: string, action: string) =>
  Effect.gen(function* rowAction() {
    yield* Effect.promise(async () => await user.click(await screen.findByRole('button', { name: `Akce: ${name}` })));
    yield* Effect.promise(async () => await user.click(await screen.findByRole('menuitem', { name: action })));
  });

it.live('invites a person by email and explicit affiliation, never by principal ID or agent kind', () =>
  Effect.gen(function* invitePerson() {
    yield* pinTestDocument;
    const user = userEvent.setup();
    const committed: PendingPeopleChange[] = [];

    yield* render(
      <InvitePersonButton
        onCommitted={(change) => {
          committed.push(change);
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
    yield* networkIdle;
    expect(invites).toHaveLength(0);
    yield* Effect.promise(() => user.click(screen.getByRole('button', { name: labels.save })));
    yield* waitUntil(() => invites.length === 1 && committed.length === 1);
    yield* networkIdle;
    expect(invites).toContainEqual({
      affiliation: 'external',
      displayName: 'Jana Nováková',
      email: 'jana@example.test',
    });
    expect(committed).toContainEqual({ kind: 'membership', result: { membership, projection: 'pending' } });
    expect(invites).toHaveLength(1);
    // The sent invitation closes its dialog.
    yield* waitUntil(() => screen.queryByLabelText(/Jméno a příjmení/u) === null);
    expect(screen.queryByLabelText(/Jméno a příjmení/u)).toBeNull();
  }).pipe(Effect.provide(network)),
);

it.live('an invitation with typed input asks before closing; an untouched one closes at once', () =>
  Effect.gen(function* inviteLeave() {
    yield* pinTestDocument;
    const user = userEvent.setup();
    yield* render(<InvitePersonButton onCommitted={() => {}} />);
    yield* Effect.promise(() => user.click(screen.getByRole('button', { name: 'Pozvat člověka' })));
    yield* Effect.promise(() => user.click(screen.getByRole('button', { name: 'Zrušit' })));
    yield* waitUntil(() => screen.queryByLabelText(/Jméno a příjmení/u) === null);
    expect(screen.queryByLabelText(/Jméno a příjmení/u)).toBeNull();

    yield* Effect.promise(() => user.click(screen.getByRole('button', { name: 'Pozvat člověka' })));
    yield* Effect.promise(() => user.type(screen.getByLabelText(/Jméno a příjmení/u), 'Jana'));
    yield* Effect.promise(() => user.click(screen.getByRole('button', { name: 'Zrušit' })));
    const discard = yield* Effect.promise(() => screen.findByRole('button', { name: labels.discard }));
    yield* Effect.promise(() => user.click(discard));
    yield* waitUntil(() => screen.queryByLabelText(/Jméno a příjmení/u, { selector: 'input' }) === null);
    expect(screen.queryByLabelText(/Jméno a příjmení/u, { selector: 'input' })).toBeNull();
    yield* networkIdle;
    expect(invites).toHaveLength(0);
  }).pipe(Effect.provide(network)),
);

it.live('reads the required text of a required field in Czech', () =>
  Effect.gen(function* requiredText() {
    yield* pinTestDocument;
    const user = userEvent.setup();
    yield* render(<InvitePersonButton onCommitted={() => {}} />);
    yield* Effect.promise(() => user.click(screen.getByRole('button', { name: 'Pozvat člověka' })));
    yield* Effect.promise(() => screen.findByRole('dialog'));
    const name = screen.getByLabelText(/Jméno a příjmení/u, { selector: 'input' });
    expect(document.querySelector(`label[for="${name.id}"]`)?.textContent).toContain(requiredLabelFor('cs'));
    expect(document.body.textContent).not.toContain('(required)');
  }).pipe(Effect.provide(network)),
);

it.live('opens the real person from a governed deep link in the same Shell page', () =>
  Effect.gen(function* openLinkedPerson() {
    yield* pinTestDocument;
    yield* render(<PeoplePanel companyId={companyId} linkedPerson={principalRef.principalId} />);
    yield* Effect.promise(() => screen.findByRole('dialog', { name: 'Jana Nováková' }));
    yield* networkIdle;
    expect(lists).toContainEqual({ payload: { limit: 100, offset: 0 }, scope: 'company' });
    expect(accessReads).toEqual([
      { kind: 'options', payload: { limit: 100, scope: companyScope } },
      { kind: 'people', payload: { limit: 100, scope: companyScope } },
    ]);
    expect(screen.getByRole('button', { name: 'Spravovat role' })).toBeDefined();
  }).pipe(Effect.provide(network)),
);

it.live('confirms a committed membership change from the organisation row it reads back', () =>
  Effect.gen(function* confirmMembership() {
    yield* pinTestDocument;
    const user = userEvent.setup();
    const departed = { ...membership, revision: 2, status: 'departed' } as const;
    membershipAnswer = Schema.decodeUnknownSync(SetPeopleCompanyMembershipResponseSchema)({
      membership: departed,
      projection: 'pending',
    });
    yield* render(<PeoplePanel companyId={companyId} />);
    yield* chooseRowAction(user, person.displayName, 'Upravit členství');
    yield* Effect.promise(() => user.selectOptions(screen.getByLabelText('Stav členství'), 'departed'));
    yield* Effect.promise(() => user.type(screen.getByLabelText(/Důvod změny/u), 'Odchod z firmy'));
    listAnswer = Schema.decodeUnknownSync(PeopleListResponseSchema)({
      ...list,
      items: [{ ...person, selectedCompanyMembership: departed }],
    });
    // Filling in the change sends nothing; the one Save button sends it once.
    expect(screen.getAllByRole('button', { name: labels.save })).toHaveLength(1);
    yield* networkIdle;
    expect(memberships).toHaveLength(0);
    yield* Effect.promise(() => user.click(screen.getByRole('button', { name: 'Uložit' })));
    yield* waitUntil(() => memberships.length === 1);
    yield* networkIdle;
    expect(memberships).toContainEqual({
      affiliation: 'external',
      expectedRevision: 1,
      principalRef,
      reason: 'Odchod z firmy',
      status: 'departed',
    });
    expect(memberships).toHaveLength(1);
    // The row read back is the confirmation, so the change never stays pending.
    yield* waitUntil(() => screen.queryByText(/Zpracovává se/u) === null);
    expect(screen.queryByText(/Zpracovává se/u)).toBeNull();
    // An ended membership leaves the default view of current members, but stays one filter away.
    yield* Effect.promise(() => screen.findByText('Filtrům nikdo neodpovídá.'));
    yield* Effect.promise(() => user.click(screen.getByRole('button', { name: 'Zrušit filtry' })));
    const table = yield* Effect.promise(() => screen.findByRole('table'));
    yield* Effect.promise(() => within(table).findByText('Ukončený'));
  }).pipe(Effect.provide(network)),
);

it.live('assigns a named canonical role by its identity, never by a role key', () =>
  Effect.gen(function* assignNamedRole() {
    yield* pinTestDocument;
    const user = userEvent.setup();

    yield* render(<PeoplePanel companyId={companyId} />);
    yield* chooseRowAction(user, person.displayName, 'Spravovat role');
    expect(screen.queryByLabelText('Klíč role')).toBeNull();
    expect(screen.queryByText(/SpiceDB/u)).toBeNull();
    yield* Effect.promise(() => user.selectOptions(screen.getByRole('combobox', { name: 'Role' }), roleId));
    yield* Effect.promise(() => user.type(screen.getByLabelText(/Důvod změny/u), 'Převzetí klientů'));
    yield* Effect.promise(() => user.click(screen.getByRole('button', { name: labels.save })));
    yield* waitUntil(() => roles.length === 1);
    expect(roles).toContainEqual({
      operation: 'assign',
      payload: {
        expectedRevision: revision,
        expectedRoleRevisionId: roleRevisionId,
        principalId,
        roleId,
        scope: companyScope,
      },
    });
  }).pipe(Effect.provide(network)),
);

it.live('renders role chips from the canonical assignment names rather than internal keys', () =>
  Effect.gen(function* displayRoleNames() {
    yield* pinTestDocument;
    accessAnswer = accessView([
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
    ]);
    yield* render(<PeoplePanel companyId={companyId} />);
    yield* Effect.promise(() => screen.findAllByText('Obchodník'));
    yield* networkIdle;
    expect(screen.queryByText(/crm-sales/u)).toBeNull();
    expect(screen.queryByText(/00000000/u)).toBeNull();
  }).pipe(Effect.provide(network)),
);

it.live('uses Czech cardinal forms as pending canonical role changes accumulate', () =>
  Effect.gen(function* pendingCounts() {
    yield* pinTestDocument;
    const user = userEvent.setup();
    let incarnation = 0;
    roleAnswer = Effect.sync(() => {
      incarnation += 1;
      return Schema.decodeUnknownSync(AccessPeopleMutationResponseSchema)({
        assignment: assignment(`00000000-0000-4000-8000-${String(incarnation).padStart(12, '0')}`),
        revision,
      });
    });

    yield* render(<PeoplePanel companyId={companyId} />);
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
  }).pipe(Effect.provide(network)),
);

it.live('stacks full-width person-detail actions on narrow screens without fixed-height buttons', () =>
  Effect.gen(function* renderResponsiveActions() {
    yield* pinTestDocument;
    const user = userEvent.setup();
    yield* render(<PeoplePanel companyId={companyId} />);
    yield* Effect.promise(async () => await user.click(await screen.findByText(person.displayName)));
    const dialog = yield* Effect.promise(() => screen.findByRole('dialog'));
    const roleAction = within(dialog).getByRole('button', { name: 'Spravovat role' });
    const membershipAction = within(dialog).getByRole('button', { name: 'Upravit členství' });
    expect(roleAction.parentElement).toBe(membershipAction.parentElement);
    expect(roleAction.parentElement?.className).toContain('grid w-full');
    for (const button of [roleAction, membershipAction]) {
      expect(button.className).toContain('w-full');
      expect(button.className).toContain('whitespace-normal');
      expect(button.className).not.toMatch(/(?:^|\s)h-/u);
    }
  }).pipe(Effect.provide(network)),
);

it.live('updates an open person detail from waiting to the native undeliverable receipt without a refresh button', () =>
  Effect.gen(function* refreshInvitationReceipt() {
    yield* pinTestDocument;
    const user = userEvent.setup();
    listAnswer = Schema.decodeUnknownSync(PeopleListResponseSchema)({
      ...list,
      items: [{ ...person, invitationDelivery: { status: 'pending' } }],
    });
    yield* render(<PeoplePanel companyId={companyId} />);
    expect(screen.queryByRole('button', { name: 'Obnovit seznam' })).toBeNull();
    yield* Effect.promise(async () => await user.click(await screen.findByText(person.displayName)));
    yield* Effect.promise(() => screen.findByText('E-mail s pozvánkou: čeká na odeslání.'));
    listAnswer = Schema.decodeUnknownSync(PeopleListResponseSchema)({
      ...list,
      items: [{ ...person, invitationDelivery: { reason: 'recipient_unavailable', status: 'undeliverable' } }],
    });
    // Returning to the tab reloads the list in place; the open detail follows the new receipt.
    yield* acted(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    yield* Effect.promise(() =>
      screen.findByText('E-mail s pozvánkou: nelze doručit. Na tuto e-mailovou adresu nelze odesílat zprávy.'),
    );
    yield* networkIdle;
    expect(screen.queryByText(/čeká na odeslání/u)).toBeNull();
    expect(screen.queryByText(/undeliverable_recipient/u)).toBeNull();
  }).pipe(Effect.provide(network)),
);

it.live('loads the terminal invitation receipt on a fresh person deep link without local invite state', () =>
  Effect.gen(function* loadTerminalInvitationReceipt() {
    yield* pinTestDocument;
    listAnswer = Schema.decodeUnknownSync(PeopleListResponseSchema)({
      ...list,
      items: [{ ...person, invitationDelivery: { reason: 'recipient_unavailable', status: 'undeliverable' } }],
    });
    yield* render(<PeoplePanel companyId={companyId} linkedPerson={principalRef.principalId} />);
    yield* Effect.promise(() => screen.findByText(/E-mail s pozvánkou: nelze doručit/u));
    yield* networkIdle;
    expect(screen.queryByText(/čeká na odeslání/u)).toBeNull();
  }).pipe(Effect.provide(network)),
);

it.live('distinguishes accepted mail from an unconfirmed interrupted delivery', () =>
  Effect.forEach(
    [
      { delivery: { status: 'sent' }, expected: /E-mail s pozvánkou: odesláno/u },
      { delivery: { status: 'unknown' }, expected: /E-mail s pozvánkou: doručení nelze ověřit/u },
    ] as const,
    ({ delivery, expected }) =>
      Effect.gen(function* displayDeliveryStatus() {
        yield* pinTestDocument;
        listAnswer = Schema.decodeUnknownSync(PeopleListResponseSchema)({
          ...list,
          items: [{ ...person, invitationDelivery: delivery }],
        });
        yield* render(<PeoplePanel companyId={companyId} linkedPerson={principalRef.principalId} />);
        yield* Effect.promise(() => screen.findByText(expected));
        yield* networkIdle;
        expect(screen.queryByText(/čeká na odeslání/u)).toBeNull();
        cleanup();
      }),
    { concurrency: 1, discard: true },
  ).pipe(Effect.provide(network)),
);

it.live('reloads on a live change of Core-owned people data, not on other modules or a timer', () =>
  Effect.gen(function* followLiveChanges() {
    yield* pinTestDocument;
    yield* render(<PeoplePanel companyId={companyId} />);
    yield* Effect.promise(() => screen.findByText(person.displayName));
    yield* networkIdle;
    const before = lists.length;
    yield* acted(() => {
      window.dispatchEvent(new CustomEvent(moduleChangeEvent, { detail: { apps: ['crm'] } }));
    });
    // A reload the unrelated change started has reached the BFF by the time the network is idle.
    yield* networkIdle;
    expect(lists.length).toBe(before);
    listAnswer = Schema.decodeUnknownSync(PeopleListResponseSchema)({
      ...list,
      items: [{ ...person, displayName: 'Jana Svobodová' }],
    });
    yield* acted(() => {
      window.dispatchEvent(new CustomEvent(moduleChangeEvent, { detail: { apps: ['shell'] } }));
    });
    yield* Effect.promise(() => screen.findByText('Jana Svobodová'));
    yield* networkIdle;
    expect(lists.length).toBe(before + 1);
  }).pipe(Effect.provide(network)),
);
