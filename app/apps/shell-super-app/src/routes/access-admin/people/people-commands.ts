import { DateTime, Effect, Match, Option, Schema } from 'effect';

import {
  AdmitAccessMemberPayloadSchema,
  AssignAccessRolePayloadSchema,
  CreateAccessDelegationPayloadSchema,
  EndAccessMembershipPayloadSchema,
  RevokeAccessAssignmentPayloadSchema,
  RevokeAccessDelegationPayloadSchema,
  SetAccessTeamMembershipPayloadSchema,
} from '../../../../shared/access-admin-api.ts';
import {
  admitAccessMember,
  assignAccessRole,
  createAccessDelegation,
  endAccessMembership,
  revokeAccessAssignment,
  revokeAccessDelegation,
  setAccessTeamMembership,
} from '../../../api/auth-client.ts';
import type { PeopleSnapshot } from '../../[lang]/access/people/people-page-model.ts';
import { peopleScopeKey } from './people-presentation.ts';
import type { PeopleCommand, PeopleFeedback } from './people-view-model.ts';

export interface PeopleMutationPort {
  readonly admit: typeof admitAccessMember;
  readonly assign: typeof assignAccessRole;
  readonly delegate: typeof createAccessDelegation;
  readonly endMembership: typeof endAccessMembership;
  readonly revokeAssignment: typeof revokeAccessAssignment;
  readonly revokeDelegation: typeof revokeAccessDelegation;
  readonly team: typeof setAccessTeamMembership;
}
interface CommandInput {
  readonly command: PeopleCommand;
  readonly expectedRevision: string;
  readonly options: Parameters<typeof assignAccessRole>[1];
  readonly reason: string;
  readonly snapshot: PeopleSnapshot;
}
const livePort: PeopleMutationPort = {
  admit: admitAccessMember,
  assign: assignAccessRole,
  delegate: createAccessDelegation,
  endMembership: endAccessMembership,
  revokeAssignment: revokeAccessAssignment,
  revokeDelegation: revokeAccessDelegation,
  team: setAccessTeamMembership,
};
class PeopleFormProblem extends Schema.TaggedError<PeopleFormProblem, { readonly brand: unique symbol }>()(
  'PeopleFormProblem',
  {
    reason: Schema.Literals(['invalid', 'conflict']),
  },
) {}
const invalid = () => new PeopleFormProblem({ reason: 'invalid' });
const utcDate = (value: string): string | undefined =>
  Option.getOrUndefined(Option.map(DateTime.make(value), DateTime.formatIso));
const formFailure = () => Effect.fail(invalid());

const assignRole = Effect.fn('PeopleCommands.assignRole')(function* assignRoleEffect(
  command: Extract<PeopleCommand, { kind: 'assign' }>,
  input: CommandInput,
  port: PeopleMutationPort,
) {
  const choices = input.snapshot.options;
  const role = choices.roles.find(
    (item) => item.roleId === command.roleId && peopleScopeKey(item.scope) === command.scopeId,
  );
  const person = choices.people.find(
    (item) =>
      item.principalId === command.personId &&
      item.memberOfScopes.some((scope) => peopleScopeKey(scope) === command.scopeId),
  );
  const validUntil = utcDate(command.expiryInput);
  if (
    !choices.writeAvailability.canAssign ||
    role === undefined ||
    person === undefined ||
    (command.expiryInput.length > 0 && validUntil === undefined)
  ) {
    return yield* invalid();
  }
  const base = {
    expectedRevision: input.expectedRevision,
    expectedRoleRevisionId: role.latestRevisionId,
    principalId: person.principalId,
    roleId: role.roleId,
    scope: role.scope,
  };
  const fields = validUntil === undefined ? base : { ...base, validUntil };
  const payload = yield* Schema.decodeEffect(AssignAccessRolePayloadSchema)(fields).pipe(
    Effect.catchTag('SchemaError', formFailure),
  );
  return yield* port.assign(payload, input.options);
});

const removeRole = Effect.fn('PeopleCommands.removeRole')(function* removeRoleEffect(
  command: Extract<PeopleCommand, { kind: 'remove-role' }>,
  input: CommandInput,
  port: PeopleMutationPort,
) {
  const assignments = input.snapshot.people.items.flatMap((person) => person.assignments);
  const assignment = assignments.find(
    (item) => item.incarnationId === command.assignmentId && item.status === 'active',
  );
  if (!input.snapshot.options.writeAvailability.canUnassign || assignment === undefined) {
    return yield* invalid();
  }
  const payload = yield* Schema.decodeEffect(RevokeAccessAssignmentPayloadSchema)({
    expectedRevision: input.expectedRevision,
    incarnationId: assignment.incarnationId,
    reason: input.reason,
  }).pipe(Effect.catchTag('SchemaError', formFailure));
  return yield* port.revokeAssignment(payload, input.options);
});

const changeTeam = Effect.fn('PeopleCommands.changeTeam')(function* changeTeamEffect(
  command: Extract<PeopleCommand, { kind: 'team' }>,
  input: CommandInput,
  port: PeopleMutationPort,
) {
  const choices = input.snapshot.options;
  const team = choices.teams.find((item) => item.teamId === command.teamId);
  const existingMembership = input.snapshot.people.items
    .find((person) => person.principalId === command.personId)
    ?.teams.find((item) => item.teamId === command.teamId);
  const person = choices.people.find((item) => item.principalId === command.personId);
  if (
    !choices.writeAvailability.canManageTeams ||
    (command.action === 'join' ? team === undefined || person === undefined : existingMembership === undefined)
  ) {
    return yield* invalid();
  }
  const payload = yield* Schema.decodeEffect(SetAccessTeamMembershipPayloadSchema)({
    action: command.action,
    expectedRevision: input.expectedRevision,
    principalId: command.personId,
    teamId: command.teamId,
  }).pipe(Effect.catchTag('SchemaError', formFailure));
  return yield* port.team(payload, input.options);
});

const delegate = Effect.fn('PeopleCommands.delegate')(function* delegateEffect(
  command: Extract<PeopleCommand, { kind: 'delegate' }>,
  input: CommandInput,
  port: PeopleMutationPort,
) {
  const choices = input.snapshot.options;
  const scope = choices.scopes.find((item) => peopleScopeKey(item.scope) === command.scopeId)?.scope;
  const manager = choices.managers.find(
    (item) =>
      item.principalId === command.managerId &&
      item.memberOfScopes.some((memberScope) => peopleScopeKey(memberScope) === command.scopeId),
  );
  const validUntil = utcDate(command.expiryInput);
  const limitMinor = Number(command.amountMinor);
  if (command.amountMinor.length > 0 && !Number.isSafeInteger(limitMinor)) {
    return yield* invalid();
  }
  const knownPeople = command.people.every((id) =>
    choices.people.some(
      (person) =>
        person.principalId === id &&
        person.memberOfScopes.some((memberScope) => peopleScopeKey(memberScope) === command.scopeId),
    ),
  );
  const knownRoles = command.roles.every((id) =>
    choices.roles.some((role) => role.roleId === id && peopleScopeKey(role.scope) === command.scopeId),
  );
  const knownCapabilities = command.capabilities.every((key) =>
    choices.capabilities.some((item) => item.capabilityKey === key && item.withinGrantorAuthority),
  );
  if (
    !choices.writeAvailability.canDelegate ||
    scope === undefined ||
    manager === undefined ||
    validUntil === undefined ||
    !knownPeople ||
    !knownRoles ||
    !knownCapabilities
  ) {
    return yield* invalid();
  }
  const base = {
    capabilityKeys: command.capabilities,
    expectedRevision: input.expectedRevision,
    managerId: manager.principalId,
    people: command.people,
    roleIds: command.roles,
    scope,
    validUntil,
  };
  const fields =
    command.amountMinor.length === 0 ? base : { ...base, amountCeiling: { currency: command.currency, limitMinor } };
  const payload = yield* Schema.decodeUnknownEffect(CreateAccessDelegationPayloadSchema)(fields).pipe(
    Effect.catchTag('SchemaError', formFailure),
  );
  return yield* port.delegate(payload, input.options);
});

const revokeDelegation = Effect.fn('PeopleCommands.revokeDelegation')(function* revokeDelegationEffect(
  command: Extract<PeopleCommand, { kind: 'revoke-delegation' }>,
  input: CommandInput,
  port: PeopleMutationPort,
) {
  const delegations = input.snapshot.people.items.flatMap((person) => person.delegations);
  const delegation = delegations.find((item) => item.delegationId === command.delegationId && item.status === 'active');
  if (!input.snapshot.options.writeAvailability.canRevokeDelegation || delegation === undefined) {
    return yield* invalid();
  }
  const payload = yield* Schema.decodeEffect(RevokeAccessDelegationPayloadSchema)({
    delegationId: delegation.delegationId,
    expectedRevision: input.expectedRevision,
    reason: input.reason,
  }).pipe(Effect.catchTag('SchemaError', formFailure));
  return yield* port.revokeDelegation(payload, input.options);
});

const admitMember = Effect.fn('PeopleCommands.admitMember')(function* admitMemberEffect(
  command: Extract<PeopleCommand, { kind: 'admit' }>,
  input: CommandInput,
  port: PeopleMutationPort,
) {
  const choices = input.snapshot.options;
  const candidate = choices.admissionCandidates.find(
    (item) => item.principalId === command.personId && item.scope.legalEntityId === command.scopeId,
  );
  if (!choices.writeAvailability.canAdmitMember || candidate === undefined) {
    return yield* invalid();
  }
  const payload = yield* Schema.decodeEffect(AdmitAccessMemberPayloadSchema)({
    expectedRevision: input.expectedRevision,
    principalId: candidate.principalId,
    scope: candidate.scope,
  }).pipe(Effect.catchTag('SchemaError', formFailure));
  return yield* port.admit(payload, input.options);
});

const endMembership = Effect.fn('PeopleCommands.endMembership')(function* endMembershipEffect(
  command: Extract<PeopleCommand, { kind: 'end-membership' }>,
  input: CommandInput,
  port: PeopleMutationPort,
) {
  const membership = input.snapshot.people.items
    .find((person) => person.principalId === command.personId)
    ?.memberships.find(
      (item) => item.kind === 'member' && item.status === 'active' && peopleScopeKey(item.scope) === command.scopeId,
    );
  const reason = command.reason.trim();
  if (!input.snapshot.options.writeAvailability.canEndMembership || membership === undefined || reason.length === 0) {
    return yield* invalid();
  }
  const payload = yield* Schema.decodeEffect(EndAccessMembershipPayloadSchema)({
    expectedRevision: input.expectedRevision,
    principalId: command.personId,
    reason,
    scope: membership.scope,
  }).pipe(Effect.catchTag('SchemaError', formFailure));
  return yield* port.endMembership(payload, input.options);
});

/** Core answers a sole administrator's leave with this code inside the 409's detail. */
const ownershipTransferRequired = (detail: string) => detail.startsWith('ownership_transfer_required');

/** Form checks are usability checks only; each command is independently admitted by the BFF. */
export const submitPeopleCommand = Effect.fn('PeopleCommands.submitPeopleCommand')(
  function* submitPeopleCommandEffect(input: CommandInput, port: PeopleMutationPort = livePort) {
    if (
      input.snapshot.people.revision !== input.expectedRevision ||
      input.snapshot.options.revision !== input.expectedRevision
    ) {
      return yield* new PeopleFormProblem({ reason: 'conflict' });
    }
    yield* Match.value(input.command).pipe(
      Match.when({ kind: 'assign' }, (command) => assignRole(command, input, port)),
      Match.when({ kind: 'remove-role' }, (command) => removeRole(command, input, port)),
      Match.when({ kind: 'team' }, (command) => changeTeam(command, input, port)),
      Match.when({ kind: 'delegate' }, (command) => delegate(command, input, port)),
      Match.when({ kind: 'revoke-delegation' }, (command) => revokeDelegation(command, input, port)),
      Match.when({ kind: 'admit' }, (command) => admitMember(command, input, port)),
      Match.when({ kind: 'end-membership' }, (command) => endMembership(command, input, port)),
      Match.exhaustive,
    );
    return 'saved' as const;
  },
  Effect.timeout('30 seconds'),
  Effect.match({
    onFailure: (error): PeopleFeedback =>
      Match.value(error).pipe(
        Match.tag('PeopleFormProblem', ({ reason }) => reason),
        Match.tag('AccessAdminConflict', ({ detail }) =>
          ownershipTransferRequired(detail) ? ('ownershipTransfer' as const) : ('conflict' as const),
        ),
        Match.tag('AccessAdminInvalidRequest', 'AccessAdminUnprocessable', () => 'invalid' as const),
        Match.tag('AccessAdminAuthenticationRequired', () => 'unauthenticated' as const),
        Match.tag('AccessAdminForbidden', () => 'forbidden' as const),
        Match.tag(
          'AccessAdminInternal',
          'AccessAdminUnavailable',
          'HttpClientError',
          'SchemaError',
          'TimeoutError',
          () => 'unavailable' as const,
        ),
        Match.exhaustive,
      ),
    onSuccess: (feedback): PeopleFeedback => feedback,
  }),
);
