import { expect, it } from 'effect-rstest';

import { roleCellGrowth } from './adaptation-check.mts';

const profilePage = 'commerce.customer-context.customer-profile-source-page.read';
const profileParties = 'commerce.customer-context.customer-profile-source-parties.read';
const customerGroup = 'commerce.customer-context.customer-group.read';

it('names each role cell whose capability the base release lacks, once per role and key', () => {
  const roles = [
    {
      cells: [{ capabilityKey: customerGroup }, { capabilityKey: profilePage }, { capabilityKey: profilePage }],
      key: 'sales',
    },
    { cells: [{ capabilityKey: profileParties }, { capabilityKey: customerGroup }], key: 'accounting' },
    { cells: [{ capabilityKey: customerGroup }], key: 'warehouse' },
  ];
  expect(roleCellGrowth(roles, new Set([customerGroup]))).toEqual([
    { key: profilePage, kind: 'reviewed-role-cell', owner: 'sales' },
    { key: profileParties, kind: 'reviewed-role-cell', owner: 'accounting' },
  ]);
  expect(roleCellGrowth(roles, new Set([customerGroup, profilePage, profileParties]))).toEqual([]);
});
