import { bindActionTestServices, makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { Effect, Exit, Logger, Redacted, Schema } from 'effect';
import { Base64, Hex } from 'effect/encoding';
import { expect, it } from 'effect-rstest';

import { CustomerOwnPasswordChangeExchange } from '../../api/portal-auth/password-change/change-exchange.ts';
import { CommercePortalAuthRecoveryRateLimitService } from '../../api/portal-auth/rate-limit-service.ts';
import { CommercePortalAuthService } from '../../api/portal-auth/session/auth-service.ts';
import {
  ChangeOwnCustomerPasswordPayloadSchema,
  CustomerOwnWriteAuthorizedSchema,
} from '../../shared/portal-auth/own-session.ts';
import { changeOwnCustomerPasswordAction } from '../../src/actions/change-own-customer-password.action.ts';
import { CommercePortalAuthAudit } from '../../src/portal-auth/audit/audit.ts';
import { commerceCustomerContextRegistration } from '../../vertical.registration.ts';
import type { CommercePortalAuthAuditEvent } from '../../src/portal-auth/audit/audit-contracts.ts';

/*
 * The customer's password change is an Action, and an Action keeps its payload's hash, its invocation, its evidence
 * and its idempotency record. None of them may hold the passwords, nor anything derived from them: they travel only
 * in the route's own exchange, redacted, to Better Auth. A same-key retry of a committed change changes nothing and
 * cannot replay one, because no stored input exists to replay.
 */

const CURRENT = 'Current-Secret-Value-7f3a!';
const NEXT = 'Brand-New-Secret-Value-9c1e!';
const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '20000000-0000-4000-8000-000000000001';
const workloadPrincipal = {
  authBindingId: '30000000-0000-4000-8000-000000000001',
  authContextRef: 'gateway-assertion:storefront-client',
  authMethod: 'api_key',
  legalEntityId,
  principalId: '30000000-0000-4000-8000-000000000002',
  tenantId,
} as const;
const session = {
  authBindingId: '40000000-0000-4000-8000-000000000001',
  customerPrincipalId: '40000000-0000-4000-8000-000000000002',
  partyId: '40000000-0000-4000-8000-000000000003',
  providerSubjectId: 'customer-subject',
  sessionRefDigest: 'a'.repeat(64),
};

/** Every encoding of a secret a careless writer could leave behind: itself, its digests, its base64. */
const derivativesOf = (secret: string): readonly string[] => {
  const digest = sha256(utf8ToBytes(secret));
  return [secret, Hex.encode(digest), Base64.encode(digest), Base64.encode(utf8ToBytes(secret))];
};
const forbidden = [...derivativesOf(CURRENT), ...derivativesOf(NEXT)];
const leaksIn = (text: string) => forbidden.filter((value) => text.includes(value));

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const scenario = Effect.fn('PasswordRedaction.scenario')(function* scenario() {
  const logs: string[] = [];
  const auditEvents: CommercePortalAuthAuditEvent[] = [];
  const providerBodies: unknown[] = [];
  const harness = yield* makeActionTestHarness({
    access: 'allowed',
    onOwnerAuthorization: () => 'allowed',
    ownerRegistration: commerceCustomerContextRegistration,
    services: [bindActionTestServices(changeOwnCustomerPasswordAction, {})],
  });
  const payload = yield* Schema.decodeUnknownEffect(ChangeOwnCustomerPasswordPayloadSchema)({ session });
  const invoke = (idempotencyKey: string) =>
    harness.runtime
      .runAction({
        payload,
        principal: workloadPrincipal,
        registration: changeOwnCustomerPasswordAction,
        transport: { correlationId: `password-redaction-${idempotencyKey}`, idempotencyKey },
      })
      .pipe(
        Effect.provideService(CustomerOwnPasswordChangeExchange, {
          currentPassword: Redacted.make(CURRENT),
          newPassword: Redacted.make(NEXT),
          requestHeaders: new Headers({ cookie: 'commerce-portal.session_token=opaque' }),
          sessionRef: 'session-reference',
        }),
        Effect.provideService(CommercePortalAuthAudit, {
          record: (event) => Effect.sync(() => auditEvents.push(event)),
        }),
        Effect.provideService(CommercePortalAuthRecoveryRateLimitService, { consume: () => Effect.succeed(true) }),
        Effect.provideService(CommercePortalAuthService, {
          api: Schema.decodeUnknownSync(Schema.Any)({
            changePassword: (request: { readonly body: unknown }) => {
              providerBodies.push(request.body);
              return Promise.resolve({ token: null });
            },
          }),
        }),
        Effect.provide(
          Logger.layer([
            Logger.make((options) => {
              logs.push(JSON.stringify(Logger.formatStructured.log(options)));
            }),
          ]),
        ),
        Effect.exit,
      );
  const first = yield* invoke('password-change-key');
  const retried = yield* invoke('password-change-key');
  return { auditEvents, first, harness, logs, providerBodies, retried };
});

it.effect('neither password nor anything derived from it reaches evidence, logs or the idempotency record', () =>
  Effect.gen(function* redaction() {
    const { auditEvents, first, harness, logs, providerBodies } = yield* scenario();
    expect(Exit.isSuccess(first) ? first.value : undefined).toEqual(
      Schema.decodeUnknownSync(CustomerOwnWriteAuthorizedSchema)({ authorized: true }),
    );
    // The provider received exactly the two passwords, once: that is the only place they go.
    expect(providerBodies).toEqual([{ currentPassword: CURRENT, newPassword: NEXT, revokeOtherSessions: true }]);
    const snapshot = harness.snapshot();
    // The payload is the session and nothing else; the invocation keeps its key and request hash.
    expect(snapshot.invocations).toHaveLength(1);
    for (const [where, text] of [
      ['invocations and idempotency record', encodeJson(snapshot.invocations)],
      ['committed Core evidence', encodeJson(snapshot.committed)],
      ['portal audit', encodeJson(auditEvents)],
      ['logs', logs.join('\n')],
    ] as const) {
      expect({ leaks: leaksIn(text), where }).toEqual({ leaks: [], where });
    }
    // The scan reads the real records: the evidence names the operation and the invocation its request hash.
    expect(encodeJson(snapshot.committed)).toContain('customer-password-change');
    expect(encodeJson(snapshot.invocations)).toContain('password-change-key');
    expect(Object.keys(ChangeOwnCustomerPasswordPayloadSchema.fields)).toEqual(['session']);
    expect(auditEvents.map(({ eventType }) => eventType)).toEqual([
      'commerce.portal-auth.password-change-requested.v1',
      'commerce.portal-auth.password-changed.v1',
    ]);
  }),
);

it.effect('a same-key retry of a committed change changes no password and replays no stored input', () =>
  Effect.gen(function* sameKeyRetry() {
    const { providerBodies, retried } = yield* scenario();
    // The retry is refused as already committed: the routine never runs a second time.
    expect(Exit.isFailure(retried)).toBe(true);
    expect(providerBodies).toHaveLength(1);
  }),
);

/** How one failing attempt ends: refused by the gate or the owner rule, or failing at or after the provider. */
const FAILURES = [
  ['the gate refuses the caller', { access: 'denied' }],
  ['the owner rule refuses the session', { owner: 'denied' }],
  ['the provider says the current password is wrong', { provider: 'wrong-current' }],
  ['the provider fails', { provider: 'error' }],
  ['the provider defects', { provider: 'defect' }],
] as const;

const failingScenario = Effect.fn('PasswordRedaction.failing')(function* failingScenario(
  failure: (typeof FAILURES)[number][1],
) {
  const logs: string[] = [];
  const auditEvents: CommercePortalAuthAuditEvent[] = [];
  const harness = yield* makeActionTestHarness({
    access: 'access' in failure ? failure.access : 'allowed',
    onOwnerAuthorization: () => ('owner' in failure ? failure.owner : 'allowed'),
    ownerRegistration: commerceCustomerContextRegistration,
    services: [bindActionTestServices(changeOwnCustomerPasswordAction, {})],
  });
  const payload = yield* Schema.decodeUnknownEffect(ChangeOwnCustomerPasswordPayloadSchema)({ session });
  const provider = 'provider' in failure ? failure.provider : 'never';
  const exit = yield* harness.runtime
    .runAction({
      payload,
      principal: workloadPrincipal,
      registration: changeOwnCustomerPasswordAction,
      transport: { correlationId: 'password-redaction-failing', idempotencyKey: 'password-redaction-failing' },
    })
    .pipe(
      Effect.provideService(CustomerOwnPasswordChangeExchange, {
        currentPassword: Redacted.make(CURRENT),
        newPassword: Redacted.make(NEXT),
        requestHeaders: new Headers({ cookie: 'commerce-portal.session_token=opaque' }),
        sessionRef: 'session-reference',
      }),
      Effect.provideService(CommercePortalAuthAudit, {
        record: (event) => Effect.sync(() => auditEvents.push(event)),
      }),
      Effect.provideService(CommercePortalAuthRecoveryRateLimitService, { consume: () => Effect.succeed(true) }),
      Effect.provideService(CommercePortalAuthService, {
        api: Schema.decodeUnknownSync(Schema.Any)({
          changePassword: (request: { readonly body: { readonly currentPassword: string } }) => {
            // Every failure the provider could carry the passwords in: its message, its body and its cause.
            const echo = `${request.body.currentPassword} ${NEXT}`;
            if (provider === 'defect') {
              throw new Error(`provider crashed with ${echo}`);
            }
            return Promise.reject(
              Object.assign(new Error(`provider refused ${echo}`), {
                body: { code: provider === 'wrong-current' ? 'INVALID_PASSWORD' : 'INTERNAL', message: echo },
              }),
            );
          },
        }),
      }),
      Effect.provide(
        Logger.layer([
          Logger.make((options) => {
            logs.push(JSON.stringify(Logger.formatStructured.log(options)));
          }),
        ]),
      ),
      Effect.exit,
    );
  return { auditEvents, exit, harness, logs };
});

for (const [label, failure] of FAILURES) {
  it.effect(`no password reaches evidence, logs, the audit or the answer when ${label}`, () =>
    Effect.gen(function* failingRedaction() {
      const { auditEvents, exit, harness, logs } = yield* failingScenario(failure);
      expect(Exit.isFailure(exit)).toBe(true);
      // A provider case really reached the provider: its intent and its outcome row are there.
      expect(auditEvents.map(({ eventType }) => eventType)).toEqual(
        'provider' in failure
          ? ['commerce.portal-auth.password-change-requested.v1', 'commerce.portal-auth.password-change-failed.v1']
          : [],
      );
      const snapshot = harness.snapshot();
      for (const [where, text] of [
        ['invocations and idempotency record', encodeJson(snapshot.invocations)],
        ['committed Core evidence', encodeJson(snapshot.committed)],
        ['refusal evidence', encodeJson([snapshot.permissionDenials, snapshot.policyDenials])],
        ['portal audit', encodeJson(auditEvents)],
        ['logs', logs.join('\n')],
        ['the answer', encodeJson(Exit.isFailure(exit) ? String(exit.cause) : '')],
      ] as const) {
        expect({ leaks: leaksIn(text), where }).toEqual({ leaks: [], where });
      }
    }),
  );
}
