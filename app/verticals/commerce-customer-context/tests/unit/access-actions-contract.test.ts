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
import { accessManagementPermissionTarget } from '../../src/actions/access-action-support.ts';
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
      expect(descriptor.entrypoint.authorization).toEqual({
        kind: 'action_execution',
        provisioning: 'explicit',
      });
    }
    for (const action of [
      grantCounterpartyCommerceAccessAction,
      revokeCounterpartyCommerceAccessAction,
      createCounterpartyAccessInvitationAction,
      resendCounterpartyAccessInvitationAction,
      revokeCounterpartyAccessInvitationAction,
    ]) {
      expect(action.descriptor.businessPermission?.kind).toBe('business_permission');
    }
    expect(bootstrapCounterpartyAccessAdministratorAction.descriptor.businessPermission).toBe(
      undefined,
    );
    expect(claimCounterpartyAccessInvitationAction.descriptor.businessPermission).toBe(undefined);
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
    expect(
      Schema.decodeUnknownSync(CreateCounterpartyAccessInvitationPayloadSchema)(payload),
    ).toEqual(payload);
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

  it('forwards only the gateway-verified Storefront identity into Action authorization', () => {
    const counterpartyRef = {
      moduleId: 'party.registry' as const,
      resourceId: 'counterparty-1',
      resourceType: 'party.registry.counterparty' as const,
      tenantId: '10000000-0000-4000-8000-000000000001',
    };
    const storefrontScope = { kind: 'storefront' as const, storefrontKey: 'storefront-1' };
    const operationalScope = {
      authMethod: 'system' as const,
      correlationId: 'access-action-target',
      legalEntityId: '20000000-0000-4000-8000-000000000002',
      principalId: '30000000-0000-4000-8000-000000000003',
      tenantId: counterpartyRef.tenantId,
    };

    expect(
      accessManagementPermissionTarget(
        { counterpartyRef, scope: storefrontScope },
        operationalScope,
      ),
    ).not.toHaveProperty('trustedStorefrontId');
    expect(
      accessManagementPermissionTarget(
        { counterpartyRef, scope: storefrontScope },
        { ...operationalScope, trustedStorefrontId: storefrontScope.storefrontKey },
      ),
    ).toHaveProperty('trustedStorefrontId', storefrontScope.storefrontKey);
  });
});
