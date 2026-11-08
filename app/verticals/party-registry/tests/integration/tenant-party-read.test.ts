import {
  loadDatabaseIdentityConnections,
  makeActiveApplicationCompositionLayer,
  SHELL_GATEWAY_ISSUER_IDENTITY,
  ReadRuntime,
  runAction,
  TrustedPrincipalContextSchema,
} from '@app/core-runtime';
import {
  PARTY_REGISTRY_DATABASE_IDENTITY_ENROLLMENT,
  PARTY_REGISTRY_REQUEST_IDENTITY,
} from '@app/party-registry-identity-contracts';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { makeGatewayScopeGrantRegistrar, makeLiveOperationFixture } from '@app/core-runtime/testing/actions';
import { makePartyDeniedAccess } from '../support/live-access-authority.ts';
import { addTestGatewayScopeGrantCleanup } from '@app/core-runtime/testing/gateway-scope-grant';
import { deleteTestCoreOutbox } from '@app/core-runtime/testing/owner-evidence';
import { bindGatewayPrincipalVerifier } from '@app/gateway-principal-verifier/server';
import { EXTERNAL_GATEWAY_ASSERTION_VERSION, GATEWAY_ASSERTION_TTL_SECONDS } from '@app/shared-contracts';
import { NodeCrypto } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { Context, Crypto, Effect, Layer, Predicate, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { assert, expect, it } from 'effect-rstest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

import { createPartyAction } from '../../src/actions/create-party.action.ts';
import { partyDetailRead } from '../../src/api/party-detail.read.ts';
import { counterpartyReadRead } from '../../src/api/counterparty-read.read.ts';
import { makeGatewayAssertionRedemption } from '../../src/auth/gateway-assertion-redemption-runtime.ts';
import { makePartyDatabase } from '../../src/db/client.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { partyRegistryBackendRegistration } from '../../vertical.runtime-declaration.ts';
import { partyCompositionSnapshot } from './application-composition.setup.ts';

it.layer(NodeCrypto.layer, { excludeTestServices: true })((suite) => {
  suite.effect(
    'tenant Party detail checks independent native tenant and module grants without selected Legal Entity',
    () =>
      Effect.gen(function* tenantPartyRead() {
        const connections = yield* loadDatabaseIdentityConnections({
          enrollment: PARTY_REGISTRY_DATABASE_IDENTITY_ENROLLMENT,
          envPath: '/dev/null',
        });
        const snapshot = yield* partyCompositionSnapshot;
        const partyConfiguration = connections.runtime[PARTY_REGISTRY_REQUEST_IDENTITY.id];
        const issuerConfiguration = connections.runtime[SHELL_GATEWAY_ISSUER_IDENTITY.id];
        assert.isOk(partyConfiguration !== undefined && issuerConfiguration !== undefined);
        const issuerContext = yield* Layer.build(
          PgClient.layer({
            maxConnections: 1,
            url: Redacted.make(issuerConfiguration.connectionString),
          }).pipe(Layer.provideMerge(Reactivity.layer)),
        );
        const adminContext = yield* Layer.build(
          PgClient.layer({ maxConnections: 1, url: Redacted.make(connections.admin.connectionString) }).pipe(
            Layer.provideMerge(Reactivity.layer),
          ),
        );
        const fixture = yield* Effect.acquireRelease(
          makeLiveOperationFixture({
            databaseIdentities: PARTY_REGISTRY_DATABASE_IDENTITY_ENROLLMENT,
            // Every declaration this suite reads is granted except the Party identity *field class*
            // (O58): the suite proves the record read stays allowed while the runtime projects the
            // identity fields the caller may not read out of the response (O17).
            access: {
              'party.registry.counterparty.read': 'allowed',
              'party.registry.party.create': 'allowed',
              'party.registry.party.read': 'allowed',
              'party.registry.party-identity.read': 'denied',
            },
            actionKeys: [createPartyAction.descriptor.actionKey],
            adminConnectionString: Redacted.make(connections.admin.connectionString),
            authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
            compositionRevision: snapshot.composition.revision,
            ownerRegistration: partyRegistryBackendRegistration,
            runtimeConnectionString: Redacted.make(partyConfiguration.connectionString),
          }),
          (resource) => resource.close().pipe(Effect.orDie),
        );
        const adminClient = Context.get(adminContext, PgClient.PgClient);
        yield* Effect.addFinalizer(() => deleteTestCoreOutbox(adminClient, fixture.tenantId).pipe(Effect.orDie));
        yield* addTestGatewayScopeGrantCleanup(adminClient, [fixture.tenantId]);
        const partyDatabase = yield* makePartyDatabase(partyConfiguration);
        const redemption = makeGatewayAssertionRedemption(partyDatabase.executor);
        const registrar = makeGatewayScopeGrantRegistrar(
          Context.get(issuerContext, PgClient.PgClient),
          PARTY_REGISTRY_DATABASE_IDENTITY_ENROLLMENT,
        );
        const compositionContext = yield* Layer.build(makeActiveApplicationCompositionLayer(Effect.succeed(snapshot)));
        const pair = yield* Effect.tryPromise(() => generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true }));
        const publicJwk = yield* Effect.tryPromise(() => exportJWK(pair.publicKey));
        const issuer = 'https://tenant-party-native.ontos.test';
        const keyId = 'tenant-party-native';
        const verifier = bindGatewayPrincipalVerifier('party-registry', ultramodernApiMarker);
        const deniedAccess = makePartyDeniedAccess();
        const context = yield* Layer.build(fixture.layer.pipe(Layer.provide(deniedAccess.layer)));
        const runtime = yield* ReadRuntime.pipe(Effect.provideContext(context));
        const crypto = yield* Crypto.Crypto;
        const principal = yield* Schema.decodeEffect(TrustedPrincipalContextSchema)(fixture.manager);
        // Only the real verifier may attach the registered assertion's private database-scope provenance.
        const verifyPrincipal = Effect.fn('TenantPartyReadTest.verifyPrincipal')(function* verifyPrincipal(
          actor: typeof principal,
        ) {
          const [databaseClock] = yield* Context.get(issuerContext, PgClient.PgClient)<{
            readonly nowSeconds: number;
          }>`select floor(extract(epoch from clock_timestamp()))::int as "nowSeconds"`;
          const issuedAt = yield* Schema.decodeUnknownEffect(Schema.Number)(databaseClock?.nowSeconds);
          const expiresAt = issuedAt + GATEWAY_ASSERTION_TTL_SECONDS;
          const jti = yield* crypto.randomUUIDv4();
          const encoded = yield* Schema.encodeEffect(TrustedPrincipalContextSchema)(actor);
          const assertion = Redacted.make(
            yield* Effect.tryPromise(() =>
              new SignJWT({
                compositionRevision: snapshot.composition.revision,
                principal: encoded,
                targetBuildMarker: ultramodernApiMarker.buildMarker,
                ver: EXTERNAL_GATEWAY_ASSERTION_VERSION,
              })
                .setProtectedHeader({ alg: 'EdDSA', kid: keyId, typ: 'JWT' })
                .setIssuer(issuer)
                .setAudience('party-registry')
                .setSubject(actor.principalId)
                .setIssuedAt(issuedAt)
                .setExpirationTime(expiresAt)
                .setJti(jti)
                .sign(pair.privateKey),
            ),
          );
          const registration = {
            assertion,
            audience: 'party-registry',
            expiresAtEpochSeconds: expiresAt,
            jti,
            principalId: actor.principalId,
            tenantId: actor.tenantId,
          };
          yield* registrar.register(
            actor.legalEntityId === undefined ? registration : { ...registration, legalEntityId: actor.legalEntityId },
          );
          const verified = yield* verifier
            .verifyAndRedeem(Redacted.make(`Bearer ${Redacted.value(assertion)}`), {
              environment: {
                ONTOS_GATEWAY_ISSUER: issuer,
                ONTOS_GATEWAY_PUBLIC_JWKS: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
                  keys: [{ ...publicJwk, alg: 'EdDSA', kid: keyId, use: 'sig' }],
                }),
              },
              redemption,
            })
            .pipe(Effect.provideContext(compositionContext));
          expect(verified.principalId).toBe(actor.principalId);
          expect(verified.tenantId).toBe(actor.tenantId);
          expect(verified.legalEntityId).toBe(actor.legalEntityId);
          return verified;
        });
        const opened = yield* runAction({
          registration: createPartyAction,
          payload: {
            candidate: {
              partyType: 'ORGANIZATION',
              businessName: 'Tenant Party proof',
              officialIdentifiers: [{ identifierType: 'ICO', value: '27074358' }],
              subjectEvidence: [
                {
                  kind: 'ACTOR_ATTESTATION',
                  basis: 'REVIEWED_DOCUMENT',
                  evidenceRef: 'review/tenant-party',
                  observedSubject: 'ORGANIZATION',
                  subjectKey: yield* crypto.randomUUIDv4(),
                  statement: 'Reviewed the concrete external organization',
                },
              ],
              evidenceRefs: ['review/tenant-party'],
              provenance: { method: 'DOCUMENT', source: 'tenant-party-native' },
              validFrom: '2020-01-01T00:00:00.000Z',
            },
          },
          principal: yield* verifyPrincipal(principal),
          transport: {
            correlationId: yield* crypto.randomUUIDv4(),
            idempotencyKey: yield* crypto.randomUUIDv4(),
            targetModuleKey: 'party.registry',
          },
        }).pipe(Effect.provideContext(context));
        expect(opened.outcome).toBe('CREATED');
        if (opened.outcome !== 'CREATED') {
          return yield* Effect.die('Expected a newly created Party after NO_MATCH');
        }
        const { partyRef } = opened;
        const read = (reader: typeof principal, includeFactHistory = false) =>
          verifyPrincipal(reader).pipe(
            Effect.flatMap((verified) =>
              runtime.runRead({
                registration: partyDetailRead,
                input: { partyRef, includeFactHistory },
                principal: verified,
                transport: { correlationId: 'tenant-party-native' },
              }),
            ),
            Effect.provideContext(context),
          );
        // v2: the one access gate decides this read (O62). The fixture scripts its gate per
        // capability, so the principals this suite refuses are named on the fixture's own
        // per-request owner seam (the removed SpiceDB module/tenant tuples no longer refuse anyone).
        const denied = yield* Schema.decodeEffect(TrustedPrincipalContextSchema)(fixture.denied);
        const legalEntityOnly = yield* Schema.decodeEffect(TrustedPrincipalContextSchema)(fixture.legalEntityOnly);
        deniedAccess.deny(denied.principalId, 'party.registry.party.read');
        deniedAccess.deny(legalEntityOnly.principalId, 'party.registry.party.read');
        const detail = yield* read(principal);
        expect(detail.party.partyRef).toEqual(partyRef);
        expect(principal.legalEntityId).toBeUndefined();
        const history = yield* read(principal, true);
        expect(history.party.partyRef).toEqual(partyRef);
        const ordinaryReader = yield* Schema.decodeEffect(TrustedPrincipalContextSchema)(fixture.reader);
        expect((yield* read(ordinaryReader)).party.partyRef).toEqual(partyRef);
        // The record read stays allowed while its identity field class is refused: the name and the
        // governed fact values are projected out, and every ungoverned part of the same payload is
        // still there (O17, O58). A read that returned the name would leak what the class governs.
        expect(detail.party.partyRef).toEqual(partyRef);
        for (const name of ['businessName', 'displayName', 'firstName', 'lastName'] as const) {
          expect(detail.party[name]).toBeUndefined();
        }
        // The field group governs `currentFactAssertions.value` for every fact kind, so the PARTY_TYPE
        // and BUSINESS_NAME assertions both stay while neither carries its value.
        expect(detail.currentFactAssertions.map(({ factKind }) => factKind).toSorted()).toEqual([
          'BUSINESS_NAME',
          'PARTY_TYPE',
        ]);
        expect(
          detail.currentFactAssertions.every(
            (assertion) => assertion.assertionId !== undefined && !('value' in assertion),
          ),
        ).toBe(true);
        expect(detail.resolution.canonicalPartyRef).toEqual(partyRef);
        expect(Predicate.isTagged(yield* Effect.flip(read(denied)), 'ReadPermissionDenied')).toBe(true);
        expect(Predicate.isTagged(yield* Effect.flip(read(legalEntityOnly)), 'ReadPermissionDenied')).toBe(true);
        // The record-scoped Counterparty read is its own capability (O62). This manager holds the
        // Party-detail capability but no Counterparty authority, so the gate refuses it before the
        // owner handler runs.
        const readCounterparty = (correlationId: string) =>
          verifyPrincipal(principal).pipe(
            Effect.flatMap((verified) =>
              runtime.runRead({
                registration: counterpartyReadRead,
                input: {
                  counterpartyRef: {
                    moduleId: 'party.registry',
                    resourceType: 'party.registry.counterparty',
                    resourceId: partyRef.resourceId,
                    tenantId: fixture.tenantId,
                  },
                },
                principal: verified,
                transport: { correlationId },
              }),
            ),
            Effect.provideContext(context),
          );
        deniedAccess.deny(principal.principalId, 'party.registry.counterparty.read');
        const counterparty = yield* Effect.flip(readCounterparty('tenant-counterparty-denied'));
        expect(Predicate.isTagged(counterparty, 'ReadPermissionDenied')).toBe(true);
        // The other half of the same seam: an *indeterminate* authorization answer is a retryable 503,
        // never a 403 and never an allow (O48b). Refusing to distinguish them would hide an unreadable
        // authority as a decided refusal.
        deniedAccess.allow(principal.principalId, 'party.registry.counterparty.read');
        deniedAccess.unavailable(principal.principalId, 'party.registry.counterparty.read');
        const indeterminate = yield* Effect.flip(readCounterparty('tenant-counterparty-unavailable'));
        expect(Predicate.isTagged(indeterminate, 'ReadPermissionUnavailable')).toBe(true);
        expect(Predicate.isTagged(indeterminate, 'ReadPermissionDenied')).toBe(false);
        // Negative control: lifting the indeterminate answer restores the decided refusal, so the case
        // above is caused by the answer and not by the fixture's own fail-closed owner rule.
        deniedAccess.deny(principal.principalId, 'party.registry.counterparty.read');
        expect(
          Predicate.isTagged(
            yield* Effect.flip(readCounterparty('tenant-counterparty-denied-again')),
            'ReadPermissionDenied',
          ),
        ).toBe(true);
      }),
  );
});
