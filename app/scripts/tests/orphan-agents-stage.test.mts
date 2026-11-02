import { expect, it } from 'effect-rstest';
import { orphanArchivalSafe } from '../demo/orphan-agents-stage.mts';

const safe = {
  activeBindings: 0,
  activeOAuthGrants: 0,
  companyMemberships: 0,
  directAuthority: 0,
  displayName: 'Asistent provozu',
  historyIds: ['preserved-history'],
  kind: 'agent',
  openProposals: 0,
  principalId: '24c3628e-d340-46d1-a87b-5d8f98d0fa87',
  scopedRoles: 0,
  sourceDeclared: false,
  status: 'active',
};
it('permits only the exact two unassigned unused orphans; archived retries remain safe', () => {
  expect(orphanArchivalSafe(safe)).toBe(true);
  expect(orphanArchivalSafe({ ...safe, principalId: '301134e3-1bb2-4430-a865-01599ef12df8' })).toBe(true);
  expect(orphanArchivalSafe({ ...safe, status: 'archived' })).toBe(true);
});
it('refuses any company, credential, direct/scoped grant, open proposal or source-declared agent', () => {
  for (const row of [
    { ...safe, activeBindings: 1 },
    { ...safe, activeOAuthGrants: 1 },
    { ...safe, companyMemberships: 1 },
    { ...safe, directAuthority: 1 },
    { ...safe, scopedRoles: 1 },
    { ...safe, openProposals: 1 },
    { ...safe, sourceDeclared: true },
    { ...safe, kind: 'human' },
    { ...safe, displayName: 'Jiný agent' },
    { ...safe, principalId: 'eba6a70a-141b-466b-a12c-eb498675c852' },
    { ...safe, status: 'disabled' },
  ]) {
    expect(orphanArchivalSafe(row)).toBe(false);
  }
});
