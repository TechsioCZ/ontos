import { Schema } from 'effect';

export const PEOPLE_DETAIL_PATH = '/sprava/lide-a-role';
export const PEOPLE_DETAIL_QUERY_PARAM = 'person';

const PersonQuerySchema = Schema.String.check(Schema.isMaxLength(100));
const PersonIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('PeoplePersonId'));
const uuid = Schema.is(PersonIdSchema);
const string = Schema.is(Schema.String);

/** The router search document; both values are validated below before they become typed selections. */
export const DetailSearchSchema = Schema.Struct({
  agent: Schema.optionalKey(Schema.Unknown),
  person: Schema.optionalKey(Schema.Unknown),
});
export type DetailSearch = typeof DetailSearchSchema.Type;

export type PeopleDetailSelection =
  | { readonly companyQualified: boolean; readonly principalId: string; readonly state: 'selected' }
  | { readonly state: 'company_required' }
  | { readonly state: 'foreign_company' }
  | { readonly state: 'invalid' }
  | { readonly state: 'none' };

export interface PeopleDetailQuery {
  readonly agent?: string;
  readonly person: PeopleDetailSelection;
}

interface QualifiedPerson {
  readonly legalEntityId: string;
  readonly principalId: string;
}

/** A company-qualified person is `<legalEntityId>.<principalId>`; anything else stays a legacy principal ID. */
const qualifiedPerson = (value: string): QualifiedPerson | undefined => {
  const parts = value.split('.');
  if (parts.length !== 2) {
    return undefined;
  }
  const [legalEntityId, principalId] = parts;
  return legalEntityId !== undefined && principalId !== undefined && uuid(legalEntityId) && uuid(principalId)
    ? { legalEntityId, principalId }
    : undefined;
};

/**
 * The Shell people page selects a person from its own governed directory. A company-qualified link must name the
 * trusted selected company; the unqualified form stays for existing bookmarks and tenant-scope selection.
 */
export const peopleDetailSelection = (person?: string, selectedLegalEntityId?: string): PeopleDetailSelection => {
  if (person === undefined) {
    return { state: 'none' };
  }
  if (!Schema.is(PersonQuerySchema)(person)) {
    return { state: 'invalid' };
  }
  const qualified = qualifiedPerson(person);
  if (qualified !== undefined) {
    if (selectedLegalEntityId === undefined) {
      return { state: 'company_required' };
    }
    if (qualified.legalEntityId !== selectedLegalEntityId) {
      return { state: 'foreign_company' };
    }
    return { companyQualified: true, principalId: qualified.principalId, state: 'selected' };
  }
  if (person.includes('.')) {
    return { state: 'invalid' };
  }
  if (!uuid(person)) {
    return { state: 'invalid' };
  }
  return { companyQualified: false, principalId: person, state: 'selected' };
};

/** Decode both query values independently so a malformed person link cannot hide a valid agent link. */
export const peopleDetailQuery = (search: DetailSearch, selectedLegalEntityId?: string): PeopleDetailQuery => {
  const { agent: agentValue, person } = search;
  const agent = Schema.is(PersonIdSchema)(agentValue) ? agentValue : undefined;
  let selection: PeopleDetailSelection = { state: 'none' };
  if (string(person)) {
    selection = peopleDetailSelection(person, selectedLegalEntityId);
  } else if (person !== undefined) {
    selection = { state: 'invalid' };
  }
  return agent === undefined ? { person: selection } : { agent, person: selection };
};

/** The exact URL contract the Shell search mapping supplies for a company-qualified person. */
export const peopleDetailHref = (legalEntityId: string, principalId: string): string => {
  const resourceId = `${legalEntityId}.${principalId}`;
  return `${PEOPLE_DETAIL_PATH}?${PEOPLE_DETAIL_QUERY_PARAM}=${encodeURIComponent(resourceId)}`;
};
