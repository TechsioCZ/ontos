import { matchesSearch } from '@app/admin-ui';
import { Match, Schema } from 'effect';

import type { ListAccessPeopleOptionsResponse, ListAccessPeopleResponse } from '../../../shared/access-admin-api.ts';
import { PeopleScopeSchema } from '../../../shared/people-api.ts';
import type { PeopleList, Person, SetPeopleCompanyMembershipResponse } from '../../../shared/people-api.ts';

/**
 * The canonical access-administration view of the request scope: the role choices the release
 * publishes for it, the people of the scope with their canonical role assignments, and the revision
 * every write must echo. It is the only role authority this surface reads or writes.
 */
export interface PeopleAccessView {
  readonly options: ListAccessPeopleOptionsResponse;
  readonly people: ListAccessPeopleResponse;
}

export type AccessAssignment = ListAccessPeopleResponse['items'][number]['assignments'][number];
export type AccessRoleChoice = ListAccessPeopleOptionsResponse['roles'][number];

/** Every canonical assignment of one person in the loaded scope, active or not. */
export const accessAssignmentsOf = (
  access: PeopleAccessView | undefined,
  principalId: string,
): readonly AccessAssignment[] =>
  access === undefined
    ? []
    : access.people.items.flatMap((person) => (person.principalId === principalId ? person.assignments : []));

/** The role names one person holds right now, from canonical intent only. */
export const accessRoleNamesOf = (access: PeopleAccessView | undefined, principalId: string): readonly string[] =>
  [
    ...new Set(
      accessAssignmentsOf(access, principalId).flatMap((assignment) =>
        assignment.status === 'active' ? [assignment.roleName] : [],
      ),
    ),
  ].toSorted((left, right) => left.localeCompare(right, 'cs'));

/** The role choices a role of one exact scope offers: a company's role in that company, a tenant role in the tenant. */
export const accessRolesOfScope = (
  access: PeopleAccessView | undefined,
  scope: 'company' | 'tenant',
  legalEntityId: string | undefined,
): readonly AccessRoleChoice[] =>
  (access?.options.roles ?? []).filter((role) =>
    scope === 'tenant'
      ? role.scope.kind === 'tenant'
      : role.scope.kind === 'company' && role.scope.legalEntityId === legalEntityId,
  );

/** The one live assignment of a role a person holds, which is what a revoke names. */
export const accessAssignmentOf = (
  access: PeopleAccessView | undefined,
  principalId: string,
  roleId: string,
): AccessAssignment | undefined =>
  accessAssignmentsOf(access, principalId).find(
    (assignment) => assignment.roleId === roleId && assignment.status === 'active',
  );

export const membershipLabels = {
  active: 'Aktivní',
  departed: 'Odešel / odešla',
  disabled: 'Přístup pozastaven',
  invited: 'Pozván / pozvána',
} as const;

export const personKindLabel = (person: Person): string => {
  if (person.kind === 'agent') {
    return 'AI agent';
  }
  const affiliation = person.selectedCompanyMembership?.affiliation;
  if (affiliation === 'employee') {
    return 'Zaměstnanec';
  }
  if (affiliation === 'external') {
    return 'Externí osoba';
  }
  return 'Člověk';
};

export const PersonKindKeySchema = Schema.Literals(['agent', 'employee', 'external', 'human']);
export type PersonKindKey = typeof PersonKindKeySchema.Type;
export const PeopleEditKindSchema = Schema.Literals(['membership', 'role']);
export type PeopleEditKind = typeof PeopleEditKindSchema.Type;
export const PeopleAdminScopeSchema = Schema.Literals(['company', 'tenant']);
export type PeopleAdminScope = typeof PeopleAdminScopeSchema.Type;
export const personKindKey = (person: Person): PersonKindKey => {
  if (person.kind === 'agent') {
    return 'agent';
  }
  return person.selectedCompanyMembership?.affiliation ?? 'human';
};
export const personKindOptions = [
  { label: 'Zaměstnanec', value: 'employee' },
  { label: 'Externí osoba', value: 'external' },
  { label: 'AI agent', value: 'agent' },
  { label: 'Člověk bez zařazení', value: 'human' },
] as const satisfies readonly { readonly label: string; readonly value: PersonKindKey }[];

/**
 * One status per row. The colour tone is decorative: the label always carries the meaning (WCAG 1.4.1).
 * Login state wins over membership, because a blocked or archived login cannot act in any company.
 */
export const PersonStatusKeySchema = Schema.Literals([
  'active',
  'invited',
  'deactivated',
  'blocked',
  'departed',
  'archived',
]);
export type PersonStatusKey = typeof PersonStatusKeySchema.Type;
export const PersonStatusToneSchema = Schema.Literals(['danger', 'neutral', 'success', 'warning']);
export type PersonStatusTone = typeof PersonStatusToneSchema.Type;
export const personStatusPresentation = {
  active: { label: 'Aktivní', rank: 0, tone: 'success' },
  archived: { label: 'Archivovaný', rank: 5, tone: 'neutral' },
  blocked: { label: 'Zablokovaný', rank: 3, tone: 'danger' },
  deactivated: { label: 'Deaktivovaný', rank: 2, tone: 'neutral' },
  departed: { label: 'Ukončený', rank: 4, tone: 'neutral' },
  invited: { label: 'Pozvaný', rank: 1, tone: 'warning' },
} as const satisfies Record<
  PersonStatusKey,
  { readonly label: string; readonly rank: number; readonly tone: PersonStatusTone }
>;
export const personStatusKey = (person: Person): PersonStatusKey => {
  if (person.principalStatus === 'disabled') {
    return 'blocked';
  }
  if (person.principalStatus === 'archived') {
    return 'archived';
  }
  return Match.value(person.selectedCompanyMembership?.status ?? 'active').pipe(
    Match.when('active', (): PersonStatusKey => 'active'),
    Match.when('invited', (): PersonStatusKey => 'invited'),
    Match.when('disabled', (): PersonStatusKey => 'deactivated'),
    Match.when('departed', (): PersonStatusKey => 'departed'),
    Match.exhaustive,
  );
};

/**
 * A blocked login that no longer belongs anywhere in the current view: its membership in the selected company has
 * ended (or it has none), and on the Tenant view it holds no role. Such a retired account is history, not a person
 * to manage, while a blocked login that still holds a membership or a role stays visible so it can be unblocked.
 */
const isRetired = (person: Person, access: PeopleAccessView | undefined): boolean =>
  person.principalStatus === 'disabled' &&
  (person.selectedCompanyMembership === null
    ? accessRoleNamesOf(access, person.principalRef.principalId).length === 0
    : person.selectedCompanyMembership.status === 'departed');

/**
 * `current` hides ended memberships, archived logins and retired accounts, which stay available on request for
 * history.
 */
export const PeopleStatusFilterSchema = Schema.Literals(['current', 'all', ...PersonStatusKeySchema.literals]);
export type PeopleStatusFilter = typeof PeopleStatusFilterSchema.Type;
export interface PeopleFilters {
  readonly kind: PersonKindKey | 'all';
  readonly query: string;
  /** A canonical role id, or `all`. Role keys are no longer an identity this surface names. */
  readonly roleId: string;
  readonly status: PeopleStatusFilter;
}
export const defaultPeopleFilters: PeopleFilters = { kind: 'all', query: '', roleId: 'all', status: 'current' };
export const allPeopleFilters: PeopleFilters = { ...defaultPeopleFilters, status: 'all' };
const matchesStatus = (filter: PeopleStatusFilter, status: PersonStatusKey) => {
  if (filter === 'all') {
    return true;
  }
  if (filter === 'current') {
    return status !== 'departed' && status !== 'archived';
  }
  return filter === status;
};
export const filterPeople = (
  people: readonly Person[],
  filters: PeopleFilters,
  access: PeopleAccessView | undefined,
): readonly Person[] => {
  const { query } = filters;
  return people.filter((person) => {
    const { principalId } = person.principalRef;
    return (
      (filters.kind === 'all' || personKindKey(person) === filters.kind) &&
      (filters.roleId === 'all' ||
        accessAssignmentsOf(access, principalId).some(
          (assignment) => assignment.roleId === filters.roleId && assignment.status === 'active',
        )) &&
      matchesStatus(filters.status, personStatusKey(person)) &&
      (filters.status !== 'current' || !isRetired(person, access)) &&
      [person.displayName, personKindLabel(person), ...accessRoleNamesOf(access, principalId)].some((text) =>
        matchesSearch(text, query),
      )
    );
  });
};

/** What one committed write is waiting for: the directory row, or the canonical assignment incarnation. */
export type PendingPeopleChange =
  | { readonly kind: 'membership'; readonly result: SetPeopleCompanyMembershipResponse }
  | {
      readonly change: {
        readonly incarnationId: string;
        readonly present: boolean;
        readonly principalId: string;
      };
      readonly kind: 'role';
    };

export const isCompanyScope = Schema.is(PeopleScopeSchema.members[1]);
export const sameScope = (a: PeopleList['scope'], b: PeopleList['scope']): boolean =>
  Match.value(a).pipe(
    Match.tag('tenant', () => Schema.is(PeopleScopeSchema.members[0])(b)),
    Match.tag('company', (company) => isCompanyScope(b) && company.legalEntityId === b.legalEntityId),
    Match.exhaustive,
  );

/**
 * A write is confirmed only by the state the authority read reports afterwards: the canonical assignment
 * incarnation for a role, and the directory row for a membership. A commit response alone never confirms.
 */
export const isChangeConfirmed = (
  change: PendingPeopleChange,
  list: PeopleList,
  access: PeopleAccessView | undefined,
): boolean => {
  if (change.kind === 'membership') {
    const { membership } = change.result;
    if (
      list.tenantId !== membership.principalRef.tenantId ||
      !isCompanyScope(list.scope) ||
      list.scope.legalEntityId !== membership.legalEntityId
    ) {
      return false;
    }
    const person = list.items.find(
      (item) =>
        item.principalRef.principalId === membership.principalRef.principalId &&
        item.principalRef.tenantId === membership.principalRef.tenantId,
    );
    const current = person?.selectedCompanyMembership;
    return (
      current !== null &&
      current !== undefined &&
      current.revision === membership.revision &&
      current.status === membership.status &&
      current.affiliation === membership.affiliation
    );
  }
  const { incarnationId, present, principalId } = change.change;
  const held = accessAssignmentsOf(access, principalId).find(
    (assignment) => assignment.incarnationId === incarnationId,
  );
  return present ? held !== undefined && held.status === 'active' : held === undefined || held.status === 'revoked';
};
