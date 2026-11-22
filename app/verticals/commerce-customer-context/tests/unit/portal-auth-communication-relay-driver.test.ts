import { NodeCrypto } from '@effect/platform-node';
import { ConfigProvider, DateTime, Effect, Exit, Layer, Logger, Option, Ref, References, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { describe, expect, it } from 'effect-rstest';

import { PortalAuthIssuanceRefSchema } from '../../shared/portal-auth-communications.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { CommercePortalAuthCommunicationRequestSubmitter } from '../../src/portal-auth/communications/communication-request-submitter.ts';
import { CommercePortalAuthCommunicationStore } from '../../src/portal-auth/communications/communication-store.ts';
import type { PortalAuthIssuance } from '../../src/portal-auth/communications/issuance.ts';
import { portalAuthCommunicationRequest, storedRequestOf } from '../../src/portal-auth/communications/request.ts';
import {
  makePortalAuthCommunicationRelayLive,
  relayReleaseApproved,
  portalAuthCommunicationRelayAdopted,
} from '../../src/portal-auth/communications/request-relay.ts';
import {
  CommercePortalAuthTrustedScope,
  configuredTrustedScopeLayer,
  trustedScopeOfConfiguredTenant,
  unconfiguredTrustedScopeLayer,
} from '../../src/portal-auth/communications/trusted-scope.ts';
import { PortalAuthTrustedScopeUnavailable } from '../../src/portal-auth/communications/trusted-scope-unavailable.ts';
import { makeCommunicationStoreDouble } from '../support/portal-auth-communication-store.double.ts';

/**
 * #1406 D1: where the Portal Auth relay runs and when. It is the opt-in scoped maintenance loop of this module's Outbox Worker
 * entry: only a host that opted in to the realm AND named the relay credential composes it, and it relays only while the
 * approved `commerce.customer-context` release is this build and the realm has a trusted Tenant. The store, the transport and
 * the composition answer are doubles; every value is FICTIONAL.
 */

const TENANT = '7e000000-0000-4000-8000-0000000000e1';
const ISSUED_AT = DateTime.makeUnsafe('2026-11-22T10:00:00.000Z');

const issuance = (name: string): PortalAuthIssuance => ({
  expiresAt: DateTime.add(ISSUED_AT, { minutes: 30 }),
  flow: 'verify-email',
  issuanceRef: Schema.decodeSync(PortalAuthIssuanceRefSchema)(name),
  issuedAt: ISSUED_AT,
  providerSubjectId: 'subject-relay-driver',
});

/** One log line the loop wrote: its message and the two annotations a refusal carries. */
interface LoggedLine {
  readonly failure: unknown;
  readonly message: unknown;
  readonly reason: unknown;
}

/** One committed row of the Tenant, and the loop run for two intervals over the given admission and trusted scope. */
const runLoop = Effect.fn('PortalAuthRelayDriverTest.run')(function* runLoop(
  admitted: Effect.Effect<boolean>,
  trustedScope: Layer.Layer<CommercePortalAuthTrustedScope>,
  logged: LoggedLine[] = [],
) {
  yield* TestClock.setTime(ISSUED_AT.epochMilliseconds);
  const store = makeCommunicationStoreDouble();
  yield* store.service.record({
    issuance: issuance('pa-driver-1'),
    now: ISSUED_AT,
    request: yield* storedRequestOf(
      yield* portalAuthCommunicationRequest(issuance('pa-driver-1'), { tenantId: TENANT }),
    ),
    sealedValue: 'v1.sealed',
    supersede: false,
    tenantId: TENANT,
  });
  const submitted: string[] = [];
  yield* Effect.scoped(
    Effect.gen(function* running() {
      yield* Layer.build(
        makePortalAuthCommunicationRelayLive(admitted).pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(CommercePortalAuthCommunicationStore, store.service),
              Layer.succeed(CommercePortalAuthCommunicationRequestSubmitter, {
                submit: (sent) => {
                  submitted.push(sent.occurrence.occurrenceId);
                  return Effect.succeed({ outcome: 'RELAYED' } as const);
                },
              }),
              trustedScope,
              NodeCrypto.layer,
            ),
          ),
        ),
      );
      yield* TestClock.adjust('2 seconds');
    }),
  ).pipe(
    Effect.provide(
      Logger.layer([
        Logger.make(({ fiber, message }) => {
          const { failure, reason } = fiber.getRef(References.CurrentLogAnnotations);
          logged.push({ failure, message, reason });
        }),
      ]),
    ),
  );
  return { row: (yield* Ref.get(store.outbox)).get('pa-driver-1'), submitted };
});

/** A composition that approves `moduleId` at `buildMarker` of this deployment. */
const approved = (moduleId: string, buildMarker: string) => ({
  composition: { modules: [{ deployment: { appId: ultramodernApiMarker.appId, buildMarker }, moduleId }] },
});

const trustedTenant = Layer.succeed(CommercePortalAuthTrustedScope, { current: Effect.succeed({ tenantId: TENANT }) });

describe('The Portal Auth relay as the worker entry maintenance loop (#1406 D1)', () => {
  it('is composed only for a host that opted in to the realm and named the relay credential', () => {
    expect(portalAuthCommunicationRelayAdopted({ realmConfigured: true, relayCredentialNamed: true })).toBe(true);
    for (const adoption of [
      { realmConfigured: false, relayCredentialNamed: false },
      { realmConfigured: true, relayCredentialNamed: false },
      { realmConfigured: false, relayCredentialNamed: true },
    ]) {
      // the worker entry composes nothing then: no loop, no Auth pool, no other hosted loop changed
      expect(portalAuthCommunicationRelayAdopted(adoption), JSON.stringify(adoption)).toBe(false);
    }
  });

  it('admits only the approved commerce.customer-context release of this very build', () => {
    expect(
      relayReleaseApproved(
        ultramodernApiMarker,
        approved('commerce.customer-context', ultramodernApiMarker.buildMarker),
      ),
    ).toBe(true);
    expect(relayReleaseApproved(ultramodernApiMarker, approved('commerce.customer-context', 'another-build'))).toBe(
      false,
    );
    expect(
      relayReleaseApproved(ultramodernApiMarker, approved('communications.core', ultramodernApiMarker.buildMarker)),
    ).toBe(false);
    expect(relayReleaseApproved(ultramodernApiMarker, { composition: { modules: [] } })).toBe(false);
  });

  it.effect('relays a committed row of the trusted Tenant while this release is approved', () =>
    Effect.gen(function* approvedRelease() {
      const { row, submitted } = yield* runLoop(Effect.succeed(true), trustedTenant);
      expect(submitted).toStrictEqual(['pa-driver-1']);
      expect(row?.state).toBe('RELAYED');
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect('relays nothing while the approved release is another build, and the row stays due', () =>
    Effect.gen(function* refusedRelease() {
      const { row, submitted } = yield* runLoop(Effect.succeed(false), trustedTenant);
      expect(submitted).toStrictEqual([]);
      expect(row?.state).toBe('PENDING');
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect('relays nothing without a trusted Tenant', () =>
    Effect.gen(function* unconfiguredScope() {
      const { row, submitted } = yield* runLoop(Effect.succeed(true), unconfiguredTrustedScopeLayer);
      expect(submitted).toStrictEqual([]);
      expect(row?.state).toBe('PENDING');
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect('reports a realm without a usable trusted Tenant once, as a typed, value-free configuration error', () =>
    Effect.gen(function* reportedScope() {
      const logged: LoggedLine[] = [];
      yield* runLoop(Effect.succeed(true), unconfiguredTrustedScopeLayer, logged);
      const reported = logged.filter(({ failure }) => failure === 'PortalAuthTrustedScopeUnavailable');
      // three ticks ran (t = 0, 1 s, 2 s), the unchanged refusal is reported once
      expect(reported).toStrictEqual([
        {
          failure: 'PortalAuthTrustedScopeUnavailable',
          message: ['The Portal Auth realm has no usable trusted Tenant; nothing is relayed'],
          reason: 'NOT_CONFIGURED',
        },
      ]);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

/** The realm's trusted scope as the configured layer reads it from the given deployment environment. */
const currentUnder = (environment: Record<string, string>) =>
  CommercePortalAuthTrustedScope.pipe(
    Effect.flatMap(({ current }) => Effect.exit(current)),
    Effect.provide(
      configuredTrustedScopeLayer.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(environment)))),
    ),
  );

describe('The trusted Tenant of the Portal Auth realm comes from reviewed deployment configuration (#1406)', () => {
  it.effect(
    'names the Tenant only from a configured Tenant id, failing closed when it is unset, blank or malformed',
    () =>
      Effect.gen(function* configuredValues() {
        expect(yield* trustedScopeOfConfiguredTenant(Option.some(` ${TENANT} `))).toStrictEqual({ tenantId: TENANT });
        for (const [configured, reason] of [
          [Option.none(), 'NOT_CONFIGURED'],
          [Option.some(''), 'NOT_CONFIGURED'],
          [Option.some('   '), 'NOT_CONFIGURED'],
          [Option.some('tenant.example'), 'INVALID'],
          [Option.some(`${TENANT},${TENANT}`), 'INVALID'],
        ] as const) {
          const exit = yield* Effect.exit(trustedScopeOfConfiguredTenant(configured));
          expect(exit).toStrictEqual(Exit.fail(new PortalAuthTrustedScopeUnavailable({ reason })));
        }
      }),
  );

  it.effect('reads COMMERCE_PORTAL_AUTH_TRUSTED_TENANT_ID from the deployment and nothing a request could carry', () =>
    Effect.gen(function* fromDeployment() {
      expect(yield* currentUnder({ COMMERCE_PORTAL_AUTH_TRUSTED_TENANT_ID: TENANT })).toStrictEqual(
        Exit.succeed({ tenantId: TENANT }),
      );
      // a host, origin or forwarded header is never a Tenant source
      expect(
        yield* currentUnder({ COMMERCE_PORTAL_AUTH_URL: 'https://portal.example', HOST: 'portal.example' }),
      ).toStrictEqual(Exit.fail(new PortalAuthTrustedScopeUnavailable({ reason: 'NOT_CONFIGURED' })));
      expect(yield* currentUnder({ COMMERCE_PORTAL_AUTH_TRUSTED_TENANT_ID: 'portal.example' })).toStrictEqual(
        Exit.fail(new PortalAuthTrustedScopeUnavailable({ reason: 'INVALID' })),
      );
    }),
  );

  it.effect('relays the committed row of the configured Tenant through the configured scope', () =>
    Effect.gen(function* configuredRelay() {
      const { row, submitted } = yield* runLoop(
        Effect.succeed(true),
        configuredTrustedScopeLayer.pipe(
          Layer.provide(
            ConfigProvider.layer(ConfigProvider.fromUnknown({ COMMERCE_PORTAL_AUTH_TRUSTED_TENANT_ID: TENANT })),
          ),
        ),
      );
      expect(submitted).toStrictEqual(['pa-driver-1']);
      expect(row?.state).toBe('RELAYED');
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
