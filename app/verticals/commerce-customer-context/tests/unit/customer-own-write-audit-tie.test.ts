import { once } from 'node:events';

import { bindActionTestServices, makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import { ActiveApplicationCompositionService } from '@app/core-runtime/modules/active-application-composition';
import { NodeCrypto } from '@effect/platform-node';
import { Effect, Exit, Fiber, Redacted, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { expect, it } from 'effect-rstest';

import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { CustomerOwnConsentUpdateExchange } from '../../api/portal-auth/consent/update-exchange.ts';
import { CustomerOwnPasswordChangeExchange } from '../../api/portal-auth/password-change/change-exchange.ts';
import { outcomeUnknownLanguageOf } from '../../api/portal-auth/password-change/outcome-unknown-texts.ts';
import { passwordChangeOutcomeUnknown } from '../../api/portal-auth/password-change/problems.ts';
import { CustomerOwnProfileUpdateExchange } from '../../api/portal-auth/profile/update-exchange.ts';
import { CommercePortalAuthRecoveryRateLimitService } from '../../api/portal-auth/rate-limit-service.ts';
import { CommercePortalAuthService } from '../../api/portal-auth/session/auth-service.ts';
import {
  ChangeOwnCustomerPasswordPayloadSchema,
  UpdateOwnCustomerConsentPayloadSchema,
  UpdateOwnCustomerProfilePayloadSchema,
} from '../../shared/portal-auth/own-session.ts';
import { changeOwnCustomerPasswordAction } from '../../src/actions/change-own-customer-password.action.ts';
import { updateOwnCustomerConsentAction } from '../../src/actions/update-own-customer-consent.action.ts';
import { updateOwnCustomerProfileAction } from '../../src/actions/update-own-customer-profile.action.ts';
import { CommerceEnrollmentOwnerTransactionRunner } from '../../src/enrollment/orchestration/owner-transition-production.ts';
import { CommercePortalAuthAudit } from '../../src/portal-auth/audit/audit.ts';
import type { CommercePortalAuthAuditEvent } from '../../src/portal-auth/audit/audit-contracts.ts';
import { commerceCustomerContextRegistration } from '../../vertical.registration.ts';

/*
 * A storefront write records two things: Core's row that the operation was AUTHORIZED, and the portal audit's row of
 * what the routine then did (changed, refused with its class, or outcome unknown). The two are read together by the
 * Core invocation id, for each of the three writes. Neither holds a password, a hash, a token or a provider message.
 */

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
const SESSION_REF = 'session-reference';

/** What Better Auth answers: the change, a refusal with its code, or a verdict that is still on its way. */
interface Provider {
  readonly allowed?: boolean;
  /** Better Auth itself, when a test drives its answer (a verdict that arrives late). */
  readonly service?: typeof CommercePortalAuthService.Service;
  readonly verdict?: 'changed' | 'wrong-current';
}

const providerAnswer = (provider: Provider) =>
  provider.verdict === 'wrong-current'
    ? Promise.reject(Object.assign(new Error('provider says no'), { body: { code: 'INVALID_PASSWORD' } }))
    : Promise.resolve(null);

const harnessFor = (services: NonNullable<Parameters<typeof makeActionTestHarness>[0]>['services']) =>
  makeActionTestHarness({
    access: 'allowed',
    onOwnerAuthorization: () => 'allowed',
    ownerRegistration: commerceCustomerContextRegistration,
    services,
  });

const portal =
  (events: CommercePortalAuthAuditEvent[], provider: Provider) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(CommercePortalAuthAudit, { record: (event) => Effect.sync(() => events.push(event)) }),
      Effect.provideService(CommercePortalAuthRecoveryRateLimitService, {
        consume: () => Effect.succeed(provider.allowed ?? true),
      }),
      Effect.provideService(
        CommercePortalAuthService,
        provider.service ?? {
          api: Schema.decodeUnknownSync(Schema.Any)({ changePassword: () => providerAnswer(provider) }),
        },
      ),
      Effect.provideService(CustomerOwnPasswordChangeExchange, {
        currentPassword: Redacted.make('Current-Secret-Value-7f3a!'),
        newPassword: Redacted.make('Brand-New-Secret-Value-9c1e!'),
        requestHeaders: new Headers({ 'accept-language': 'en-GB,en;q=0.9,cs;q=0.8' }),
        sessionRef: SESSION_REF,
      }),
      Effect.provideService(CustomerOwnProfileUpdateExchange, { deliver: () => Effect.void, sessionRef: SESSION_REF }),
      Effect.provideService(CustomerOwnConsentUpdateExchange, { deliver: () => Effect.void, sessionRef: SESSION_REF }),
      // The late verdict of a change that completes past the call budget does reach a composition read, so this
      // service answers with a real snapshot and the test needs no composition snapshot in the environment.
      Effect.provideService(ActiveApplicationCompositionService, {
        load: makeApplicationCompositionSnapshotFixture(['commerce-customer-context'], ultramodernApiMarker.buildMarker),
      }),
      Effect.provideService(CommerceEnrollmentOwnerTransactionRunner, Schema.decodeUnknownSync(Schema.Any)({})),
      Effect.provide(NodeCrypto.layer),
    );

/** Core's one committed row of the invocation, and the portal rows that name it. */
const tieOf = (
  harness: Effect.Success<ReturnType<typeof harnessFor>>,
  events: readonly CommercePortalAuthAuditEvent[],
) => {
  const [committed] = harness.snapshot().committed;
  const invocation = committed?.actionInvocationId;
  return {
    evidence: JSON.stringify(committed?.evidence ?? null),
    invocation,
    rows: events.map(({ actionInvocationId, eventType, outcome }) => ({
      eventType,
      outcome,
      tied: invocation !== undefined && actionInvocationId === invocation,
    })),
  };
};

const runPassword = Effect.fn('AuditTie.password')(function* runPassword(provider: Provider) {
  const events: CommercePortalAuthAuditEvent[] = [];
  const harness = yield* harnessFor([bindActionTestServices(changeOwnCustomerPasswordAction, {})]);
  const payload = yield* Schema.decodeUnknownEffect(ChangeOwnCustomerPasswordPayloadSchema)({ session });
  const exit = yield* harness.runtime
    .runAction({
      payload,
      principal: workloadPrincipal,
      registration: changeOwnCustomerPasswordAction,
      transport: { correlationId: 'audit-tie-password', idempotencyKey: 'audit-tie-password' },
    })
    .pipe(portal(events, provider), Effect.exit);
  return { events, exit, harness };
});

it.effect('password: the authorized row and the changed row share one invocation', () =>
  Effect.gen(function* passwordChanged() {
    const { events, exit, harness } = yield* runPassword({ verdict: 'changed' });
    expect(Exit.isSuccess(exit)).toBe(true);
    const tie = tieOf(harness, events);
    expect(tie.evidence).toContain('"authorized":"customer-password-change"');
    expect(tie.rows).toEqual([
      { eventType: 'commerce.portal-auth.password-change-requested.v1', outcome: 'requested', tied: true },
      { eventType: 'commerce.portal-auth.password-changed.v1', outcome: 'success', tied: true },
    ]);
  }),
);

it.effect('password: a refusal after the authorization committed is one outcome row with its class', () =>
  Effect.gen(function* passwordRefused() {
    const limited = yield* runPassword({ allowed: false, verdict: 'changed' });
    expect(tieOf(limited.harness, limited.events).rows).toEqual([
      { eventType: 'commerce.portal-auth.password-change-failed.v1', outcome: 'rate_limited', tied: true },
    ]);
    const wrong = yield* runPassword({ verdict: 'wrong-current' });
    expect(Exit.isFailure(wrong.exit)).toBe(true);
    expect(tieOf(wrong.harness, wrong.events).rows.at(-1)).toEqual({
      eventType: 'commerce.portal-auth.password-change-failed.v1',
      outcome: 'unavailable',
      tied: true,
    });
    // No provider message reaches a row.
    expect(JSON.stringify(wrong.events)).not.toContain('provider says no');
  }),
);

it.effect('password: past the call budget the change may still complete, and its late verdict is recorded', () =>
  Effect.gen(function* passwordOutcomeUnknown() {
    // Better Auth answers only when the test releases it, long after the call budget.
    const provider = new EventTarget();
    const service = {
      api: Schema.decodeUnknownSync(Schema.Any)({
        changePassword: () => once(provider, 'answer'),
      }),
    };
    const run = yield* Effect.forkChild(runPassword({ service }));
    // Past the provider call budget (5 s), with the provider still silent.
    yield* Effect.yieldNow.pipe(Effect.repeat({ times: 20 }));
    yield* TestClock.adjust('6 seconds');
    const { events, exit, harness } = yield* Fiber.join(run);
    expect(Exit.isFailure(exit) ? JSON.stringify(exit.cause) : '').toContain('may still complete');
    expect(tieOf(harness, events).rows).toEqual([
      { eventType: 'commerce.portal-auth.password-change-requested.v1', outcome: 'requested', tied: true },
      { eventType: 'commerce.portal-auth.password-change-outcome-unknown.v1', outcome: 'outcome_unknown', tied: true },
    ]);
    // The provider answers late: its verdict is recorded under the same invocation.
    provider.dispatchEvent(new Event('answer'));
    yield* Effect.yieldNow.pipe(Effect.repeat({ times: 20 }));
    expect(tieOf(harness, events).rows.at(-1)).toEqual({
      eventType: 'commerce.portal-auth.password-changed.v1',
      outcome: 'success',
      tied: true,
    });
  }),
);

it.effect(
  'password: timed-out changes still running hold the in-flight cap; past it a change is refused unavailable',
  () =>
    Effect.gen(function* passwordInFlightCap() {
      // 32 changes whose provider stays silent outlive their requests; each keeps its provider call running.
      const provider = new EventTarget();
      let calls = 0;
      const service = {
        api: Schema.decodeUnknownSync(Schema.Any)({
          changePassword: () => {
            calls += 1;
            return once(provider, 'answer');
          },
        }),
      };
      const runs = yield* Effect.forEach(Array.from({ length: 32 }), () => Effect.forkChild(runPassword({ service })));
      yield* Effect.yieldNow.pipe(Effect.repeat({ times: 50 }));
      yield* TestClock.adjust('6 seconds');
      yield* Effect.forEach(runs, (run) => Fiber.join(run), { discard: true });
      expect(calls).toBe(32);
      // The 33rd is refused before any provider call, with its one outcome row.
      const refused = yield* runPassword({ service });
      expect(calls).toBe(32);
      expect(tieOf(refused.harness, refused.events).rows).toEqual([
        { eventType: 'commerce.portal-auth.password-change-requested.v1', outcome: 'requested', tied: true },
        { eventType: 'commerce.portal-auth.password-change-failed.v1', outcome: 'unavailable', tied: true },
      ]);
      // Once the provider answers, the calls settle and give their permits back.
      provider.dispatchEvent(new Event('answer'));
      yield* Effect.yieldNow.pipe(Effect.repeat({ times: 50 }));
      const next = yield* runPassword({
        service: { api: Schema.decodeUnknownSync(Schema.Any)({ changePassword: () => Promise.resolve(null) }) },
      });
      expect(Exit.isSuccess(next.exit)).toBe(true);
    }),
);

it.effect('profile: the authorized row and the refusal row share one invocation', () =>
  Effect.gen(function* profileRefused() {
    const events: CommercePortalAuthAuditEvent[] = [];
    const harness = yield* harnessFor([bindActionTestServices(updateOwnCustomerProfileAction, {})]);
    const payload = yield* Schema.decodeUnknownEffect(UpdateOwnCustomerProfilePayloadSchema)({
      session,
      update: {
        contactEmail: 'customer@example.test',
        displayName: 'Customer',
        phone: '+420777123456',
        version: 'a'.repeat(64),
      },
    });
    // No Party Registry gateway is configured here: the routine is refused as unavailable after the commit.
    const exit = yield* harness.runtime
      .runAction({
        payload,
        principal: workloadPrincipal,
        registration: updateOwnCustomerProfileAction,
        transport: { correlationId: 'audit-tie-profile', idempotencyKey: 'audit-tie-profile' },
      })
      .pipe(portal(events, { verdict: 'changed' }), Effect.exit);
    expect(Exit.isFailure(exit)).toBe(true);
    const tie = tieOf(harness, events);
    expect(tie.evidence).toContain('"authorized":"customer-profile-update"');
    expect(tie.rows).toEqual([
      { eventType: 'commerce.portal-auth.profile-update-failed.v1', outcome: 'unavailable', tied: true },
    ]);
  }),
);

it.effect('consent: the authorized row and the refusal row share one invocation', () =>
  Effect.gen(function* consentRefused() {
    const events: CommercePortalAuthAuditEvent[] = [];
    const harness = yield* harnessFor([bindActionTestServices(updateOwnCustomerConsentAction, {})]);
    const payload = yield* Schema.decodeUnknownEffect(UpdateOwnCustomerConsentPayloadSchema)({
      session,
      update: {
        decision: 'GRANTED',
        expectedRevision: 0,
        noticeAcknowledged: true,
        noticeVersionId: 'demo-newsletter.cs.v1',
        requestId: '50000000-0000-4000-8000-000000000001',
      },
    });
    const exit = yield* harness.runtime
      .runAction({
        payload,
        principal: workloadPrincipal,
        registration: updateOwnCustomerConsentAction,
        transport: { correlationId: 'audit-tie-consent', idempotencyKey: 'audit-tie-consent' },
      })
      .pipe(portal(events, { verdict: 'changed' }), Effect.exit);
    expect(Exit.isFailure(exit)).toBe(true);
    const tie = tieOf(harness, events);
    expect(tie.evidence).toContain('"authorized":"customer-newsletter-consent"');
    expect(tie.rows).toEqual([
      { eventType: 'commerce.portal-auth.consent-failed.v1', outcome: 'unavailable', tied: true },
    ]);
  }),
);

it('says the change may still complete in Czech or English, in the existing 503 shape', () => {
  expect(outcomeUnknownLanguageOf(new Headers({ 'accept-language': 'cs-CZ,cs;q=0.9,en;q=0.8' }))).toBe('cs');
  expect(outcomeUnknownLanguageOf(new Headers({ 'accept-language': 'de-DE,en;q=0.7,cs;q=0.5' }))).toBe('en');
  expect(outcomeUnknownLanguageOf(new Headers())).toBe('cs');
  const cs = passwordChangeOutcomeUnknown('cs');
  const en = passwordChangeOutcomeUnknown('en');
  for (const problem of [cs, en]) {
    expect({ code: problem.code, retryable: problem.retryable, status: problem.status }).toEqual({
      code: 'password_change_unavailable',
      retryable: true,
      status: 503,
    });
  }
  expect(cs.detail).toContain('může ještě dokončit');
  expect(en.detail).toContain('may still complete');
});
