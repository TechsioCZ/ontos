import { defineVerticalRuntimeRegistration } from '../../src/modules/runtime-registration.ts';
import { makeModuleContractFixture } from '../../src/testing/module-contract.ts';
import {
  failClosedOwnerAuthorizationOverlay,
  OwnerAuthorizationOverlay,
} from '../../src/permissions/owner-authorization-overlay.ts';
import { Effect, Layer, Redacted, Schema } from 'effect';
import { NodeCrypto } from '@effect/platform-node';
import { expect, it } from 'effect-rstest';

import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import {
  STAFF_AUTHENTICATION_NAMESPACE_ID,
  staffAuthenticationNamespaceRegistryLayer,
} from '../../src/auth/staff-authentication-namespace.ts';
import { trustVerifiedGatewayPrincipalContext } from '../../src/auth/system-principal-context-provenance.ts';
import { defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import { makeNativeReadTestContext, withVerifiedNativeReadScope } from '../../src/testing/native-reads.ts';

// Deliberately misleading metadata: the fixture must reparse the actual URLs.
const connections = (admin: string, runtime: string) => ({
  admin: {
    connectionString: Redacted.make(admin),
    database: 'ontos_test_party_gateway_fake',
    host: 'localhost',
    port: 5432,
    user: 'admin',
  },
  runtime: {
    connectionString: Redacted.make(runtime),
    database: 'ontos_test_party_gateway_fake',
    host: 'localhost',
    port: 5432,
    user: 'runtime',
  },
});

it.effect('rejects remote, mismatched and non-isolated fixture URLs before database or authorization I/O', () =>
  Effect.scoped(
    Effect.gen(function* rejectsUnsafeFixtureConnections() {
      const context = yield* Layer.build(NodeCrypto.layer);
      const safe = 'postgres://admin:unit@localhost:5432/ontos_test_party_gateway_unit';
      for (const pair of [
        connections('postgres://admin:unit@localhost:5432/current', 'postgres://runtime:unit@localhost:5432/current'),
        connections(
          'postgres://admin:unit@remote.invalid:5432/ontos_test_party_gateway_unit',
          'postgres://runtime:unit@remote.invalid:5432/ontos_test_party_gateway_unit',
        ),
        connections(safe, 'postgres://runtime:unit@127.0.0.1:5432/ontos_test_party_gateway_unit'),
        connections(safe, 'postgres://runtime:unit@localhost:5433/ontos_test_party_gateway_unit'),
        connections(safe, 'postgres://runtime:unit@localhost:5432/ontos_test_party_gateway_other'),
        ...[
          'host=remote.invalid',
          'host=%2Ftmp%2Fsocket',
          'port=5433',
          'user=postgres',
          'password=override',
          'database=current',
          'service=external',
          'options=-csearch_path%3Dpublic',
          '%68ost=remote.invalid',
          'sslmode=require',
          'sslcert=%2Ftmp%2Fnever-read-fixture.pem',
        ].flatMap((query) => [
          connections(`${safe}?${query}`, 'postgres://runtime:unit@localhost:5432/ontos_test_party_gateway_unit'),
          connections(safe, `postgres://runtime:unit@localhost:5432/ontos_test_party_gateway_unit?${query}`),
        ]),
      ]) {
        const error = yield* Effect.flip(
          Effect.scoped(
            makeNativeReadTestContext({
              connections: pair,
              contextPermissions: [],
              moduleId: 'privacy.core',
              ownerFixtureRetention: 'retain-complete-context',
            }).pipe(Effect.provideContext(context)),
          ),
        );
        expect(error).toMatchObject({
          code: 'native_read_test_failed',
          reason: 'Native Read fixture overrides require one isolated localhost database',
        });
      }
    }),
  ),
);

it.effect('reparses administrative identity instead of trusting supplied connection metadata', () =>
  Effect.scoped(
    Effect.gen(function* rejectsAdministrativeRuntimeIdentity() {
      const context = yield* Layer.build(NodeCrypto.layer);
      const error = yield* Effect.flip(
        Effect.scoped(
          makeNativeReadTestContext({
            connections: connections(
              'postgres://same:unit@localhost:5432/ontos_test_party_gateway_unit',
              'postgres://same:other@localhost:5432/ontos_test_party_gateway_unit',
            ),
            contextPermissions: [],
            moduleId: 'privacy.core',
            ownerFixtureRetention: 'retain-complete-context',
          }).pipe(Effect.provideContext(context)),
        ),
      );
      expect(error).toMatchObject({
        code: 'native_read_test_failed',
        reason: 'Native Read isolated database configuration failed',
      });
    }),
  ),
);

it.effect(
  'rejects unverified, copied, assertionless and cross-audience principals before native scope or callback I/O',
  () =>
    Effect.scoped(
      Effect.gen(function* rejectInvalidVerifiedNativeAdmission() {
        const context = yield* Layer.build(
          Layer.merge(NodeCrypto.layer, staffAuthenticationNamespaceRegistryLayer(['commerce-customer-context'])),
        );
        const principal = yield* Schema.decodeEffect(TrustedPrincipalContextSchema)({
          authBindingId: '10000000-0000-4000-8000-000000000001',
          authContextRef: 'better-auth-api-key:native-read-rejected-unit',
          authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
          authMethod: 'api_key',
          legalEntityId: '20000000-0000-4000-8000-000000000002',
          principalId: '30000000-0000-4000-8000-000000000003',
          tenantId: '40000000-0000-4000-8000-000000000004',
        });
        const entrypoint = defineTenantModuleEntrypoint({
          access: 'read',
          authorization: { kind: 'context_permission', permission: 'module.access' },
          entrypointKey: 'commerce.customer-context.api.invoice-recipient-resolution',
          moduleKey: 'commerce.customer-context',
          role: 'api',
        });
        // Core seals are used only to form rejected controls; no marked unit context is admitted to SQL.
        const sealed = trustVerifiedGatewayPrincipalContext(principal, 'a'.repeat(64), {
          assertion: Redacted.make('rejected-unit-assertion'),
          audience: 'commerce-customer-context',
        });
        let callbackCalls = 0;
        const rejectedCallback = () => {
          callbackCalls += 1;
          return Effect.succeed('must-not-run');
        };
        for (const rejectedPrincipal of [
          principal,
          { ...sealed },
          trustVerifiedGatewayPrincipalContext(principal, 'a'.repeat(64)),
          trustVerifiedGatewayPrincipalContext(principal, 'a'.repeat(64), {
            assertion: Redacted.make('rejected-cross-audience-assertion'),
            audience: 'party-registry',
          }),
        ]) {
          const failure = yield* withVerifiedNativeReadScope(
            {
              audience: 'commerce-customer-context',
              correlationId: 'verified-native-rejected',
              entrypoint,
              principal: rejectedPrincipal,
            },

            rejectedCallback,
          ).pipe(Effect.provideContext(context), Effect.flip);
          expect(failure).toMatchObject({
            code: 'native_read_test_failed',
            reason: 'A genuine redeemed Staff gateway principal and Tenant Read are required',
          });
        }
        expect(callbackCalls).toBe(0);
      }),
    ),
);

it.effect('requires exact owner registration and an installed overlay before native owner fixture I/O', () =>
  Effect.scoped(
    Effect.gen(function* rejectsUnboundNativeOwner() {
      const context = yield* Layer.build(NodeCrypto.layer);
      // Synthetic metadata is confined to this infrastructure rejection probe; it is never published or run natively.
      const fixture = makeModuleContractFixture({
        appId: 'native-owner-guard',
        moduleId: 'fixture.native-owner-guard',
      });
      const ownerRuntime = {
        expectedDeployment: fixture.deployment,
        ownerRegistration: defineVerticalRuntimeRegistration({
          actions: [],
          manifest: { ...fixture.manifest, publicSurface: { ...fixture.manifest.publicSurface, api: {} } },
          outboxWorkers: [],
        }),
      };
      const request = {
        contextPermissions: [],
        expectedDeployment: ownerRuntime.expectedDeployment,
        moduleId: ownerRuntime.ownerRegistration.moduleId,
        ownerFixtureRetention: 'retain-complete-context' as const,
      };
      const missingOverlay = yield* Effect.flip(
        makeNativeReadTestContext(request, ownerRuntime.ownerRegistration).pipe(Effect.provideContext(context)),
      );
      expect(missingOverlay.reason).toBe(
        'Native owner runtime requires its exact owner registration, installed Composition and authorization overlay',
      );
      const wrongOwner = yield* Effect.flip(
        makeNativeReadTestContext({ ...request, moduleId: 'fixture.foreign' }, ownerRuntime.ownerRegistration).pipe(
          Effect.provideService(OwnerAuthorizationOverlay, failClosedOwnerAuthorizationOverlay),
          Effect.provideContext(context),
        ),
      );
      expect(wrongOwner.reason).toBe(missingOverlay.reason);
    }),
  ),
);
