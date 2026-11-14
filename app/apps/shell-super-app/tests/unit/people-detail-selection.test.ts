import { expect, test } from 'effect-rstest';

import {
  PEOPLE_DETAIL_PATH,
  peopleDetailHref,
  peopleDetailQuery,
  peopleDetailSelection,
} from '../../src/routes/people/people-detail-selection.ts';

const companyId = '11111111-1111-4111-8111-111111111111';
const otherCompanyId = '22222222-2222-4222-8222-222222222222';
const principalId = '33333333-3333-4333-8333-333333333333';
const agentId = '44444444-4444-4444-8444-444444444444';

test('a company-qualified person selects its principal only in the trusted selected company', () => {
  expect(peopleDetailSelection(`${companyId}.${principalId}`, companyId)).toEqual({
    companyQualified: true,
    principalId,
    state: 'selected',
  });
});

test('a foreign company qualifier is rejected instead of stripping it to the same principal', () => {
  expect(peopleDetailSelection(`${otherCompanyId}.${principalId}`, companyId)).toEqual({
    state: 'foreign_company',
  });
  expect(peopleDetailSelection(`${otherCompanyId}.${principalId}`)).toEqual({
    state: 'company_required',
  });
});

test('an unqualified principal remains an existing bookmark in company and tenant scope', () => {
  expect(peopleDetailSelection(principalId, companyId)).toEqual({
    companyQualified: false,
    principalId,
    state: 'selected',
  });
  expect(peopleDetailSelection(principalId)).toEqual({
    companyQualified: false,
    principalId,
    state: 'selected',
  });
});

test.each([
  ['an empty value', ''],
  ['a non-UUID local part', `${companyId}.not-a-uuid`],
  ['a non-UUID company', `not-a-uuid.${principalId}`],
  ['an extra segment', `${companyId}.${principalId}.extra`],
  ['a reversed separator', `${principalId}/${companyId}`],
  ['a bare company', `${companyId}.`],
] as const)('a malformed person link (%s) is rejected', (_label, value) => {
  expect(peopleDetailSelection(value, companyId)).toEqual({ state: 'invalid' });
});

test('a missing person query is not an error', () => {
  expect(peopleDetailSelection()).toEqual({ state: 'none' });
  expect(peopleDetailQuery({}, companyId)).toEqual({ person: { state: 'none' } });
});

test('a valid agent link survives a malformed person value in the same query', () => {
  expect(peopleDetailQuery({ agent: agentId, person: 'bad.person' }, companyId)).toEqual({
    agent: agentId,
    person: { state: 'invalid' },
  });
});

test('an invalid agent value never becomes a selected agent', () => {
  expect(peopleDetailQuery({ agent: 'not-an-agent' }, companyId)).toEqual({
    person: { state: 'none' },
  });
});

test('the exact search-to-people URL carries the full company-qualified resource ID', () => {
  const qualifiedId = `${companyId}.${principalId}`;
  expect(PEOPLE_DETAIL_PATH).toBe('/sprava/lide-a-role');
  expect(peopleDetailHref(companyId, principalId)).toBe(
    `/sprava/lide-a-role?person=${encodeURIComponent(qualifiedId)}`,
  );
});
