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
import { declareMenu, recordFailure, recordVisit, warmupGaps } from '../ops/stage-warmup-coverage.mts';
import type { WarmupCoverage } from '../ops/stage-warmup-coverage.mts';
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

const personas = warmupAccounts.map(({ email }) => email);
const MENU = ['/cs', '/cs/prodej/klienti', '/cs/ukoly'];

/**
 * The sweep as scripts/ops/stage-warmup.mts records it: a persona declares its menu once logged in, records each
 * destination it read, and records the phase that stopped it. `stop` names where a persona fails: its login, or the
 * destination it was clicking.
 */
const sweepPersona = (coverage: WarmupCoverage, email: string, stoppedAt: string | undefined): WarmupCoverage => {
  if (stoppedAt === 'login') {
    return recordFailure(coverage, email, `login:${email}`);
  }
  let held = declareMenu(coverage, email, MENU);
  for (const destination of MENU) {
    if (destination === stoppedAt) {
      return recordFailure(held, email, `destination:${destination}`);
    }
    held = recordVisit(held, email, destination);
  }
  return held;
};

const sweep = (stop: ReadonlyMap<string, string>) => {
  let coverage: WarmupCoverage = new Map();
  for (const email of personas) {
    coverage = sweepPersona(coverage, email, stop.get(email));
  }
  return coverage;
};

const [obchod = '', najempark = ''] = personas;

it('passes a sweep in which every persona declared its menu and read all of it', () => {
  expect(warmupGaps(personas, sweep(new Map()))).toEqual([]);
});

it('fails a sweep in which a persona failed before it declared its menu, however fast', () => {
  expect(warmupGaps(personas, sweep(new Map([[obchod, 'login']])))).toEqual([
    `${obchod} did not log in and declare its menu (stopped at login:${obchod})`,
  ]);
  // A persona the budget cut off before its login answered recorded nothing at all: the same gap.
  const cutOff = new Map([...sweep(new Map())].filter(([email]) => email !== obchod));
  expect(warmupGaps(personas, cutOff)).toEqual([`${obchod} did not log in and declare its menu`]);
});

it('fails a sweep in which a destination failed mid-sweep, naming what was left unread', () => {
  expect(warmupGaps(personas, sweep(new Map([[najempark, '/cs/prodej/klienti']])))).toEqual([
    `${najempark} left 2/3 destinations unread (stopped at destination:/cs/prodej/klienti): /cs/prodej/klienti, /cs/ukoly`,
  ]);
  // A persona that was served an empty menu read nothing, so it verified nothing.
  expect(warmupGaps(personas, declareMenu(sweep(new Map()), obchod, []))).toEqual([
    `${obchod} declared no destination`,
  ]);
});
