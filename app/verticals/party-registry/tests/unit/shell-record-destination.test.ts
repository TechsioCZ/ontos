import { expect, it } from 'effect-rstest';

import { partyRegistryManifest } from '../../vertical.manifest.ts';

const { navigation, pages } = partyRegistryManifest.publicSurface.shellContributions;

it('declares the Party identity page as the record destination of its own Party type', () => {
  const identity = pages.find(({ contributionKey }) => contributionKey === 'party.registry.page.party-identity');
  expect(identity?.routePath).toBe('/prodej/strany/:partyId');
  expect(identity?.recordTarget).toEqual({ idParameter: 'partyId', resourceType: 'party.registry.party' });
  // The declared type is the module's own published resource type.
  expect(partyRegistryManifest.publicSurface.resourceTypes.some(({ key }) => key === 'party.registry.party')).toBe(
    true,
  );
});

it('keeps the Party identity page out of navigation, so no sidebar item is invented', () => {
  expect(navigation.map(({ pageKey }) => pageKey)).toEqual([
    'party.registry.page.contacts',
    'party.registry.page.customers',
  ]);
  expect(navigation.some(({ pageKey }) => pageKey === 'party.registry.page.party-identity')).toBe(false);
});
