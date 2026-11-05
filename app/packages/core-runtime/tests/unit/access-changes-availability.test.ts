import { expect, it } from 'effect-rstest';

import { planCapabilityAvailability } from '../../src/access/changes/availability.ts';
import type { ScopeAdministrationFacts } from '../../src/access/changes/availability.ts';
import {
  MANAGER,
  OTHER_PERSON,
  PERSON,
  ROLE,
  SCOPE,
  TENANT,
  brandPrincipalId,
  brandScopeId,
  delegation,
  entry,
  failureOf,
  fixedId,
  instant,
  succeeded,
  tenantIdValue,
} from './access-changes-fixtures.ts';

const NOTE = 'test.party.add-note';

const facts = (input: Partial<ScopeAdministrationFacts> = {}): ScopeAdministrationFacts => ({
  at: instant(3),
  capabilityKey: entry({ key: NOTE }).key,
  delegations: [],
  owners: [],
  scopeAdmins: [],
  scopeId: brandScopeId(SCOPE),
  tenantId: tenantIdValue(TENANT),
  ...input,
});

it('makes a published capability configurable by its owner and usable by nobody', () => {
  const availability = succeeded(planCapabilityAvailability(facts({ owners: [brandPrincipalId(PERSON)] })));
  expect(availability.configurableBy.owners).toEqual([brandPrincipalId(PERSON)]);
  expect(availability.configurableBy.scopeAdmins).toEqual([]);
  expect(availability.configurableBy.delegatedManagers).toEqual([]);
  // Publication hands out nothing: no cell, no grant incarnation, and no usable capability.
  expect(availability.grants).toEqual({ cells: 0, incarnations: 0 });
  expect(availability.usableWithoutAdoption).toBe(false);
});

it('names the scope admins and the live delegated managers of that exact capability', () => {
  const availability = succeeded(
    planCapabilityAvailability(
      facts({
        delegations: [
          delegation({ capabilityKeys: [NOTE], managerId: MANAGER, people: [OTHER_PERSON], roleIds: [ROLE] }),
          delegation({
            capabilityKeys: ['test.party.other'],
            id: fixedId(61),
            managerId: OTHER_PERSON,
            people: [PERSON],
          }),
          delegation({
            capabilityKeys: [NOTE],
            id: fixedId(62),
            managerId: OTHER_PERSON,
            people: [PERSON],
            status: 'revoked',
          }),
          delegation({
            capabilityKeys: [NOTE],
            id: fixedId(63),
            managerId: OTHER_PERSON,
            people: [PERSON],
            validUntil: instant(2),
          }),
        ],
        owners: [brandPrincipalId(PERSON)],
        scopeAdmins: [brandPrincipalId(OTHER_PERSON), brandPrincipalId(PERSON)],
      }),
    ),
  );
  expect(availability.configurableBy.owners).toEqual([brandPrincipalId(PERSON)]);
  expect(availability.configurableBy.scopeAdmins).toEqual([brandPrincipalId(PERSON), brandPrincipalId(OTHER_PERSON)]);
  // Only the live delegation that names this capability makes its manager a configurator.
  expect(availability.configurableBy.delegatedManagers).toEqual([brandPrincipalId(MANAGER)]);
  expect(availability.scopeId).toEqual(brandScopeId(SCOPE));
});

it('never counts a manager delegated in another scope as a configurator here', () => {
  const otherScope = delegation({
    capabilityKeys: [NOTE],
    id: fixedId(64),
    managerId: MANAGER,
    people: [OTHER_PERSON],
    scopeId: fixedId(3),
  });
  // A delegation of the same capability in another legal entity administers nothing here (R2-L1).
  expect(failureOf(planCapabilityAvailability(facts({ delegations: [otherScope] }))).code).toBe(
    'access_changes_capability_not_configurable',
  );
  expect(
    succeeded(planCapabilityAvailability(facts({ delegations: [otherScope], owners: [brandPrincipalId(PERSON)] })))
      .configurableBy.delegatedManagers,
  ).toEqual([]);
  // The very same delegation in this scope does make its manager a configurator.
  expect(
    succeeded(
      planCapabilityAvailability(
        facts({
          delegations: [
            delegation({
              capabilityKeys: [NOTE],
              id: fixedId(65),
              managerId: MANAGER,
              people: [OTHER_PERSON],
              scopeId: SCOPE,
            }),
          ],
        }),
      ),
    ).configurableBy.delegatedManagers,
  ).toEqual([brandPrincipalId(MANAGER)]);
});

it('refuses a capability nobody could configure', () => {
  expect(failureOf(planCapabilityAvailability(facts())).code).toBe('access_changes_capability_not_configurable');
  expect(
    failureOf(
      planCapabilityAvailability(
        facts({
          delegations: [
            delegation({
              capabilityKeys: ['test.party.other'],
              id: fixedId(61),
              managerId: OTHER_PERSON,
              people: [PERSON],
            }),
          ],
        }),
      ),
    ).code,
  ).toBe('access_changes_capability_not_configurable');
});
