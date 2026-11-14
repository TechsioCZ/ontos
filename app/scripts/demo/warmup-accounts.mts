/**
 * Operational browser warmup reuses reviewed demo people. It creates no Principal, membership,
 * auth binding or Role. The runner's request guard permits reads and session setup only, but the
 * person's actual authority is still exactly the Role assigned by the canonical demo seed.
 *
 * Old synthetic warmup people are no longer seed intent. Removing existing live rows is a separate
 * operator action, not a source cutover or a reason to hide principals by Role key.
 */
import { demoLegalEntityId, rentalDemoLegalEntityId } from './fixture-ids.mts';
import { companyHumanAccounts, demoHumanAccounts, siamparkRentalPersonas } from './permissions.mts';

export const warmupAccounts = [
  { ...demoHumanAccounts[0], company: 'obchod', legalEntityId: demoLegalEntityId },
  { ...siamparkRentalPersonas[1], company: 'najempark', legalEntityId: rentalDemoLegalEntityId },
  ...companyHumanAccounts.filter(({ role }) => ['crmManager', 'eshopAdmin', 'akrosAdmin'].includes(role)),
];
