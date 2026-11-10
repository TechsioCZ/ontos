import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DateTime, Effect, Predicate, Schema } from 'effect';
import { afterEach, expect, it, rstest, test } from 'effect-rstest';

import cs from '../../locales/cs/shell.json';
import en from '../../locales/en/shell.json';
import {
  AccessAdminConflictProblemSchema,
  AccessAdminForbiddenProblemSchema,
  AccessAdminUnavailableProblemSchema,
  AccessPeopleMutationResponseSchema,
  ListAccessPeopleOptionsResponseSchema,
  ListAccessPeopleResponseSchema,
} from '../../shared/access-admin-api.ts';
import { loadPeopleData } from '../../src/routes/[lang]/access/people/people-page-model.ts';
import type { PeopleReadPort, PeopleSnapshot } from '../../src/routes/[lang]/access/people/people-page-model.ts';
import { submitPeopleCommand } from '../../src/routes/access-admin/people/people-commands.ts';
import type { PeopleMutationPort } from '../../src/routes/access-admin/people/people-commands.ts';
import { toPeopleViewModel } from '../../src/routes/access-admin/people/people-presentation.ts';
import { PeopleView } from '../../src/routes/access-admin/people/people-view.tsx';
import type { PeopleCommand, PeopleFeedback } from '../../src/routes/access-admin/people/people-view-model.ts';
import { authenticatedShellFixture } from './routes/authenticated-shell-fixture.ts';

const { locale } = rstest.hoisted(() => ({ locale: { current: 'en' } }));
const flatten = (node: typeof Schema.Json.Type, prefix = ''): [string, string][] => {
  if (Predicate.isString(node)) {
    return [[prefix, node]];
  }
  if (!Schema.is(Schema.JsonObject)(node)) {
    return [];
  }
  return Object.entries(node).flatMap(([key, value]) => flatten(value, prefix.length === 0 ? key : `${prefix}.${key}`));
};
const english = new Map(flatten(en));
const czech = new Map(flatten(cs));
const translate = (key: string, values?: Record<string, string | number>) => {
  let label = (locale.current === 'cs' ? czech : english).get(key) ?? key;
  for (const [name, value] of Object.entries(values ?? {})) {
    label = label.replaceAll(`{{${name}}}`, String(value));
  }
  return label;
};

rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({ language: locale.current, t: translate }),
}));

const personId = '00000000-0000-4000-8000-000000000001';
const managerId = '00000000-0000-4000-8000-000000000002';
const companyId = '00000000-0000-4000-8000-000000000003';
const roleId = '00000000-0000-4000-8000-000000000004';
const roleRevisionId = '00000000-0000-4000-8000-000000000005';
const assignmentId = '00000000-0000-4000-8000-000000000006';
const delegationId = '00000000-0000-4000-8000-000000000007';
const teamId = '00000000-0000-4000-8000-000000000008';
const company = { kind: 'company', legalEntityId: companyId };
const revision = 'people-revision-1';
const capability = 'commerce.order.order.confirm';
const from = '2026-10-01T00:00:00.000Z';
const until = '2026-12-01T10:00:00.000Z';

const fixture = () => {
  const people = Schema.decodeUnknownSync(ListAccessPeopleResponseSchema)({
    items: [
      {
        assignments: [
          {
            incarnationId: assignmentId,
            principalId: personId,
            roleId,
            roleName: 'Buyer',
            scope: company,
            status: 'active',
            validFrom: from,
            validUntil: until,
          },
        ],
        delegations: [
          {
            amountCeiling: { currency: 'CZK', limitMinor: 500_000 },
            capabilityKeys: [capability],
            delegationId,
            managerId,
            people: [personId],
            roleIds: [roleId],
            scope: company,
            status: 'active',
            validFrom: from,
            validUntil: until,
          },
        ],
        displayName: 'Ada Lovelace',
        memberships: [{ kind: 'owner', scope: company, status: 'suspended', validFrom: from, validUntil: null }],
        ownership: { administersScopes: [company], soleAdministratorScopes: [company] },
        principalId: personId,
        suspended: true,
        teams: [{ name: 'Purchasing', scope: company, teamId }],
      },
    ],
    nextCursor: null,
    revision,
  });
  const choice = {
    canTakeOwnershipOfScopes: [],
    displayName: 'Ada Lovelace',
    memberOfScopes: [company],
    principalId: personId,
    soleAdministratorScopes: [company],
  };
  const options = Schema.decodeUnknownSync(ListAccessPeopleOptionsResponseSchema)({
    admissionCandidates: [],
    capabilities: [
      {
        capabilityKey: capability,
        hasAmountInput: true,
        moduleKey: 'commerce.order',
        risk: 'sensitive',
        withinGrantorAuthority: true,
      },
    ],
    managers: [{ ...choice, displayName: 'Grace Hopper', principalId: managerId }],
    people: [choice, { ...choice, displayName: 'Grace Hopper', principalId: managerId }],
    revision,
    roles: [
      {
        capabilityKeys: [capability],
        latestRevisionId: roleRevisionId,
        name: 'Buyer',
        risk: 'sensitive',
        roleId,
        scope: company,
      },
    ],
    scopes: [{ label: 'Alpha s.r.o.', scope: company }],
    teams: [{ name: 'Purchasing', scope: company, teamId }],
    writeAvailability: {
      canAdmitMember: false,
      canAssign: true,
      canDelegate: true,
      canEndMembership: false,
      canManageTeams: true,
      canRevokeDelegation: true,
      canTransferOwnership: false,
      canUnassign: true,
    },
  });
  const snapshot: PeopleSnapshot = {
    options: Schema.encodeSync(ListAccessPeopleOptionsResponseSchema)(options),
    people: Schema.encodeSync(ListAccessPeopleResponseSchema)(people),
  };
  return { options, people, snapshot };
};

const model = (snapshot = fixture().snapshot) =>
  toPeopleViewModel(snapshot, { locale: locale.current, tenant: 'Tenant', unknown: 'Unknown' });
const readPort = (): PeopleReadPort => {
  const data = fixture();
  return { list: () => Effect.succeed(data.people), options: () => Effect.succeed(data.options) };
};
const mutationPort = () => {
  const response = Schema.decodeUnknownSync(AccessPeopleMutationResponseSchema)({ revision: 'people-revision-2' });
  return {
    admit: rstest.fn<PeopleMutationPort['admit']>(() => Effect.succeed(response)),
    assign: rstest.fn<PeopleMutationPort['assign']>(() => Effect.succeed(response)),
    delegate: rstest.fn<PeopleMutationPort['delegate']>(() => Effect.succeed(response)),
    endMembership: rstest.fn<PeopleMutationPort['endMembership']>(() => Effect.succeed(response)),
    revokeAssignment: rstest.fn<PeopleMutationPort['revokeAssignment']>(() => Effect.succeed(response)),
    revokeDelegation: rstest.fn<PeopleMutationPort['revokeDelegation']>(() => Effect.succeed(response)),
    team: rstest.fn<PeopleMutationPort['team']>(() => Effect.succeed(response)),
  };
};
const commandInput = (command: PeopleCommand, snapshot = fixture().snapshot) => ({
  command,
  expectedRevision: revision,
  options: { idempotencyKey: 'people-ui-test' },
  reason: 'User confirmed the named change',
  snapshot,
});
const renderPeople = (snapshot = fixture().snapshot, feedback: PeopleFeedback = 'idle') => {
  const callbacks = {
    onCommand: rstest.fn<(command: PeopleCommand, revision: string) => void>(),
    onNextPage: rstest.fn<() => void>(),
    onRefresh: rstest.fn<() => void>(),
  };
  const rendered = render(<PeopleView feedback={feedback} model={model(snapshot)} {...callbacks} />);
  return { ...rendered, ...callbacks };
};

afterEach(() => {
  cleanup();
  locale.current = 'en';
  rstest.clearAllMocks();
});

it.effect('tenant-only administration reads data without a selected company', () =>
  Effect.gen(function* tenantOnly() {
    const { selectedLegalEntityId: ignored, ...shell } = authenticatedShellFixture();
    void ignored;
    const list = rstest.fn<PeopleReadPort['list']>(readPort().list);
    const result = yield* loadPeopleData({ ...shell, contextState: 'selection_required' }, {}, undefined, {
      ...readPort(),
      list,
    });
    expect(result.state).toBe('ready');
    expect(list).toHaveBeenCalledWith({ limit: 50 }, {});
    if (result.state === 'ready') {
      expect(result.snapshot.people.items[0]?.assignments[0]?.validUntil).toBe(until);
    }
  }),
);

it.effect('anonymous sessions never call the people directory', () =>
  Effect.gen(function* anonymous() {
    const list = rstest.fn<PeopleReadPort['list']>(readPort().list);
    const result = yield* loadPeopleData({ state: 'anonymous' }, {}, undefined, { ...readPort(), list });
    expect(result.state).toBe('unauthenticated');
    expect(list).not.toHaveBeenCalled();
  }),
);

it.effect('read denial and a retryable outage remain distinct and expose no people', () =>
  Effect.gen(function* readFailures() {
    const forbidden = Schema.decodeUnknownSync(AccessAdminForbiddenProblemSchema)({
      _tag: 'AccessAdminForbidden',
      detail: 'Denied',
      status: 403,
      title: 'Forbidden',
      type: 'about:blank',
    });
    const unavailable = Schema.decodeUnknownSync(AccessAdminUnavailableProblemSchema)({
      _tag: 'AccessAdminUnavailable',
      detail: 'Retry',
      retryable: true,
      status: 503,
      title: 'Unavailable',
      type: 'about:blank',
    });
    for (const [failure, expected] of [
      [forbidden, 'forbidden'],
      [unavailable, 'unavailable'],
    ] as const) {
      const result = yield* loadPeopleData(authenticatedShellFixture(), {}, undefined, {
        ...readPort(),
        list: () => Effect.fail(failure),
      });
      expect(result.state).toBe(expected);
      expect('snapshot' in result).toBe(false);
    }
  }),
);

it.effect('mismatched list and choice revisions cannot become an editable snapshot', () =>
  Effect.gen(function* mismatchedRevisions() {
    const options = Schema.decodeUnknownSync(ListAccessPeopleOptionsResponseSchema)({
      ...fixture().snapshot.options,
      revision: 'changed',
    });
    const result = yield* loadPeopleData(authenticatedShellFixture(), {}, undefined, {
      ...readPort(),
      options: () => Effect.succeed(options),
    });
    expect(result.state).toBe('conflict');
    expect('snapshot' in result).toBe(false);
  }),
);

test('shows suspended memberships independently from live role assignments and fixed delegation bounds', () => {
  renderPeople();
  expect(screen.getAllByText('Suspended')).toHaveLength(2);
  expect(screen.getByText(translate('shell.accessAdmin.people.membershipHelp'))).toBeTruthy();
  expect(screen.getByText('Grace Hopper')).toBeTruthy();
  expect(screen.getByText(capability)).toBeTruthy();
  expect(screen.getAllByText(/Alpha s.r.o./u).length).toBeGreaterThan(0);
  expect(screen.getByText(translate('shell.accessAdmin.people.lastOwnerTransfer'))).toBeTruthy();
  expect(screen.getByText(translate('shell.accessAdmin.people.transferUnavailable'))).toBeTruthy();
  expect(screen.queryByRole('button', { name: /agent/iu })).toBeNull();
});

it.effect('removing a role requires an explicit confirmation that preserves membership', () =>
  Effect.gen(function* removalDialog() {
    const view = renderPeople();
    fireEvent.click(
      screen.getByRole('button', {
        name: translate('shell.accessAdmin.accessible.removeRoleNamed', { person: 'Ada Lovelace', role: 'Buyer' }),
      }),
    );
    expect(view.onCommand).not.toHaveBeenCalled();
    const dialog = yield* Effect.promise(() => screen.findByRole('dialog'));
    expect(within(dialog).getByText(translate('shell.accessAdmin.people.membershipHelp'))).toBeTruthy();
    expect(within(dialog).getByText(translate('shell.accessAdmin.people.lastOwnerTransfer'))).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    expect(view.onCommand).toHaveBeenCalledWith({ assignmentId, kind: 'remove-role' }, revision);
  }),
);

it.effect('cancel and stale-preview controls never submit a removal', () =>
  Effect.gen(function* staleDialog() {
    const view = renderPeople();
    const removalName = translate('shell.accessAdmin.accessible.removeRoleNamed', {
      person: 'Ada Lovelace',
      role: 'Buyer',
    });
    fireEvent.click(screen.getByRole('button', { name: removalName }));
    const dialog = yield* Effect.promise(() => screen.findByRole('dialog'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(view.onCommand).not.toHaveBeenCalled();
    const removeAgain = yield* Effect.promise(() => screen.findByRole('button', { name: removalName }));
    fireEvent.click(removeAgain);
    yield* Effect.promise(() => screen.findByRole('dialog'));
    view.rerender(
      <PeopleView
        feedback="idle"
        model={{ ...model(), revision: 'changed' }}
        {...{ onCommand: view.onCommand, onNextPage: view.onNextPage, onRefresh: view.onRefresh }}
      />,
    );
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: 'Confirm' }).hasAttribute('disabled')).toBe(
      true,
    );
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Confirm' }));
    expect(view.onCommand).not.toHaveBeenCalled();
  }),
);

test('unavailable writers leave role, team and delegation mutation affordances disabled', () => {
  const { snapshot } = fixture();
  renderPeople({
    ...snapshot,
    options: {
      ...snapshot.options,
      writeAvailability: {
        canAdmitMember: false,
        canAssign: false,
        canDelegate: false,
        canEndMembership: false,
        canManageTeams: false,
        canRevokeDelegation: false,
        canTransferOwnership: false,
        canUnassign: false,
      },
    },
  });
  expect(screen.getByText(translate('shell.accessAdmin.people.previewOnly'))).toBeTruthy();
  for (const label of [
    translate('shell.accessAdmin.accessible.removeRoleNamed', { person: 'Ada Lovelace', role: 'Buyer' }),
    translate('shell.accessAdmin.people.teamRemove'),
    translate('shell.accessAdmin.people.delegationRevoke'),
  ]) {
    expect(screen.getByRole('button', { name: label }).hasAttribute('disabled')).toBe(true);
  }
});

it.effect('assignment submits only the chosen scope, pinned revision and expiry to the typed client', () =>
  Effect.gen(function* assignment() {
    const port = mutationPort();
    const result = yield* submitPeopleCommand(
      commandInput({ expiryInput: until, kind: 'assign', personId, roleId, scopeId: companyId }),
      port,
    );
    expect(result).toBe('saved');
    const [payload, options] = port.assign.mock.calls[0] ?? [];
    expect(payload?.expectedRoleRevisionId).toBe(roleRevisionId);
    expect(payload?.expectedRevision).toBe(revision);
    expect(payload?.scope).toEqual(company);
    expect(payload?.validUntil === undefined ? undefined : DateTime.formatIso(payload.validUntil)).toBe(until);
    expect(options).toEqual({ idempotencyKey: 'people-ui-test' });
    expect(payload).not.toHaveProperty('tenantId');
    expect(payload).not.toHaveProperty('isAdministrator');
  }),
);

it.effect('role removal references the immutable assignment, never a membership', () =>
  Effect.gen(function* roleRemoval() {
    const port = mutationPort();
    yield* submitPeopleCommand(commandInput({ assignmentId, kind: 'remove-role' }), port);
    expect(port.revokeAssignment.mock.calls[0]?.[0]).toEqual({
      expectedRevision: revision,
      incarnationId: assignmentId,
      reason: 'User confirmed the named change',
    });
    expect(port.team).not.toHaveBeenCalled();
  }),
);

it.effect('unknown role choices and stale snapshots never reach mutation clients', () =>
  Effect.gen(function* staleChoices() {
    const port = mutationPort();
    const command: PeopleCommand = {
      expiryInput: until,
      kind: 'assign',
      personId,
      roleId: 'unknown',
      scopeId: companyId,
    };
    expect(yield* submitPeopleCommand(commandInput(command), port)).toBe('invalid');
    expect(yield* submitPeopleCommand({ ...commandInput(command), expectedRevision: 'stale' }, port)).toBe('conflict');
    expect(port.assign).not.toHaveBeenCalled();
  }),
);

it.effect('delegation requires named allowed choices and expiry, never arbitrary keys', () =>
  Effect.gen(function* delegation() {
    const port = mutationPort();
    const command: PeopleCommand = {
      amountMinor: '500000',
      capabilities: [capability],
      currency: 'CZK',
      expiryInput: until,
      kind: 'delegate',
      managerId,
      people: [personId],
      roles: [roleId],
      scopeId: companyId,
    };
    expect(yield* submitPeopleCommand(commandInput(command), port)).toBe('saved');
    expect(port.delegate.mock.calls[0]?.[0].amountCeiling).toEqual({ currency: 'CZK', limitMinor: 500_000 });
    expect(
      yield* submitPeopleCommand(commandInput({ ...command, capabilities: ['arbitrary.capability.grant'] }), port),
    ).toBe('invalid');
    expect(yield* submitPeopleCommand(commandInput({ ...command, expiryInput: '' }), port)).toBe('invalid');
    expect(yield* submitPeopleCommand(commandInput({ ...command, amountMinor: '9007199254740993' }), port)).toBe(
      'invalid',
    );
    expect(port.delegate).toHaveBeenCalledTimes(1);
  }),
);

it.effect('mutation conflicts, denials and outages preserve distinct recoverable outcomes', () =>
  Effect.gen(function* mutationFailures() {
    const failures = [
      [
        Schema.decodeUnknownSync(AccessAdminConflictProblemSchema)({
          _tag: 'AccessAdminConflict',
          detail: 'Changed',
          status: 409,
          title: 'Conflict',
          type: 'about:blank',
        }),
        'conflict',
      ],
      [
        Schema.decodeUnknownSync(AccessAdminForbiddenProblemSchema)({
          _tag: 'AccessAdminForbidden',
          detail: 'Denied',
          status: 403,
          title: 'Forbidden',
          type: 'about:blank',
        }),
        'forbidden',
      ],
      [
        Schema.decodeUnknownSync(AccessAdminUnavailableProblemSchema)({
          _tag: 'AccessAdminUnavailable',
          detail: 'Retry',
          retryable: true,
          status: 503,
          title: 'Unavailable',
          type: 'about:blank',
        }),
        'unavailable',
      ],
    ] as const;
    for (const [failure, expected] of failures) {
      const port = mutationPort();
      port.revokeAssignment.mockReturnValue(Effect.fail(failure));
      const outcome = yield* submitPeopleCommand(commandInput({ assignmentId, kind: 'remove-role' }), port);
      expect(outcome).toBe(expected);
      expect(port.revokeAssignment).toHaveBeenCalledTimes(1);
    }
  }),
);

it.effect('invalid server response is unavailable, not an invalid form', () =>
  Effect.gen(function* responseDecoding() {
    const port = mutationPort();
    port.revokeAssignment.mockReturnValue(Schema.decodeUnknownEffect(AccessPeopleMutationResponseSchema)({}));
    expect(yield* submitPeopleCommand(commandInput({ assignmentId, kind: 'remove-role' }), port)).toBe('unavailable');
  }),
);

it.effect('team changes carry a person and team, not a membership removal', () =>
  Effect.gen(function* teamChange() {
    const port = mutationPort();
    expect(yield* submitPeopleCommand(commandInput({ action: 'leave', kind: 'team', personId, teamId }), port)).toBe(
      'saved',
    );
    expect(port.team.mock.calls[0]?.[0]).toEqual({
      action: 'leave',
      expectedRevision: revision,
      principalId: personId,
      teamId,
    });
    expect(port.revokeAssignment).not.toHaveBeenCalled();
  }),
);

it.effect('the client does not submit invalid expiry or revoked assignment incarnations', () =>
  Effect.gen(function* invalidDrafts() {
    const port = mutationPort();
    expect(
      yield* submitPeopleCommand(
        commandInput({ expiryInput: 'not-a-date', kind: 'assign', personId, roleId, scopeId: companyId }),
        port,
      ),
    ).toBe('invalid');
    const { snapshot } = fixture();
    const ended = {
      ...snapshot,
      people: {
        ...snapshot.people,
        items: snapshot.people.items.map((person) => ({
          ...person,
          assignments: person.assignments.map((assignment) => ({ ...assignment, status: 'revoked' as const })),
        })),
      },
    };
    expect(yield* submitPeopleCommand(commandInput({ assignmentId, kind: 'remove-role' }, ended), port)).toBe(
      'invalid',
    );
    expect(port.assign).not.toHaveBeenCalled();
    expect(port.revokeAssignment).not.toHaveBeenCalled();
  }),
);

it.effect('busy confirmation never emits a duplicate command', () =>
  Effect.gen(function* busyConfirmation() {
    const view = renderPeople();
    fireEvent.click(
      screen.getByRole('button', {
        name: translate('shell.accessAdmin.accessible.removeRoleNamed', { person: 'Ada Lovelace', role: 'Buyer' }),
      }),
    );
    const dialog = yield* Effect.promise(() => screen.findByRole('dialog'));
    view.rerender(
      <PeopleView
        feedback="saving"
        model={model()}
        {...{ onCommand: view.onCommand, onNextPage: view.onNextPage, onRefresh: view.onRefresh }}
      />,
    );
    const confirm = within(dialog).getByRole('button', { name: 'Confirm' });
    expect(confirm.hasAttribute('disabled')).toBe(true);
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(view.onCommand).not.toHaveBeenCalled();
  }),
);

it.effect('the role form previews the exact selected person, company, role and local expiry before submission', () =>
  Effect.gen(function* assignmentForm() {
    const view = renderPeople();
    fireEvent.click(screen.getByRole('combobox', { name: translate('shell.accessAdmin.people.scope') }));
    fireEvent.click(yield* Effect.promise(() => screen.findByRole('option', { name: 'Alpha s.r.o.' })));
    fireEvent.click(
      yield* Effect.promise(() =>
        screen.findByRole('combobox', { name: translate('shell.accessAdmin.people.person') }),
      ),
    );
    fireEvent.click(yield* Effect.promise(() => screen.findByRole('option', { name: 'Ada Lovelace' })));
    fireEvent.click(screen.getByRole('combobox', { name: translate('shell.accessAdmin.people.role') }));
    fireEvent.click(yield* Effect.promise(() => screen.findByRole('option', { name: 'Buyer' })));
    const form = screen.getByRole('form', { name: translate('shell.accessAdmin.people.assignRole') });
    fireEvent.change(within(form).getByLabelText(translate('shell.accessAdmin.people.endDate')), {
      target: { value: '2026-12-01T10:00' },
    });
    const submit = within(form).getByRole('button', { name: translate('shell.accessAdmin.people.assignRole') });
    yield* Effect.promise(() => waitFor(() => expect(submit.hasAttribute('disabled')).toBe(false)));
    expect(within(form).getByLabelText(translate('shell.accessAdmin.people.endDate'))).toHaveProperty(
      'validity.valid',
      true,
    );
    fireEvent.click(submit);
    const dialog = yield* Effect.promise(() => screen.findByRole('dialog'));
    expect(within(dialog).getByText('Alpha s.r.o.')).toBeTruthy();
    expect(within(dialog).getByText('Ada Lovelace')).toBeTruthy();
    expect(within(dialog).getByText('Buyer')).toBeTruthy();
    expect(within(dialog).getByText('2026-12-01T10:00')).toBeTruthy();
    expect(view.onCommand).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    expect(view.onCommand).toHaveBeenCalledWith(
      { expiryInput: '2026-12-01T10:00', kind: 'assign', personId, roleId, scopeId: companyId },
      revision,
    );
  }),
);

test('a delegated assignment keeps its frozen limits visible after the delegation disappears', () => {
  const { snapshot } = fixture();
  const people = Schema.decodeUnknownSync(ListAccessPeopleResponseSchema)({
    ...snapshot.people,
    items: snapshot.people.items.map((person) => ({
      ...person,
      assignments: person.assignments.map((assignment) => ({
        ...assignment,
        delegated: {
          amountCeiling: { currency: 'CZK', limitMinor: 50_000 },
          capabilityKeys: [capability],
          delegationId,
          until,
        },
      })),
      delegations: [],
      memberships: person.memberships.map((membership) => ({ ...membership, status: 'active' })),
    })),
  });
  renderPeople({ ...snapshot, people: Schema.encodeSync(ListAccessPeopleResponseSchema)(people) });
  expect(screen.getByText('Suspended')).toBeTruthy();
  expect(screen.getByText(translate('shell.accessAdmin.people.delegationCeiling'))).toBeTruthy();
  expect(screen.getByText(capability)).toBeTruthy();
  expect(screen.getByText('50,000 CZK')).toBeTruthy();
  expect(screen.queryByRole('button', { name: translate('shell.accessAdmin.people.delegationRevoke') })).toBeNull();
});

const candidateId = '00000000-0000-4000-8000-000000000009';
const otherCompanyId = '00000000-0000-4000-8000-00000000000a';
const otherCandidateId = '00000000-0000-4000-8000-00000000000b';
const otherCompany = { kind: 'company', legalEntityId: otherCompanyId };
const people = 'shell.accessAdmin.people';
const allWrites = (open: boolean) => ({
  canAdmitMember: open,
  canAssign: open,
  canDelegate: open,
  canEndMembership: open,
  canManageTeams: open,
  canRevokeDelegation: open,
  canTransferOwnership: open,
  canUnassign: open,
});
/** Two companies, one directory candidate each, and Ada holding a live member row in Alpha. */
const admissionSnapshot = (open = true): PeopleSnapshot => {
  const { snapshot } = fixture();
  const options = Schema.decodeUnknownSync(ListAccessPeopleOptionsResponseSchema)({
    ...snapshot.options,
    admissionCandidates: [
      { displayName: 'Katherine Johnson', principalId: candidateId, scope: company },
      { displayName: 'Dorothy Vaughan', principalId: otherCandidateId, scope: otherCompany },
    ],
    scopes: [...snapshot.options.scopes, { label: 'Beta a.s.', scope: otherCompany }],
    writeAvailability: allWrites(open),
  });
  const list = Schema.decodeUnknownSync(ListAccessPeopleResponseSchema)({
    ...snapshot.people,
    items: snapshot.people.items.map((person) => ({
      ...person,
      memberships: [
        ...person.memberships,
        { kind: 'member', scope: company, status: 'active', validFrom: from, validUntil: null },
      ],
    })),
  });
  return {
    options: Schema.encodeSync(ListAccessPeopleOptionsResponseSchema)(options),
    people: Schema.encodeSync(ListAccessPeopleResponseSchema)(list),
  };
};
/** Selects a company and waits until its admission section shows the given candidate. */
const chooseScope = (label: string, candidate: string) =>
  Effect.gen(function* choose() {
    fireEvent.click(screen.getByRole('combobox', { name: translate(`${people}.scope`) }));
    fireEvent.click(yield* Effect.promise(() => screen.findByRole('option', { name: label })));
    return yield* Effect.promise(() =>
      waitFor(() => {
        const section = screen.getByRole('region', { name: translate(`${people}.admitSection`) });
        within(section).getByText(candidate);
        return section;
      }),
    );
  });
const endMembershipName = translate(`${people}.endMembershipNamed`, { person: 'Ada Lovelace', scope: 'Alpha s.r.o.' });

it.effect('each company lists only its own directory people and admission previews person, company and effect', () =>
  Effect.gen(function* admission() {
    const view = renderPeople(admissionSnapshot());
    const beta = yield* chooseScope('Beta a.s.', 'Dorothy Vaughan');
    expect(within(beta).queryByText('Katherine Johnson')).toBeNull();
    const alpha = yield* chooseScope('Alpha s.r.o.', 'Katherine Johnson');
    expect(within(alpha).queryByText('Dorothy Vaughan')).toBeNull();
    fireEvent.click(
      within(alpha).getByRole('button', {
        name: translate(`${people}.admitMemberNamed`, { person: 'Katherine Johnson' }),
      }),
    );
    const dialog = yield* Effect.promise(() => screen.findByRole('dialog'));
    expect(within(dialog).getByText('Katherine Johnson')).toBeTruthy();
    expect(within(dialog).getByText('Alpha s.r.o.')).toBeTruthy();
    expect(within(dialog).getByText(translate(`${people}.admitEffect`))).toBeTruthy();
    expect(view.onCommand).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    expect(view.onCommand).toHaveBeenCalledWith({ kind: 'admit', personId: candidateId, scopeId: companyId }, revision);
  }),
);

it.effect('a closed people gate disables admission and ending and shows the preview-only notice', () =>
  Effect.gen(function* closedGate() {
    renderPeople(admissionSnapshot(false));
    expect(screen.getByText(translate(`${people}.previewOnly`))).toBeTruthy();
    expect(screen.getByRole('button', { name: endMembershipName }).hasAttribute('disabled')).toBe(true);
    const alpha = yield* chooseScope('Alpha s.r.o.', 'Katherine Johnson');
    const admit = within(alpha).getByRole('button', {
      name: translate(`${people}.admitMemberNamed`, { person: 'Katherine Johnson' }),
    });
    expect(admit.hasAttribute('disabled')).toBe(true);
  }),
);

it.effect('ending a membership names what ends with it and cannot be confirmed without a reason', () =>
  Effect.gen(function* endConfirmation() {
    const view = renderPeople(admissionSnapshot());
    fireEvent.click(screen.getByRole('button', { name: endMembershipName }));
    const dialog = yield* Effect.promise(() => screen.findByRole('dialog'));
    expect(within(dialog).getByText('Ada Lovelace')).toBeTruthy();
    expect(within(dialog).getByText('Alpha s.r.o.')).toBeTruthy();
    // One live role and one team in Alpha; the listed delegation is managed by Grace, so it does not end.
    expect(
      within(dialog).getByText(translate(`${people}.endMembershipEnds`, { delegations: 0, roles: 1, teams: 1 })),
    ).toBeTruthy();
    expect(within(dialog).getByText(translate(`${people}.endMembershipEffect`))).toBeTruthy();
    const confirm = within(dialog).getByRole('button', { name: 'Confirm' });
    const reason = within(dialog).getByLabelText(translate(`${people}.endMembershipReason`), { exact: false });
    fireEvent.change(reason, { target: { value: '   ' } });
    expect(confirm.hasAttribute('disabled')).toBe(true);
    fireEvent.click(confirm);
    expect(view.onCommand).not.toHaveBeenCalled();
    fireEvent.change(reason, { target: { value: ' Left the company ' } });
    yield* Effect.promise(() => waitFor(() => expect(confirm.hasAttribute('disabled')).toBe(false)));
    fireEvent.click(confirm);
    expect(view.onCommand).toHaveBeenCalledWith(
      { kind: 'end-membership', personId, reason: 'Left the company', scopeId: companyId },
      revision,
    );
  }),
);

it.effect('admission and ending reach the client only for a current candidate or live member row', () =>
  Effect.gen(function* lifecycleCommands() {
    const port = mutationPort();
    const snapshot = admissionSnapshot();
    const admit: PeopleCommand = { kind: 'admit', personId: candidateId, scopeId: companyId };
    expect(yield* submitPeopleCommand(commandInput(admit, snapshot), port)).toBe('saved');
    expect(port.admit.mock.calls[0]?.[0]).toEqual({
      expectedRevision: revision,
      principalId: candidateId,
      scope: company,
    });
    const admitted = { ...snapshot, options: { ...snapshot.options, admissionCandidates: [] } };
    expect(yield* submitPeopleCommand(commandInput(admit, admitted), port)).toBe('invalid');
    expect(yield* submitPeopleCommand(commandInput({ ...admit, personId: otherCandidateId }, snapshot), port)).toBe(
      'invalid',
    );
    expect(port.admit).toHaveBeenCalledTimes(1);

    const end: PeopleCommand = { kind: 'end-membership', personId, reason: ' Left ', scopeId: companyId };
    expect(yield* submitPeopleCommand(commandInput(end, snapshot), port)).toBe('saved');
    expect(port.endMembership.mock.calls[0]?.[0]).toEqual({
      expectedRevision: revision,
      principalId: personId,
      reason: 'Left',
      scope: company,
    });
    expect(yield* submitPeopleCommand(commandInput({ ...end, reason: '  ' }, snapshot), port)).toBe('invalid');
    // The base fixture holds only an owner row in Alpha: owner and access_admin rows are never ended here.
    expect(yield* submitPeopleCommand(commandInput(end), port)).toBe('invalid');
    expect(port.endMembership).toHaveBeenCalledTimes(1);
  }),
);

const conflictProblem = (detail: string) =>
  Schema.decodeUnknownSync(AccessAdminConflictProblemSchema)({
    _tag: 'AccessAdminConflict',
    detail,
    status: 409,
    title: 'Conflict',
    type: 'about:blank',
  });

it.effect('a sole administrator leaving gets the last-owner text, other conflicts stay a plain conflict', () =>
  Effect.gen(function* soleAdministrator() {
    const end: PeopleCommand = { kind: 'end-membership', personId, reason: 'Left', scopeId: companyId };
    const port = mutationPort();
    port.endMembership.mockReturnValue(Effect.fail(conflictProblem('ownership_transfer_required: sole administrator')));
    const outcome = yield* submitPeopleCommand(commandInput(end, admissionSnapshot()), port);
    expect(outcome).toBe('ownershipTransfer');
    port.endMembership.mockReturnValue(Effect.fail(conflictProblem('access_intent_record_conflict: moved')));
    expect(yield* submitPeopleCommand(commandInput(end, admissionSnapshot()), port)).toBe('conflict');
    const view = renderPeople(admissionSnapshot(), outcome);
    expect(view.container.querySelector('[aria-live="polite"]')?.textContent).toBe(
      translate(`${people}.lastOwnerTransfer`),
    );
  }),
);

test('every admission and end-membership key exists in Czech and English', () => {
  for (const key of [
    'admitSection',
    'admitHelp',
    'admitMember',
    'admitMemberNamed',
    'confirmAdmit',
    'admitEffect',
    'noCandidates',
    'endMembership',
    'endMembershipNamed',
    'confirmEndMembership',
    'endMembershipEnds',
    'endMembershipEffect',
    'endMembershipReason',
  ]) {
    expect([czech.has(`${people}.${key}`), english.has(`${people}.${key}`)]).toEqual([true, true]);
  }
});

test('English and Czech presentation use real locale keys without untranslated output', () => {
  for (const language of ['en', 'cs']) {
    locale.current = language;
    const rendered = renderPeople();
    expect(screen.getByRole('region', { name: translate('shell.accessAdmin.people.title') })).toBeTruthy();
    expect(rendered.container.textContent).not.toContain('shell.accessAdmin');
    cleanup();
  }
});
