import { GatewayScopeGrantRegistrar } from '@app/core-runtime';
import { makeModuleContractFixture } from '@app/core-runtime/testing/module-contract';
import { GatewayActorClaimSchema } from '@app/shared-contracts';
import { Clock, Config, Effect, Layer, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { makeShellAuthenticationApiRuntime } from '../../api/index.ts';
import { GatewayIssuer, makeGatewayIssuerLayer } from '../../api/auth/gateway-issuer.ts';
import { parseGatewayIssuerConfig } from '../../api/auth/gateway-issuer-config.ts';
import { shellAuthenticationApiContract } from '../../shared/browser-api.ts';
import { ultramodernDeliveryUnit } from '../../shared/ultramodern-build.ts';
import { makeActionRepository } from '../../../../packages/core-runtime/src/actions/repository.ts';
import { makeActionRuntime } from '../../../../packages/core-runtime/src/actions/runtime.ts';
import { makeReadRuntime } from '../../../../packages/core-runtime/src/reads/runtime.ts';
import { makeCompositionSnapshot } from '../fixtures/application-composition.ts';
import { templateDatabaseLayer } from '../support/access-admin-real-gate-fixture.ts';
import { MEDIA_CAPABILITIES, principalOf, withMediaE2eWorld } from '../support/core-media-e2e-fixture.ts';
import type { E2eActor, MediaE2eWorld } from '../support/core-media-e2e-fixture.ts';
import {
  bytesOf,
  parseJson,
  putBytes,
  refOf,
  requireFaultInjection,
  reserve,
  textOf,
} from '../support/core-media-e2e-steps.ts';

/*
 * EVIDENCE: INTEGRATION EXECUTED (#1446 row 7, the Shell receiver of the Catalog Current handoff). The assertion is a
 * REAL one: signed by the real Shell issuer (`makeGatewayIssuerLayer`) for the Shell audience on behalf of the requester,
 * with a key pair generated for this run, and accepted only by the real verifier of the production Shell, which also
 * redeems it once in PostgreSQL. The receiver then runs `core.media.asset-current.read` as the REQUESTER over the real
 * gate, SpiceDB and the real S3 adapter on an S3-compatible EMULATOR (MinIO, NOT R2).
 *
 * NOT exercised here (NOT VERIFIED): Catalog's own assignments, its read runtime and the SDK module call route that
 * would carry this request from the Catalog Worker. The module is represented by its `act` claim and by the installed
 * contract that declares the hosted requirement; the Catalog deployment itself does not run in this world.
 */

const platform = {
  makeActionRepository,
  makeActionRuntime,
  makeCompositionSnapshot,
  makeReadRuntime,
  makeShellAuthenticationApiRuntime,
};

const { apiPrefix } = shellAuthenticationApiContract;
const CATALOG_BUILD = 'catalog-build';
const moduleActor = Schema.decodeUnknownSync(GatewayActorClaimSchema)({
  appId: 'catalog',
  buildMarker: CATALOG_BUILD,
  principalId: '60000000-0000-4000-8000-000000000001',
});

const hostedRequirement = {
  callers: [{ kind: 'person', legalEntityScope: 'subject' }],
  condition: 'commerce.catalog.condition.core-media-current',
  entrypointKey: 'commerce.catalog.api.catalog-document-current',
  evidence: ['core.media.asset'],
  key: 'commerce.catalog.requirement.core-media-current',
  provider: { entrypointKey: 'core.media.api.asset-current', moduleId: 'core.media', schemaVersion: '1' },
};
const catalogContract = () => {
  const catalog = makeModuleContractFixture({ appId: 'catalog', moduleId: 'commerce.catalog' });
  return {
    ...catalog,
    manifest: {
      ...catalog.manifest,
      requirements: { coreCapabilities: [], intrinsic: [], operations: [hostedRequirement], schemaVersion: '1' },
    },
  };
};

const uploaderCapabilities = [MEDIA_CAPABILITIES.upload, MEDIA_CAPABILITIES.confirm];

const person = (world: MediaE2eWorld, name: string): E2eActor => {
  const actor = world.people.get(name);
  if (actor === undefined) {
    throw new Error(`The world has no ${name}`);
  }
  return actor;
};

const noScopeGrants = Layer.succeed(GatewayScopeGrantRegistrar, { register: () => Effect.void });

/** One assertion signed by the real issuer for the audience, on behalf of the requester, relayed by the module. */
const issueFor = (world: MediaE2eWorld, requester: E2eActor, audience: string, relayed = true) =>
  Effect.gen(function* issueAssertion() {
    const privateJwk = yield* Config.Redacted('D20_E2E_GATEWAY_PRIVATE_JWK');
    const issuerName = yield* Config.String('ONTOS_GATEWAY_ISSUER');
    const configuration = yield* parseGatewayIssuerConfig({
      ONTOS_GATEWAY_ISSUER: issuerName,
      ONTOS_GATEWAY_PRIVATE_JWK: Redacted.value(privateJwk),
    });
    const principal = yield* principalOf(requester);
    const clock = yield* Clock.Clock;
    const issuerLayer = makeGatewayIssuerLayer({
      currentTimeSeconds: clock.currentTimeMillis.pipe(Effect.map((milliseconds) => Math.floor(milliseconds / 1000))),
      generateJti: Effect.sync(() => globalThis.crypto.randomUUID()),
      loadAdmission: Effect.succeed({
        audiences: new Map([
          ['catalog', CATALOG_BUILD],
          ['shell-super-app', ultramodernDeliveryUnit.buildMarker],
        ]),
        revision: world.compositionRevision,
      }),
      loadConfig: Effect.succeed(configuration),
    }).pipe(Layer.provide(noScopeGrants));
    const issued = yield* Effect.gen(function* issueWithIssuer() {
      const issuer = yield* GatewayIssuer;
      return yield* issuer.issue(
        relayed
          ? { actor: moduleActor, audience, compositionRevision: world.compositionRevision, principal }
          : { audience, compositionRevision: world.compositionRevision, principal },
      );
    }).pipe(Effect.provide(issuerLayer));
    return issued.token;
  }).pipe(Effect.orDie);

const postCurrent = (world: MediaE2eWorld, origin: string, token: string | undefined, ids: readonly string[]) =>
  Effect.promise(async () => {
    const headers = new Headers({ 'content-type': 'application/json', 'x-correlation-id': 'e2e-hosted-current' });
    if (token !== undefined) {
      headers.set('authorization', `Bearer ${token}`);
    }
    const response = await fetch(`${origin}${apiPrefix}/core/operations/asset-current`, {
      body: JSON.stringify({ mediaAssetRefs: ids.map((id) => refOf(world.tenantId, id)) }),
      headers,
      method: 'POST',
    });
    return { bytes: new Uint8Array(await response.arrayBuffer()), status: response.status };
  });

it.layer(templateDatabaseLayer, { excludeTestServices: true, timeout: '600 seconds' })(
  'Core Media end to end: the Shell receiver of the Catalog Current handoff (row 7)',
  (suite) => {
    suite.effect(
      'a module relays its requester with a real assertion: Core answers Current V1 for the exact refs, and a refusal, a replay, a wrong audience and a direct person assertion never answer (CONTROLLED FAULT INJECTION: provider unreachable for one request)',
      (ctx) =>
        withMediaE2eWorld(
          ctx,
          platform,
          (world) =>
            Effect.scoped(
              Effect.gen(function* hostedCurrent() {
                const { faults } = yield* requireFaultInjection(ctx, world);
                const uploader = person(world, 'uploader');
                const asker = person(world, 'currentOnly');
                const outsider = person(world, 'outsider');
                yield* world.grant(uploader, uploaderCapabilities);
                yield* world.grant(asker, [MEDIA_CAPABILITIES.current]);
                const edge = yield* world.shell;
                const bytes = bytesOf('the file Catalog assigned');
                const ready = (yield* reserve(world, uploader, bytes, { idempotencyKey: 'hosted-ready' })).mediaAssetRef
                  .resourceId;
                expect((yield* putBytes(edge, uploader, ready, bytes)).status).toBe(200);
                const reserved = (yield* reserve(world, uploader, bytesOf('never uploaded'), {
                  idempotencyKey: 'hosted-reserved',
                })).mediaAssetRef.resourceId;
                const unknown = '8d0e5b0e-2c61-4f43-a5a3-5f7b3c0d9a11';
                const ids = [ready, reserved, unknown];

                // The requester's own Current capability decides: AVAILABLE only for the confirmed asset.
                const token = yield* issueFor(world, asker, 'shell-super-app');
                const answered = yield* postCurrent(world, edge.origin, token, ids);
                expect(answered.status).toBe(200);
                const refReady = refOf(world.tenantId, ready);
                expect(parseJson(answered.bytes)).toEqual({
                  entries: [
                    { current: { resourceRef: refReady, revision: 1 }, kind: 'AVAILABLE', resourceRef: refReady },
                    { kind: 'CURRENT_UNVERIFIED', resourceRef: refOf(world.tenantId, reserved) },
                    { kind: 'ABSENT', resourceRef: refOf(world.tenantId, unknown) },
                  ],
                });
                expect(textOf(answered.bytes)).not.toMatch(/storage|s3:|core-media\/v1|credential|revisionId/u);

                // The assertion is single use: the same token again is not answered.
                expect((yield* postCurrent(world, edge.origin, token, ids)).status).toBe(401);
                // The module's service credential adds no permission: a requester without the capability is refused.
                const forbidden = yield* postCurrent(
                  world,
                  edge.origin,
                  yield* issueFor(world, outsider, 'shell-super-app'),
                  ids,
                );
                expect(forbidden.status).toBe(403);
                expect(textOf(forbidden.bytes)).not.toContain('AVAILABLE');
                // An assertion issued to another audience, a person's own (no module) and no assertion are all refused.
                expect(
                  (yield* postCurrent(world, edge.origin, yield* issueFor(world, asker, 'catalog'), ids)).status,
                ).toBe(401);
                expect(
                  (yield* postCurrent(world, edge.origin, yield* issueFor(world, asker, 'shell-super-app', false), ids))
                    .status,
                ).toBe(401);
                expect((yield* postCurrent(world, edge.origin, undefined, ids)).status).toBe(401);

                // The provider is unreachable (CONTROLLED FAULT INJECTION): UNAVAILABLE, never AVAILABLE or ABSENT.
                faults.setRules([{ fault: { kind: 'reset-before' }, method: 'HEAD', times: 50 }]);
                const outage = yield* postCurrent(
                  world,
                  edge.origin,
                  yield* issueFor(world, asker, 'shell-super-app'),
                  [ready],
                );
                faults.setRules([]);
                expect(outage.status).toBe(200);
                expect(parseJson(outage.bytes)).toEqual({
                  entries: [{ kind: 'UNAVAILABLE', resourceRef: refReady }],
                });
              }),
            ),
          {
            contracts: [catalogContract()],
            requires: ['ONTOS_GATEWAY_ISSUER', 'ONTOS_GATEWAY_PUBLIC_JWKS', 'D20_E2E_GATEWAY_PRIVATE_JWK'],
          },
        ),
    );
  },
);
