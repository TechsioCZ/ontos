import { Match, Schema } from 'effect';
import { PeopleScopeSchema } from '../../../shared/people-api.ts';
import type {
  PeopleList,
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

export type PendingPeopleChange =
  | { readonly kind: 'membership'; readonly result: SetPeopleCompanyMembershipResponse }
  | { readonly kind: 'role'; readonly result: SetPeopleRoleResponse };

export const isCompanyScope = Schema.is(PeopleScopeSchema.members[1]);
export const scopeLabel = (scope: PeopleList['scope']) =>
  Match.value(scope).pipe(
    Match.tag('tenant', () => 'tenant'),
    Match.tag('company', () => 'firma'),
    Match.exhaustive,
  );
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
