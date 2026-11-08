import { describe, expect, it } from 'effect-rstest';
import { Schema } from 'effect';
import { bootstrapCounterpartyAccessAdministratorAction } from '../../src/actions/bootstrap-counterparty-access-administrator.action.ts';
import { claimCounterpartyAccessInvitationAction } from '../../src/actions/claim-counterparty-access-invitation.action.ts';
import {
  CreateCounterpartyAccessInvitationPayloadSchema,
  createCounterpartyAccessInvitationAction,
} from '../../src/actions/create-counterparty-access-invitation.action.ts';
import { grantCounterpartyCommerceAccessAction } from '../../src/actions/grant-counterparty-commerce-access.action.ts';
import { resendCounterpartyAccessInvitationAction } from '../../src/actions/resend-counterparty-access-invitation.action.ts';
import { revokeCounterpartyAccessInvitationAction } from '../../src/actions/revoke-counterparty-access-invitation.action.ts';
import { revokeCounterpartyCommerceAccessAction } from '../../src/actions/revoke-counterparty-commerce-access.action.ts';
import { accessManagementOwnerFacts } from '../../src/actions/access-action-support.ts';
import { InvitationClaimRejectionSchema } from '../../shared/domain/access-port.ts';

const actions = [
  grantCounterpartyCommerceAccessAction,
  revokeCounterpartyCommerceAccessAction,
  bootstrapCounterpartyAccessAdministratorAction,
  createCounterpartyAccessInvitationAction,
  resendCounterpartyAccessInvitationAction,
  revokeCounterpartyAccessInvitationAction,
  claimCounterpartyAccessInvitationAction,
] as const;

describe('Counterparty Commerce Access Actions', () => {
  it('keeps every mutation idempotent, explicitly provisioned, scoped, and sensitive', () => {
    expect(actions).toHaveLength(7);
    for (const { descriptor } of actions) {
      expect(descriptor.actionKey.startsWith('commerce.customer-context.')).toBe(true);
      expect(descriptor.idempotency).toBe('required');
      expect(descriptor.legalEntityScope).toBe('required');
      expect(descriptor.auditProfile).toBe('sensitive');
      expect(descriptor.entrypoint.authorization).toEqual({ kind: 'protected' });
    }
    for (const action of [
      grantCounterpartyCommerceAccessAction,
      revokeCounterpartyCommerceAccessAction,
      createCounterpartyAccessInvitationAction,
      resendCounterpartyAccessInvitationAction,
      revokeCounterpartyAccessInvitationAction,
    ]) {
      expect(action.descriptor.accessOwnerFacts).toBeDefined();
    }
    expect(bootstrapCounterpartyAccessAdministratorAction.descriptor.accessOwnerFacts).toBe(undefined);
    expect(claimCounterpartyAccessInvitationAction.descriptor.accessOwnerFacts).toBe(undefined);
  });

  it('accepts only a verified delivery reference and never a raw invitation secret', () => {
    const payload = {
      counterpartyRef: {
        moduleId: 'party.registry' as const,
        resourceId: 'counterparty-1',
        resourceType: 'party.registry.counterparty' as const,
        tenantId: '10000000-0000-4000-8000-000000000001',
      },
      deliveryMethod: 'VERIFIED_CONTACT_POINT' as const,
      deliveryReference: 'contact-point-ref-1',
      expiresAt: '2026-09-10T10:00:00.000Z',
      intendedPermissions: ['counterparty.purchase.prepare' as const],
      reason: 'Onboard buyer',
      scope: { kind: 'counterparty' as const },
    };
    expect(Schema.decodeUnknownSync(CreateCounterpartyAccessInvitationPayloadSchema)(payload)).toEqual(payload);
    expect(() =>
      Schema.decodeUnknownSync(CreateCounterpartyAccessInvitationPayloadSchema, {
        onExcessProperty: 'error',
      })({ ...payload, invitationSecret: 'must-not-cross-this-contract' }),
    ).toThrow();
  });

  it('keeps committed claim rejections closed and outside the public success schema', () => {
    const rejections = ['ALREADY_CONSUMED', 'EXPIRED', 'INVALID_PROOF', 'RATE_LIMITED'] as const;
    for (const rejection of rejections) {
      expect(Schema.decodeUnknownSync(InvitationClaimRejectionSchema)(rejection)).toBe(rejection);
    }
    expect(() => Schema.decodeUnknownSync(InvitationClaimRejectionSchema)('UNAVAILABLE')).toThrow();
    expect(
      Schema.is(claimCounterpartyAccessInvitationAction.descriptor.resultSchema)({
        invitation: {},
        outcome: 'REJECTED',
        rejection: 'INVALID_PROOF',
      }),
    ).toBe(false);
  });

  it('names the counterparty and its verified Storefront for the owner rule', () => {
    const counterpartyRef = {
      moduleId: 'party.registry' as const,
      resourceId: 'counterparty-1',
      resourceType: 'party.registry.counterparty' as const,
      tenantId: '10000000-0000-4000-8000-000000000001',
    };
    const storefrontScope = { kind: 'storefront' as const, storefrontKey: 'storefront-1' };

    // Both branches name the counterparty; only a Storefront-scoped change carries the Storefront the
    // overlay compares with the trusted scope before it reads the counterparty's grant (O67-Q1, O70).
    expect(accessManagementOwnerFacts({ counterpartyRef, scope: { kind: 'counterparty' } })).toEqual({
      counterpartyId: counterpartyRef.resourceId,
    });
    expect(accessManagementOwnerFacts({ counterpartyRef, scope: storefrontScope })).toEqual({
      counterpartyId: counterpartyRef.resourceId,
      storefrontId: storefrontScope.storefrontKey,
    });
  });
});
