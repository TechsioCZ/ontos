import { createOwnerPermissionAccessTarget } from '../../src/permissions/context-access.ts';
import { fixtureOwnerContract, fixtureOwnerModule, ownerPermissionTarget } from '../support/owner-permission-target.ts';
import { DateTime } from 'effect';
import { expect, it } from 'effect-rstest';

import type { OwnerAuthorizationInput } from '../../src/permissions/owner-authorization-overlay.ts';
import { failClosedOwnerAuthorizationDecision } from '../../src/permissions/owner-authorization-overlay.ts';

const input = (target: OwnerAuthorizationInput['targets'][number]): OwnerAuthorizationInput => ({
  operation: 'action',
  operationAt: DateTime.makeUnsafe(0),
  operationKey: 'commerce.fixture.create',
  owningModuleKey: fixtureOwnerModule,
  scope: {
    authContextRef: 'owner-overlay-test',
    authMethod: 'session',
    correlationId: 'owner-overlay-test',
    legalEntityId: '30000000-0000-4000-8000-000000000001',
    principalId: '20000000-0000-4000-8000-000000000001',
    tenantId: '10000000-0000-4000-8000-000000000001',
  },
  targets: [target],
});

it('fails closed for owner targets while keeping owner-neutral targets available', () => {
  const { scope } = input({ kind: 'module', moduleId: fixtureOwnerModule });
  const ownerDecision = failClosedOwnerAuthorizationDecision(
    input({ kind: 'owner_permission', target: ownerPermissionTarget(scope) }),
  );
  const neutralDecision = failClosedOwnerAuthorizationDecision(input({ kind: 'module', moduleId: fixtureOwnerModule }));
  expect(ownerDecision).toBe('unavailable');
  expect(neutralDecision).toBe('allowed');
});

it('allows stateless owner declarations only for the exact trusted operation scope', () => {
  const { scope } = input({ kind: 'module', moduleId: fixtureOwnerModule });
  const contract = Object.freeze({ ...fixtureOwnerContract, ownerStateRequired: false });
  const statelessDecision = (legalEntityId: string | undefined, tenantId = scope.tenantId) =>
    failClosedOwnerAuthorizationDecision(
      input({
        kind: 'owner_permission',
        target: createOwnerPermissionAccessTarget(
          contract,
          ownerPermissionTarget(legalEntityId === undefined ? { tenantId } : { legalEntityId, tenantId }),
        ),
      }),
    );
  expect(statelessDecision(scope.legalEntityId)).toBe('allowed');
  expect(statelessDecision('30000000-0000-4000-8000-000000000002')).toBe('unavailable');
  expect(statelessDecision(scope.legalEntityId, '10000000-0000-4000-8000-000000000002')).toBe('unavailable');
  expect(
    failClosedOwnerAuthorizationDecision(input({ kind: 'owner_permission', target: ownerPermissionTarget(scope) })),
  ).toBe('unavailable');
});

it('rejects an unknown authorization target kind instead of inheriting neutral fallback', () => {
  const unknown = { kind: 'module' as const, moduleId: 'commerce.fixture' };
  Reflect.set(unknown, 'kind', 'unrecognized_target');
  expect(failClosedOwnerAuthorizationDecision(input(unknown))).toBe('unavailable');
});
