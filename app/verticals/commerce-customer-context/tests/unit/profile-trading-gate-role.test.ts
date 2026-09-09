import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import type {
  CounterpartyRoleEligibility,
  ProfilePersistenceScope,
  ProfileScopedRoutineInvoker,
} from '../../src/persistence/profile-persistence.ts';
import { profilePersistenceServicesForTransaction } from '../../src/persistence/profile-persistence.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '20000000-0000-4000-8000-000000000002';
const otherLegalEntityId = '20000000-0000-4000-8000-000000000099';
const principalId = '30000000-0000-4000-8000-000000000003';
const profileId = '40000000-0000-4000-8000-000000000004';
const counterpartyId = '50000000-0000-4000-8000-000000000005';
const roleId = '60000000-0000-4000-8000-000000000006';

const scope: ProfilePersistenceScope = { legalEntityId, principalId, tenantId };
const request = {
  authorizationSubject: {
    counterpartyRef: {
      moduleId: 'party.registry' as const,
      resourceId: counterpartyId,
      resourceType: 'party.registry.counterparty' as const,
      tenantId,
    },
    kind: 'COUNTERPARTY' as const,
  },
  profileRef: {
    kind: 'COUNTERPARTY' as const,
    moduleId: 'commerce.customer-context' as const,
    resourceId: profileId,
    resourceType: 'commerce.customer-context.counterparty-purchasing-profile' as const,
    tenantId,
  },
};

const transaction: ProfileScopedRoutineInvoker = {
  invoke: () =>
    Effect.succeed([
      {
        outcome: 'PROFILE_AVAILABLE',
        payload: {
          createdAt: '2026-09-09T09:00:00.000Z',
          profileId,
          profileKind: 'COUNTERPARTY',
          revision: 3,
          scopeLegalEntityId: legalEntityId,
          state: 'ACTIVE',
          subject: {
            counterpartyResourceId: counterpartyId,
            counterpartyResourceRevision: 'counterparty:7',
            customerRoleResourceId: roleId,
            customerRoleResourceRevision: '2026-09-09T08:00:00.000Z',
            kind: 'COUNTERPARTY',
          },
          updatedAt: '2026-09-09T09:00:00.000Z',
        },
      },
    ]) as never,
};

const gateWith = (eligibility: CounterpartyRoleEligibility) =>
  profilePersistenceServicesForTransaction(transaction, scope, {
    resolveCounterpartyRole: () => Effect.succeed(eligibility),
  }).customerProfileTradingGate.evaluateGate(request, tenantId);

it.effect('requires a current seller-matching CUSTOMER Role in addition to Active lifecycle', () =>
  gateWith({
    managedLegalEntityId: legalEntityId,
    outcome: 'ELIGIBLE',
    roleResourceId: roleId,
    roleResourceRevision: '2026-09-09T10:00:00.000Z',
  }).pipe(
    Effect.tap((result) =>
      Effect.sync(() => {
        expect(result.gate).toEqual({ canAcceptNewOrder: true, outcome: 'ACTIVE' });
        expect(result.provenance[1]).toMatchObject({
          freshness: {
            revision: '2026-09-09T10:00:00.000Z',
            sourceModuleId: 'party.registry',
            status: 'CURRENT',
          },
          projection: 'PARTY_REGISTRY',
          sourceResourceRef: roleId,
        });
      }),
    ),
  ),
);

it.effect(
  'denies a non-eligible Role instead of treating global profile uniqueness as role denial',
  () =>
    gateWith({ outcome: 'INELIGIBLE' }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.gate).toEqual({
            canAcceptNewOrder: false,
            outcome: 'COUNTERPARTY_ROLE_NOT_ELIGIBLE',
          });
          expect(result.provenance[1]).toMatchObject({
            freshness: { sourceModuleId: 'party.registry', status: 'CURRENT' },
            projection: 'PARTY_REGISTRY',
          });
          expect(result.provenance[1]).not.toHaveProperty('sourceResourceRef');
        }),
      ),
    ),
);

it.effect('fails closed when an eligible Role belongs to another seller', () =>
  gateWith({
    managedLegalEntityId: otherLegalEntityId,
    outcome: 'ELIGIBLE',
    roleResourceId: roleId,
    roleResourceRevision: '2026-09-09T10:00:00.000Z',
  }).pipe(
    Effect.tap((result) =>
      Effect.sync(() => {
        expect(result.gate).toEqual({
          canAcceptNewOrder: false,
          outcome: 'COUNTERPARTY_ROLE_NOT_ELIGIBLE',
        });
        expect(result.provenance[1]).toMatchObject({
          freshness: {
            sourceModuleId: 'party.registry',
            status: 'INDETERMINATE',
          },
          projection: 'PARTY_REGISTRY',
          sourceResourceRef: roleId,
        });
      }),
    ),
  ),
);
