import { expect, it } from 'effect-rstest';

import { demoId } from '../demo/fixture-ids.mts';
import {
  companyHumanAccounts,
  demoCompanyMemberships,
  demoHumanAccounts,
  reviewedDemoAssignments,
  siamparkRentalPersonas,
} from '../demo/permissions.mts';
import { warmupAccounts } from '../demo/warmup-accounts.mts';
import { warmupRequestAllowed } from '../ops/stage-warmup.mts';

it('warms every demo company with an existing reviewed persona instead of creating phantom people', () => {
  const known = new Map(
    [...demoHumanAccounts, ...companyHumanAccounts, ...siamparkRentalPersonas].map((person) => [
      person.principalId,
      person.email,
    ]),
  );
  const assignments = reviewedDemoAssignments();
  expect(warmupAccounts).toHaveLength(5);
  expect(new Set(warmupAccounts.map(({ legalEntityId }) => legalEntityId)).size).toBe(5);
  for (const person of warmupAccounts) {
    expect(known.get(person.principalId)).toBe(person.email);
    expect(
      assignments.some(
        ({ legalEntityId, principalId }) =>
          principalId === person.principalId && legalEntityId === person.legalEntityId,
      ),
    ).toBe(true);
    expect(person.email).not.toMatch(/^warmup@/u);
  }
  for (const company of ['obchod', 'najempark', 'hanak', 'kavarna', 'sroubarna']) {
    const retiredId = demoId('core.principal', `warmup-${company}`);
    expect(assignments.some(({ principalId }) => principalId === retiredId)).toBe(false);
    expect(demoCompanyMemberships.some(({ principalId }) => principalId === retiredId)).toBe(false);
  }
});

it('keeps operational warmup read-only even when a reviewed person holds write cells', () => {
  const origin = 'https://ontos-stage.web-revolution.cz';
  expect(warmupRequestAllowed('POST', `${origin}/shell-super-app-api/auth/sign-in`)).toBe(true);
  expect(warmupRequestAllowed('POST', `${origin}/shell-super-app-api/core/reads/people`)).toBe(true);
  expect(warmupRequestAllowed('GET', `${origin}/cs/prodej/klienti`)).toBe(true);
  expect(warmupRequestAllowed('POST', `${origin}/crm-api/crm/actions/apply-command`)).toBe(false);
  expect(warmupRequestAllowed('DELETE', `${origin}/shell-super-app-api/core/reads/people`)).toBe(false);
  expect(warmupRequestAllowed('GET', 'https://outside.invalid/cs')).toBe(false);
});
