import { DateTime, Effect, Layer, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  PORTAL_AUTH_EMAIL_FLOWS,
  portalAuthCommunicationPurposeOf,
  PortalAuthIssuanceRefSchema,
} from '../../shared/portal-auth-communications.ts';
import type { PortalAuthIssuance } from '../../src/portal-auth/communications/issuance.ts';
import {
  CommercePortalAuthPreVerificationPrivacyBinding,
  preVerificationBindPayloadOf,
  privacyPreVerificationBindingLayer,
  unsupportedPreVerificationPrivacyBindingLayer,
} from '../../src/portal-auth/communications/pre-verification-privacy-binding.ts';
import {
  CommercePortalAuthPreVerificationPrivacyTransport,
  unavailablePreVerificationPrivacyTransportLayer,
} from '../../src/portal-auth/communications/pre-verification-privacy-transport.ts';
import type { PreVerificationPrivacyTransportService } from '../../src/portal-auth/communications/pre-verification-privacy-transport.ts';
import { PreVerificationPrivacyBindingUnavailable } from '../../src/portal-auth/communications/privacy-binding-unavailable.ts';

/**
 * #1406 D.8 — Auth's production binding asks Privacy's public bind Action with Auth's own account reference only. The
 * transport here is SCRIPTED; the REAL Privacy Action answers in `scripts/integration/auth-communications-privacy-blocked`.
 * Every address, token and code below is FICTIONAL and must never reach the request.
 */
const ADDRESS = 'someone@example.test';
const SECRET = 'fictional-token-abc123';
const decodeRef = Schema.decodeSync(PortalAuthIssuanceRefSchema);

const issuanceOf = (flow: (typeof PORTAL_AUTH_EMAIL_FLOWS)[number]): PortalAuthIssuance => ({
  expiresAt: DateTime.makeUnsafe('2026-11-19T10:15:00.000Z'),
  flow,
  issuanceRef: decodeRef(`pa-${flow}-1`),
  issuedAt: DateTime.makeUnsafe('2026-11-19T10:00:00.000Z'),
  providerSubjectId: 'subject-1',
});

/** Privacy's published answer, as a FICTIONAL policy would produce it. */
const privacyAnswer = {
  bindingRef: '40000000-0000-4000-8000-0000000000b1',
  policy: { policyRef: 'fictional-policy', revision: 'fictional-r1' },
  scope: {
    controllerRef: 'fictional-controller',
    dataCategoryRefs: ['fictional:contact'],
    operation: 'FICTIONAL_SEND',
    processingScopeRef: { scopeId: 'fictional-scope', scopeType: 'privacy.processing-scope' },
    purposeRef: 'fictional-purpose',
    purposeVersionId: 'fictional-purpose-v1',
    recipientRefs: ['fictional.communications'],
    subjectRef: {
      moduleId: 'privacy.core',
      resourceId: '40000000-0000-4000-8000-0000000000b1',
      resourceType: 'privacy.core.privacy-subject',
      tenantId: '40000000-0000-4000-8000-000000000001',
    },
  },
  status: 'ACTIVE',
  validUntil: '2026-11-19T10:15:00.000Z',
};

const bindOver = (transport: PreVerificationPrivacyTransportService, issuance = issuanceOf('verify-email')) =>
  Effect.gen(function* bind() {
    const binding = yield* CommercePortalAuthPreVerificationPrivacyBinding;
    return yield* binding.bind(issuance);
  }).pipe(
    Effect.provide(
      privacyPreVerificationBindingLayer.pipe(
        Layer.provide(Layer.succeed(CommercePortalAuthPreVerificationPrivacyTransport, transport)),
      ),
    ),
  );

const unavailableFor = (reason: PreVerificationPrivacyBindingUnavailable['reason']) =>
  new PreVerificationPrivacyBindingUnavailable({ reason });

describe('#1406 D.8 the bind request of a Portal Auth issuance', () => {
  for (const flow of PORTAL_AUTH_EMAIL_FLOWS) {
    it(`[${flow}] names Auth's own account reference, the flow's Auth purpose and the issuance expiry, nothing else`, () => {
      const payload = preVerificationBindPayloadOf(issuanceOf(flow));
      expect(payload).toEqual({
        occurrence: { occurrenceId: `pa-${flow}-1`, validUntil: '2026-11-19T10:15:00.000Z' },
        source: {
          moduleId: 'commerce.customer-context',
          resourceId: 'subject-1',
          resourceType: 'commerce.customer-context.portal-auth-account',
        },
        sourcePurposeRef: portalAuthCommunicationPurposeOf(flow),
      });
      expect(JSON.stringify(payload)).not.toContain(ADDRESS);
      expect(JSON.stringify(payload)).not.toContain(SECRET);
    });
  }
});

describe("#1406 D.8 only Privacy's own answer is a binding", () => {
  it.effect('returns the subject and scope Privacy bound, read with its published schema', () =>
    Effect.gen(function* bound() {
      const asked: unknown[] = [];
      const binding = yield* bindOver({
        bind: (payload) => {
          asked.push(payload);
          return Effect.succeed(privacyAnswer);
        },
      });
      expect(binding.bindingRef).toBe(privacyAnswer.bindingRef);
      expect(binding.scope.purposeVersionId).toBe('fictional-purpose-v1');
      expect(asked).toEqual([preVerificationBindPayloadOf(issuanceOf('verify-email'))]);
    }),
  );

  it.effect('treats an answer outside the published contract as an unavailable Privacy, never a binding', () =>
    Effect.gen(function* malformed() {
      const failure = yield* Effect.flip(bindOver({ bind: () => Effect.succeed({ bindingRef: 'not-a-binding' }) }));
      expect(failure).toEqual(unavailableFor('PRIVACY_UNAVAILABLE'));
    }),
  );

  it.effect("keeps Privacy's refusal and the missing transport as distinct stops", () =>
    Effect.gen(function* refused() {
      const refusal = yield* Effect.flip(bindOver({ bind: () => Effect.fail(unavailableFor('PRIVACY_REFUSED')) }));
      expect(refusal).toEqual(unavailableFor('PRIVACY_REFUSED'));
      const noTransport = yield* Effect.flip(
        Effect.gen(function* bind() {
          const binding = yield* CommercePortalAuthPreVerificationPrivacyBinding;
          return yield* binding.bind(issuanceOf('otp'));
        }).pipe(
          Effect.provide(
            privacyPreVerificationBindingLayer.pipe(Layer.provide(unavailablePreVerificationPrivacyTransportLayer)),
          ),
        ),
      );
      expect(noTransport).toEqual(unavailableFor('NO_SUPPORTED_PRIVACY_PATH'));
      const unsupported = yield* Effect.flip(
        Effect.gen(function* bind() {
          const binding = yield* CommercePortalAuthPreVerificationPrivacyBinding;
          return yield* binding.bind(issuanceOf('reset-password'));
        }).pipe(Effect.provide(unsupportedPreVerificationPrivacyBindingLayer)),
      );
      expect(unsupported).toEqual(unavailableFor('NO_SUPPORTED_PRIVACY_PATH'));
    }),
  );
});
