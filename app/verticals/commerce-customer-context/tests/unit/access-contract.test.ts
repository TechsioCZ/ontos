import { describe, expect, it } from 'effect-rstest';
import { Effect, Exit, Schema } from 'effect';
import {
  canRevokeAdministratorGrant,
  decideCounterpartyPermission,
} from '../../shared/domain/access-contract.ts';
import type { CounterpartyAccessGrant } from '../../shared/domain/access-contract.ts';
import { unavailableCounterpartyAccessPort } from '../../shared/domain/access-port.ts';
import {
  CounterpartyAccessInvitationSchema,
  invitationCanBeginClaim,
  invitationCanBeResent,
  invitationCanBeRevoked,
  invitationCanTransition,
  invitationCompletionState,
  invitationHasUniquePermissions,
} from '../../shared/domain/invitation-contract.ts';
import type { CounterpartyAccessInvitation } from '../../shared/domain/invitation-contract.ts';
import {
  COUNTERPARTY_AUTHORITY_GROUPS,
  COUNTERPARTY_BUSINESS_PERMISSION_CATALOG,
  COUNTERPARTY_PERMISSION_CATALOG,
  COUNTERPARTY_PERMISSION_CODES,
  CounterpartyPermissionCodeSchema,
} from '../../shared/domain/permission-catalog.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const actorId = '10000000-0000-4000-8000-000000000002';
const recipientId = '10000000-0000-4000-8000-000000000003';
const counterpartyRef = {
  moduleId: 'party.registry' as const,
  resourceId: 'counterparty-1',
  resourceType: 'party.registry.counterparty' as const,
  tenantId,
};
const actor = {
  principalId: actorId,
  tenantId,
};
const recipient = { ...actor, principalId: recipientId };
const counterpartyScope = { kind: 'counterparty' } as const;

const grant = (
  resourceId: string,
  state: CounterpartyAccessGrant['state'],
  scope: CounterpartyAccessGrant['scope'] = counterpartyScope,
  permission: CounterpartyAccessGrant['permission'] = 'counterparty.purchase.submit',
): CounterpartyAccessGrant => ({
  catalogVersion: '1',
  counterpartyRef,
  grantedAt: '2026-09-09T10:00:00.000Z',
  grantedBy: actor,
  grantRef: {
    moduleId: 'commerce.customer-context',
    resourceId,
    resourceType: 'commerce.customer-context.counterparty-commerce-access-grant',
    tenantId,
  },
  permission,
  recipient,
  revision: 1,
  scope,
  state,
});

const invitation = (
  state: CounterpartyAccessInvitation['state'],
): CounterpartyAccessInvitation => ({
  catalogVersion: '1',
  claimProofVersion: 'commerce-invitation-proof.v1',
  counterpartyRef,
  createdAt: '2026-09-09T10:00:00.000Z',
  deliveryMethod: 'VERIFIED_CONTACT_POINT',
  deliveryReference: 'delivery-ref-1',
  expiresAt: '2026-09-10T10:00:00.000Z',
  grantProgress: [],
  intendedPermissions: ['counterparty.purchase.prepare'],
  invitationRef: {
    moduleId: 'commerce.customer-context',
    resourceId: 'invitation-1',
    resourceType: 'commerce.customer-context.counterparty-access-invitation',
    tenantId,
  },
  invitedBy: actor,
  reason: 'Onboard purchasing user',
  revision: 1,
  scope: { kind: 'counterparty' },
  state,
});

const progressGrantRef = {
  moduleId: 'commerce.customer-context' as const,
  resourceId: 'claim-grant-1',
  resourceType: 'commerce.customer-context.counterparty-commerce-access-grant' as const,
  tenantId,
};

describe('Counterparty Permission catalog', () => {
  it('publishes exactly the governed fifteen codes and three bundles', () => {
    expect(COUNTERPARTY_PERMISSION_CODES).toEqual([
      'counterparty.profile.read',
      'counterparty.purchase.prepare',
      'counterparty.purchase.submit',
      'counterparty.approval.decide',
      'counterparty.approval.request.manage',
      'counterparty.access.read',
      'counterparty.access.manage',
      'counterparty.settings.price_group.manage',
      'counterparty.settings.payment_terms.manage',
      'counterparty.address_book.use',
      'counterparty.address_book.manage',
      'counterparty.history.read_own',
      'counterparty.history.read_all',
      'counterparty.purchase_limit.manage',
      'counterparty.approval_hierarchy.manage',
    ]);
    expect(new Set(Object.keys(COUNTERPARTY_PERMISSION_CATALOG))).toEqual(
      new Set(COUNTERPARTY_PERMISSION_CODES),
    );
    expect(COUNTERPARTY_AUTHORITY_GROUPS).toEqual({
      COUNTERPARTY_ACCESS_ADMINISTRATOR: ['counterparty.access.read', 'counterparty.access.manage'],
      COUNTERPARTY_APPROVER: ['counterparty.approval.decide'],
      COUNTERPARTY_BUYER: [
        'counterparty.profile.read',
        'counterparty.purchase.prepare',
        'counterparty.purchase.submit',
        'counterparty.address_book.use',
      ],
    });
    expect(COUNTERPARTY_BUSINESS_PERMISSION_CATALOG.permissions).toHaveLength(15);
    expect(Object.isFrozen(COUNTERPARTY_BUSINESS_PERMISSION_CATALOG)).toBe(true);
    for (const metadata of Object.values(COUNTERPARTY_PERMISSION_CATALOG)) {
      expect(metadata.owningCapability.length).toBeGreaterThan(0);
      expect(metadata.protectedEntrypoints.length).toBeGreaterThan(0);
    }
  });

  it('makes high-impact settings internal-only and rejects unknown permission strings', () => {
    for (const permission of [
      'counterparty.settings.price_group.manage',
      'counterparty.settings.payment_terms.manage',
      'counterparty.purchase_limit.manage',
      'counterparty.approval_hierarchy.manage',
    ] as const) {
      expect(COUNTERPARTY_PERMISSION_CATALOG[permission].customerDelegable).toBe(false);
      expect(COUNTERPARTY_PERMISSION_CATALOG[permission].reasonRequired).toBe(true);
    }
    expect(() =>
      Schema.decodeUnknownSync(CounterpartyPermissionCodeSchema)('counterparty.*'),
    ).toThrow();
  });
});

describe('Counterparty Commerce Access decisions', () => {
  const decide = (
    grants: readonly CounterpartyAccessGrant[],
    scope: CounterpartyAccessGrant['scope'],
  ) =>
    decideCounterpartyPermission(grants, {
      counterpartyRef,
      permission: 'counterparty.purchase.submit',
      principalRef: recipient,
      scope,
    });

  it('uses positive scope union and lets a broad active grant cover a storefront', () => {
    expect(
      decide([grant('broad', 'ACTIVE')], { kind: 'storefront', storefrontKey: 'b2b-eu' }),
    ).toBe('ALLOWED');
    expect(
      decide([grant('exact', 'ACTIVE', { kind: 'storefront', storefrontKey: 'b2b-eu' })], {
        kind: 'storefront',
        storefrontKey: 'b2b-us',
      }),
    ).toBe('DENIED');
    expect(
      decide([grant('exact', 'ACTIVE', { kind: 'storefront', storefrontKey: 'b2b-eu' })], {
        kind: 'counterparty',
      }),
    ).toBe('DENIED');
  });

  it('fails closed on reconciliation but lets another matching active grant authorize', () => {
    expect(decide([grant('uncertain', 'RECONCILIATION_REQUIRED')], { kind: 'counterparty' })).toBe(
      'UNAVAILABLE',
    );
    expect(
      decide([grant('uncertain', 'RECONCILIATION_REQUIRED'), grant('active', 'ACTIVE')], {
        kind: 'counterparty',
      }),
    ).toBe('ALLOWED');
    expect(decide([grant('pending', 'PENDING_GRANT')], { kind: 'counterparty' })).toBe('DENIED');
    expect(decide([grant('revoked', 'REVOKED')], { kind: 'counterparty' })).toBe('DENIED');
  });

  it('never treats a same-valued Principal id from another Tenant as authorized', () => {
    expect(
      decideCounterpartyPermission([grant('active', 'ACTIVE')], {
        counterpartyRef,
        permission: 'counterparty.purchase.submit',
        principalRef: { ...recipient, tenantId: '90000000-0000-4000-8000-000000000009' },
        scope: counterpartyScope,
      }),
    ).toBe('DENIED');
  });

  it('protects the last active access administrator grant', () => {
    const first = grant(
      'admin-1',
      'ACTIVE',
      { kind: 'counterparty' },
      'counterparty.access.manage',
    );
    const second = grant(
      'admin-2',
      'ACTIVE',
      { kind: 'counterparty' },
      'counterparty.access.manage',
    );
    expect(canRevokeAdministratorGrant([first], first.grantRef)).toBe(false);
    expect(canRevokeAdministratorGrant([first, second], first.grantRef)).toBe(true);
  });

  it.effect('exposes a typed unavailable port that always fails closed', () =>
    Effect.gen(function* unavailablePortFailsClosed() {
      const result = yield* Effect.exit(
        unavailableCounterpartyAccessPort('relationship store offline').check({
          counterpartyRef,
          permission: 'counterparty.profile.read',
          principal: recipient,
          scope: counterpartyScope,
        }),
      );
      expect(Exit.isFailure(result)).toBe(true);
    }),
  );
});

describe('Counterparty Access Invitation lifecycle', () => {
  it('requires a non-empty unique permission set', () => {
    expect(invitationHasUniquePermissions([])).toBe(false);
    expect(invitationHasUniquePermissions(['counterparty.purchase.prepare'])).toBe(true);
    expect(
      invitationHasUniquePermissions([
        'counterparty.purchase.prepare',
        'counterparty.purchase.prepare',
      ]),
    ).toBe(false);
  });

  it('allows only pending, unexpired invitations to resend or begin claim', () => {
    const pending = invitation('PENDING');
    expect(invitationCanBeResent(pending, '2026-09-09T12:00:00.000Z')).toBe(true);
    expect(invitationCanBeginClaim(pending, '2026-09-10T12:00:00.000Z')).toBe(false);
    expect(invitationCanBeRevoked(pending)).toBe(true);
    expect(invitationCanBeRevoked(invitation('CLAIMING'))).toBe(true);
    expect(invitationCanBeRevoked(invitation('CLAIMED'))).toBe(false);
  });

  it('moves to claimed only after every intended grant is active', () => {
    expect(
      invitationCompletionState(
        ['counterparty.purchase.prepare', 'counterparty.purchase.submit'],
        [
          {
            grantRef: progressGrantRef,
            permission: 'counterparty.purchase.prepare',
            state: 'ACTIVE',
          },
          { permission: 'counterparty.purchase.submit', state: 'PENDING_GRANT' },
        ],
      ),
    ).toBe('CLAIMING');
    expect(
      invitationCompletionState(
        ['counterparty.purchase.prepare', 'counterparty.purchase.submit'],
        [
          {
            grantRef: progressGrantRef,
            permission: 'counterparty.purchase.prepare',
            state: 'ACTIVE',
          },
          {
            grantRef: { ...progressGrantRef, resourceId: 'claim-grant-2' },
            permission: 'counterparty.purchase.submit',
            state: 'ACTIVE',
          },
        ],
      ),
    ).toBe('CLAIMED');
    expect(
      invitationCompletionState(
        ['counterparty.purchase.prepare'],
        [
          {
            grantRef: progressGrantRef,
            permission: 'counterparty.purchase.prepare',
            state: 'RECONCILIATION_REQUIRED',
          },
        ],
      ),
    ).toBe('RECONCILIATION_REQUIRED');
    expect(invitationCanTransition('PENDING', 'CLAIMING')).toBe(true);
    expect(invitationCanTransition('CLAIMED', 'PENDING')).toBe(false);
  });

  it('rejects claimed invitations with missing, extra, or duplicate grant progress', () => {
    const activeProgress = {
      grantRef: progressGrantRef,
      permission: 'counterparty.purchase.prepare' as const,
      state: 'ACTIVE' as const,
    };
    const claimed = {
      ...invitation('CLAIMED'),
      claimant: recipient,
      grantProgress: [activeProgress],
    };
    expect(Schema.is(CounterpartyAccessInvitationSchema)(claimed)).toBe(true);
    expect(Schema.is(CounterpartyAccessInvitationSchema)({ ...claimed, grantProgress: [] })).toBe(
      false,
    );
    expect(
      Schema.is(CounterpartyAccessInvitationSchema)({
        ...claimed,
        grantProgress: [
          activeProgress,
          { ...activeProgress, grantRef: { ...progressGrantRef, resourceId: 'extra' } },
        ],
      }),
    ).toBe(false);
    expect(
      invitationCompletionState(
        ['counterparty.purchase.prepare', 'counterparty.purchase.submit'],
        [
          activeProgress,
          {
            ...activeProgress,
            grantRef: { ...progressGrantRef, resourceId: 'duplicate' },
          },
        ],
      ),
    ).toBe('RECONCILIATION_REQUIRED');
    expect(invitationCanBeRevoked({ ...claimed, state: 'RECONCILIATION_REQUIRED' })).toBe(true);
  });
});
