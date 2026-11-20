import { CommunicationRequestSchema } from '@app/communications-contracts/communication-request';
import { DateTime, Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  PORTAL_AUTH_EMAIL_FLOWS,
  portalAuthCommunicationPurposeOf,
  portalAuthIdempotencyKey,
  portalAuthOwnerRenderedSlotOf,
  PortalAuthIssuanceRefSchema,
} from '../../shared/portal-auth-communications.ts';
import type { PortalAuthIssuance } from '../../src/portal-auth/communications/issuance.ts';
import { portalAuthCommunicationRequest } from '../../src/portal-auth/communications/request.ts';

/**
 * #1406 AUTH-COM-01/06: the Communication Request of an Auth issuance names what happened and for whom and can hold no secret.
 * Every token, link, code, password and address below is FICTIONAL test data.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const SECRETS = [
  'fictional-token-abc123',
  'https://portal.example.test/verify-email?token=fictional-token-abc123',
  '482913',
];
const ADDRESS = 'someone@example.test';
const ENROLLMENT_INVOCATION = '22222222-2222-4222-8222-222222222222';
const decodeRef = Schema.decodeSync(PortalAuthIssuanceRefSchema);
const decodeRequest = Schema.decodeUnknownSync(CommunicationRequestSchema, { onExcessProperty: 'error' });

const issuanceOf = (flow: (typeof PORTAL_AUTH_EMAIL_FLOWS)[number]): PortalAuthIssuance => ({
  enrollmentOwnerInvocationId: ENROLLMENT_INVOCATION,
  expiresAt: DateTime.makeUnsafe('2026-11-19T10:15:00.000Z'),
  flow,
  issuanceRef: decodeRef(`pa-${flow}-1`),
  issuedAt: DateTime.makeUnsafe('2026-11-19T10:00:00.000Z'),
  providerSubjectId: 'subject-1',
});

describe('The Communication Request of a Portal Auth issuance (#1406)', () => {
  for (const flow of PORTAL_AUTH_EMAIL_FLOWS) {
    it.effect(
      `[${flow}] is a valid published request: its own occurrence, original subject and endpoint by reference, trusted scope`,
      () =>
        Effect.gen(function* validRequest() {
          const request = yield* portalAuthCommunicationRequest(issuanceOf(flow), { tenantId: TENANT });
          const decoded = decodeRequest(request);
          expect(decoded.source.moduleKey).toBe('commerce.customer-context');
          expect(decoded.purpose).toBe(portalAuthCommunicationPurposeOf(flow));
          expect(decoded.occurrence).toStrictEqual({ occurrenceId: `pa-${flow}-1`, revision: 1 });
          expect(decoded.scope).toStrictEqual({ tenantId: TENANT });
          expect(decoded.originalRecipients).toHaveLength(1);
          expect(decoded.originalRecipients[0]?.recipientRef).toMatchObject({
            moduleId: 'commerce.customer-context',
            resourceId: 'subject-1',
            resourceType: 'commerce.customer-context.portal-auth-account',
          });
          expect(decoded.originalRecipients[0]?.originalContact?.evidence.kind).toBe('HISTORICAL_SNAPSHOT');
          expect(decoded.documents).toBeUndefined();
          expect(decoded.resendOf).toBeUndefined();
        }),
    );

    it.effect(
      `[${flow}] carries no secret, no address and no enrollment identity, and its key derives from the issuance alone`,
      () =>
        Effect.gen(function* secretFreeRequest() {
          const request = yield* portalAuthCommunicationRequest(issuanceOf(flow), { tenantId: TENANT });
          const text = JSON.stringify(request);
          for (const secret of [...SECRETS, ADDRESS, ENROLLMENT_INVOCATION]) {
            expect(text).not.toContain(secret);
          }
          expect(request.idempotency.key).toBe(portalAuthIdempotencyKey(flow, decodeRef(`pa-${flow}-1`)));
          expect(request.idempotency.key).toBe(`portal-auth.${flow}.pa-${flow}-1`);
          // the secret slot the approved revision declares is Auth's own and is never a field of the request
          expect(text).not.toContain(portalAuthOwnerRenderedSlotOf(flow));
        }),
    );
  }

  it.effect(
    'a Legal Entity scope travels only when the trusted scope has one, and an unknown field is refused, never dropped',
    () =>
      Effect.gen(function* scoping() {
        const withEntity = yield* portalAuthCommunicationRequest(issuanceOf('otp'), {
          legalEntityId: '33333333-3333-4333-8333-333333333333',
          tenantId: TENANT,
        });
        expect(decodeRequest(withEntity).scope.legalEntityId).toBe('33333333-3333-4333-8333-333333333333');
        expect(() => decodeRequest({ ...withEntity, secret: 'x' })).toThrow();
      }),
  );

  it('the three flows own three distinct purposes and three distinct owner-rendered slots', () => {
    expect(new Set(PORTAL_AUTH_EMAIL_FLOWS.map(portalAuthCommunicationPurposeOf)).size).toBe(3);
    expect(new Set(PORTAL_AUTH_EMAIL_FLOWS.map(portalAuthOwnerRenderedSlotOf)).size).toBe(3);
  });
});
