import { matchesSearch } from '@app/admin-ui';
import { Match, Schema } from 'effect';
import { PeopleScopeSchema } from '../../../shared/people-api.ts';
import type {
  PeopleList,
  PeopleRoleCatalog,
  Person,
  SetPeopleCompanyMembershipResponse,
  SetPeopleRoleResponse,
} from '../../../shared/people-api.ts';

export const membershipLabels = {
  active: 'Aktivní',
  departed: 'Odešel / odešla',
  disabled: 'Přístup pozastaven',
  invited: 'Pozván / pozvána',
} as const;
export const principalStatusLabels = {
  active: 'Aktivní přihlášení',
  archived: 'Archivované přihlášení',
  disabled: 'Přihlášení zakázáno',
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

/** Roles missing from the catalog are technical workloads, never assignable people profiles. */
export const roleName = (catalog: PeopleRoleCatalog | undefined, roleKey: string): string =>
  catalog?.items.find((role) => role.roleKey === roleKey)?.name ?? 'Technická role';
export const roleNames = (catalog: PeopleRoleCatalog | undefined, person: Person): readonly string[] =>
  person.roleAssignments.map((role) => roleName(catalog, role.roleKey)).toSorted((a, b) => a.localeCompare(b, 'cs'));

/** `current` hides ended memberships and archived logins, which stay available on request for history. */
export const PeopleStatusFilterSchema = Schema.Literals(['current', 'all', ...PersonStatusKeySchema.literals]);
export type PeopleStatusFilter = typeof PeopleStatusFilterSchema.Type;
export interface PeopleFilters {
  readonly kind: PersonKindKey | 'all';
  readonly query: string;
  readonly roleKey: string;
  readonly status: PeopleStatusFilter;
}
export const defaultPeopleFilters: PeopleFilters = { kind: 'all', query: '', roleKey: 'all', status: 'current' };
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
  catalog: PeopleRoleCatalog | undefined,
): readonly Person[] => {
  const { query } = filters;
  return people.filter(
    (person) =>
      (filters.kind === 'all' || personKindKey(person) === filters.kind) &&
      (filters.roleKey === 'all' || person.roleAssignments.some((role) => role.roleKey === filters.roleKey)) &&
      matchesStatus(filters.status, personStatusKey(person)) &&
      [person.displayName, personKindLabel(person), ...roleNames(catalog, person)].some((text) =>
        matchesSearch(text, query),
      ),
  );
};

export type PendingPeopleChange =
  | { readonly kind: 'membership'; readonly result: SetPeopleCompanyMembershipResponse }
  | { readonly kind: 'role'; readonly result: SetPeopleRoleResponse };

export const isCompanyScope = Schema.is(PeopleScopeSchema.members[1]);
export const sameScope = (a: PeopleList['scope'], b: PeopleList['scope']): boolean =>
  Match.value(a).pipe(
    Match.tag('tenant', () => Schema.is(PeopleScopeSchema.members[0])(b)),
    Match.tag('company', (company) => isCompanyScope(b) && company.legalEntityId === b.legalEntityId),
    Match.exhaustive,
  );

/** Only actual scoped graph assignments can confirm a role command, never the Action's commit response. */
export const isChangeConfirmed = (change: PendingPeopleChange, list: PeopleList): boolean => {
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
    const projection = person?.selectedCompanyMembershipProjection;
    return (
      current !== null &&
      current !== undefined &&
      projection !== null &&
      projection !== undefined &&
      current.revision === membership.revision &&
      current.status === membership.status &&
      current.affiliation === membership.affiliation &&
      projection.expectedMember === projection.observedMember
    );
  }
  const { result } = change;
  if (list.tenantId !== result.role.tenantId || !sameScope(list.scope, result.role.scope)) {
    return false;
  }
  const person = list.items.find(
    (item) =>
      item.principalRef.principalId === result.principalRef.principalId &&
      item.principalRef.tenantId === result.principalRef.tenantId,
  );
  if (person === undefined) {
    return false;
  }
  const present = person.roleAssignments.some(
    (role) =>
      role.tenantId === result.role.tenantId &&
      role.roleKey === result.role.roleKey &&
      sameScope(role.scope, result.role.scope),
  );
  return result.operation === 'assign' ? present : !present;
};
