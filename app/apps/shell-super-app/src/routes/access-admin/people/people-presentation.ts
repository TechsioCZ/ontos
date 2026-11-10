import { DateTime, Option } from 'effect';

import type { PeopleSnapshot } from '../../[lang]/access/people/people-page-model.ts';
import type { PeoplePersonView, PeopleScopeChoices, PeopleViewModel } from './people-view-model.ts';

type Scope = PeopleSnapshot['options']['scopes'][number]['scope'];
type Person = PeopleSnapshot['people']['items'][number];
interface PresentationLabels {
  readonly locale: string;
  readonly tenant: string;
  readonly unknown: string;
}

export const peopleScopeKey = (scope: Scope): string => (scope.kind === 'tenant' ? 'tenant' : scope.legalEntityId);
const scopeMatches = (left: Scope, right: Scope) => peopleScopeKey(left) === peopleScopeKey(right);

const ordered = (earlier: string, later: string, strict: boolean): boolean =>
  Option.getOrElse(
    Option.zipWith(DateTime.make(earlier), DateTime.make(later), (left, right) =>
      strict ? DateTime.isLessThan(left, right) : DateTime.isLessThanOrEqualTo(left, right),
    ),
    () => false,
  );

/**
 * A member row Core's end-membership ends for good: active or suspended, inside its validity period
 * when the list was read. Revoked, expired and not-yet-valid rows are not ended.
 */
export const isEndableMembership = (membership: Person['memberships'][number], readAt: string): boolean =>
  membership.kind === 'member' &&
  membership.status !== 'revoked' &&
  ordered(membership.validFrom, readAt, false) &&
  (membership.validUntil === null || ordered(readAt, membership.validUntil, true));

const presentationLookups = (snapshot: PeopleSnapshot, labels: PresentationLabels) => {
  const scopes = new Map(snapshot.options.scopes.map((item) => [peopleScopeKey(item.scope), item.label]));
  const people = new Map(
    [...snapshot.people.items, ...snapshot.options.people].map((item) => [item.principalId, item.displayName]),
  );
  const roles = new Map(snapshot.options.roles.map((item) => [item.roleId, item.name]));
  return {
    date: (value: string) =>
      Option.match(DateTime.make(value), {
        onNone: () => labels.unknown,
        onSome: (date) =>
          `${DateTime.formatUtc(date, { dateStyle: 'medium', locale: labels.locale, timeStyle: 'short' })} UTC`,
      }),
    person: (id: string) => people.get(id) ?? labels.unknown,
    role: (id: string) => roles.get(id) ?? labels.unknown,
    scope: (scope: Scope) =>
      scopes.get(peopleScopeKey(scope)) ?? (scope.kind === 'tenant' ? labels.tenant : labels.unknown),
  };
};

const amountLabel = (ceiling: Person['delegations'][number]['amountCeiling'], locale: string): string | null =>
  ceiling === undefined ? null : `${ceiling.limitMinor.toLocaleString(locale)} ${ceiling.currency}`;

/**
 * What ending a member row also ends, mirroring Core's closed scopes: a company row closes that
 * company, the tenant row closes every scope. Only managed delegations end; granted ones refuse.
 */
const endedWithMembership = (person: Person, scope: Scope): PeoplePersonView['memberships'][number]['ends'] => {
  const closed = (other: Scope) => scope.kind === 'tenant' || scopeMatches(other, scope);
  return {
    delegations: person.delegations.filter(
      (delegation) =>
        delegation.status === 'active' && delegation.managerId === person.principalId && closed(delegation.scope),
    ).length,
    roles: person.assignments.filter((assignment) => assignment.status === 'active' && closed(assignment.scope)).length,
    teams: person.teams.filter((team) => closed(team.scope)).length,
  };
};

const personView = (
  person: Person,
  snapshot: PeopleSnapshot,
  labels: PresentationLabels,
  lookup: ReturnType<typeof presentationLookups>,
): PeoplePersonView => {
  const { writeAvailability } = snapshot.options;
  return {
    assignments: person.assignments.map((assignment) => ({
      canRemove: writeAvailability.canUnassign && assignment.status === 'active',
      delegatedLimits:
        assignment.delegated === undefined
          ? null
          : {
              amount: amountLabel(assignment.delegated.amountCeiling, labels.locale),
              capabilities: assignment.delegated.capabilityKeys,
              expiryLabel: lookup.date(assignment.delegated.until),
            },
      expiryLabel: assignment.validUntil === null ? null : lookup.date(assignment.validUntil),
      id: assignment.incarnationId,
      role: assignment.roleName,
      scope: lookup.scope(assignment.scope),
      status: assignment.status,
    })),
    delegations: person.delegations.map((delegation) => ({
      amount: amountLabel(delegation.amountCeiling, labels.locale),
      canRevoke: writeAvailability.canRevokeDelegation && delegation.status === 'active',
      capabilities: delegation.capabilityKeys,
      expiryLabel: lookup.date(delegation.validUntil),
      id: delegation.delegationId,
      manager: lookup.person(delegation.managerId),
      people: delegation.people.map(lookup.person),
      roles: delegation.roleIds.map(lookup.role),
      scope: lookup.scope(delegation.scope),
      status: delegation.status,
    })),
    id: person.principalId,
    label: person.displayName,
    memberships: person.memberships.map((membership, index) => ({
      canEnd: writeAvailability.canEndMembership && isEndableMembership(membership, snapshot.readAt),
      endable: isEndableMembership(membership, snapshot.readAt),
      ends: endedWithMembership(person, membership.scope),
      expiryLabel: membership.validUntil === null ? null : lookup.date(membership.validUntil),
      id: `${peopleScopeKey(membership.scope)}-${index}`,
      kind: membership.kind,
      scope: lookup.scope(membership.scope),
      scopeId: peopleScopeKey(membership.scope),
      status: membership.status,
    })),
    soleOwnerScopes: person.ownership.soleAdministratorScopes.map(lookup.scope),
    suspended: person.suspended,
    teams: person.teams.map((team) => ({
      canRemove: writeAvailability.canManageTeams,
      id: team.teamId,
      label: team.name,
      scope: lookup.scope(team.scope),
    })),
  };
};

const scopeChoices = (
  { label, scope }: PeopleSnapshot['options']['scopes'][number],
  options: PeopleSnapshot['options'],
): PeopleScopeChoices => ({
  candidates: options.admissionCandidates.flatMap((candidate) =>
    scopeMatches(candidate.scope, scope) ? [{ id: candidate.principalId, label: candidate.displayName }] : [],
  ),
  capabilities: options.capabilities.flatMap((capability) =>
    capability.withinGrantorAuthority ? [{ id: capability.capabilityKey, label: capability.capabilityKey }] : [],
  ),
  id: peopleScopeKey(scope),
  label,
  managers: options.managers.flatMap((person) =>
    person.memberOfScopes.some((memberScope) => scopeMatches(memberScope, scope))
      ? [{ id: person.principalId, label: person.displayName }]
      : [],
  ),
  people: options.people.flatMap((person) =>
    person.memberOfScopes.some((memberScope) => scopeMatches(memberScope, scope))
      ? [{ id: person.principalId, label: person.displayName }]
      : [],
  ),
  roles: options.roles.flatMap((role) =>
    scopeMatches(role.scope, scope) ? [{ id: role.roleId, label: role.name }] : [],
  ),
  teams: options.teams.flatMap((team) =>
    scopeMatches(team.scope, scope) ? [{ id: team.teamId, label: team.name }] : [],
  ),
});

export const toPeopleViewModel = (snapshot: PeopleSnapshot, labels: PresentationLabels): PeopleViewModel => {
  const lookup = presentationLookups(snapshot, labels);
  const { writeAvailability } = snapshot.options;
  return {
    hasMore: snapshot.people.nextCursor !== null,
    people: snapshot.people.items.map((person) => personView(person, snapshot, labels, lookup)),
    revision: snapshot.people.revision,
    scopes: snapshot.options.scopes.map((scope) => scopeChoices(scope, snapshot.options)),
    writes: {
      admit: writeAvailability.canAdmitMember,
      assign: writeAvailability.canAssign,
      delegate: writeAvailability.canDelegate,
      endMembership: writeAvailability.canEndMembership,
      team: writeAvailability.canManageTeams,
    },
  };
};
