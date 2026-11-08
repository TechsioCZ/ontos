import { expect, it } from 'effect-rstest';

import { akrosDemoLegalEntityId, eshopDemoLegalEntityId } from '../demo/fixture-ids.mts';
import {
  kavarnaMarketAuthorityPrincipal,
  marketRetirementPrincipal,
  unmappedServicePrincipals,
  reviewedWorkloadBindings,
} from '../demo/permissions.mts';

/*
 * The Market retirement authority is a machine identity with **no** v2 Role: the carrier
 * `commerce.customer-context.market-retirement.reserve` declares `accessActor.callers = [commerce-market-catalog]`
 * and `subject: 'rights'`, so it is the acting module's call relayed under the retiring user's rights — a
 * service principal is refused there and declares no `accessWorkload`. Nothing may widen it to a Role, and
 * nothing may invent a workload key for it.
 */
const retirementCarrier = 'commerce.customer-context.market-retirement.reserve';

it('pins the dedicated Market service identities to their own company', () => {
  expect(marketRetirementPrincipal).toMatchObject({
    apiKeyName: 'market-retirement-authority',
    displayName: 'Market · retirement authority',
    legalEntityId: akrosDemoLegalEntityId,
  });
  expect(kavarnaMarketAuthorityPrincipal).toMatchObject({
    apiKeyName: 'kavarna-market-authority',
    legalEntityId: eshopDemoLegalEntityId,
  });
});

it('grants each Market gateway principal nothing: its carrier delegates rights to the acting module', () => {
  const bound = new Set(reviewedWorkloadBindings().map((binding) => binding.principalId));
  for (const principalId of [marketRetirementPrincipal.principalId, kavarnaMarketAuthorityPrincipal.principalId]) {
    expect(bound.has(principalId)).toBe(false);
  }
  const blockers = unmappedServicePrincipals.filter(
    (entry) =>
      entry.principalId === marketRetirementPrincipal.principalId ||
      entry.principalId === kavarnaMarketAuthorityPrincipal.principalId,
  );
  expect(blockers).toHaveLength(2);
  for (const blocker of blockers) {
    expect(blocker.carrier).toContain(retirementCarrier);
    expect(blocker.reason).toContain('rights');
  }
});

it('names exactly the reviewed retirement capability, never a wildcard or a broad module grant', () => {
  // The reviewed capability is what a canonical rebuild of this carrier must declare; the seed may not
  // substitute a module read/write or a read_all/write_all alias for it.
  const reviewed = 'commerce.customer-context.market-retirement.reserve';
  const encoded = JSON.stringify(unmappedServicePrincipals);
  expect(encoded).not.toContain('read_all');
  expect(encoded).not.toContain('write_all');
  expect(encoded).not.toContain('"*"');
  expect(reviewed).toBe(retirementCarrier);
});

it('keeps the market retirement authority read-only: no market write capability is reviewed for it', () => {
  const encoded = JSON.stringify(unmappedServicePrincipals);
  expect(encoded).not.toContain('commerce.market-catalog.market.retire');
  expect(encoded).not.toContain('commerce.market-catalog.market.suspend');
});
