// @rstest-environment node
import { randomUUID } from 'node:crypto';

import type { TrustedPrincipalContext } from '@app/core-runtime';
import { ActiveApplicationCompositionService } from '@app/core-runtime/modules/active-application-composition';
import { makeModuleContractFixture } from '@app/core-runtime/testing/module-contract';
import { GatewayContextClaimsSchema } from '@app/shared-contracts';
import { NodeHttpServer } from '@effect/platform-node';
import { Crypto, DateTime, Effect, Layer, Match, PlatformError, Schema } from 'effect';
import { HttpServerRequest, HttpServerResponse } from 'effect/http';
import { NetAddress } from 'effect/net';
import { expect, it } from 'effect-rstest';
import { exportJWK, generateKeyPair, jwtVerify } from 'jose';

import { decideLegacy, revertLegacy } from '../../../api/agent-platform/legacy-queue.ts';
import { AgentModuleCallError } from '../../../api/agent-platform/module-call.ts';
import { AgentReadRequestIdentity } from '../../../api/auth/agent-request-identity.ts';
import { makeGatewayIssuerLayer } from '../../../api/auth/gateway-issuer.ts';
import { parseGatewayIssuerConfig } from '../../../api/auth/gateway-issuer-config.ts';
import { makeInstalledModuleCatalogLayer } from '../../../api/modules/installed-module-catalog.ts';
import { makeCompositionSnapshot, sealComposition } from '../../fixtures/application-composition.ts';
import { scopeGrantRegistrarLayer } from '../../support/gateway-issuer-layer.ts';

const principal: TrustedPrincipalContext = {
  authBindingId: '00000000-0000-4000-8000-000000000004',
  authContextRef: 'session:legacy-queue',
  authMethod: 'session',
  legalEntityId: '00000000-0000-4000-8000-000000000002',
  principalId: '00000000-0000-4000-8000-000000000003',
  tenantId: '00000000-0000-4000-8000-000000000001',
};
const cryptoFailure = PlatformError.systemError({
  _tag: 'Unknown',
  method: 'randomUUIDv4',
  module: 'Crypto',
});
const nativeCrypto = Crypto.make({
  digest: (_algorithm, data) => Effect.succeed(data),
  randomBytes: (size) => new Uint8Array(size).fill(5),
});
const CommandEnvelope = Schema.Struct({ command: Schema.JsonObject, expectedRevision: Schema.Number });
const baseContract = makeModuleContractFixture({ appId: 'crm', moduleId: 'fixture.crm' });
const contract = {
  ...baseContract,
  manifest: {
    ...baseContract.manifest,
    publicSurface: {
      ...baseContract.manifest.publicSurface,
      mcp: {
        approvals: true,
        commandActions: { AiDecideChanges: ['review-changes'], AiRevertBatch: ['review-changes'] },
        description: { cs: 'Testovací CRM', en: 'Test CRM' },
        keywords: 'crm',
        label: { cs: 'CRM', en: 'CRM' },
        ownProposalEngine: true,
        revision: { field: 'revision', fieldsByCommandPrefix: [], path: '/reads/records', query: {} },
        toolCatalog: {
          path: '/.well-known/ontos-module-mcp-tools.json',
          sha256: '0'.repeat(64),
          toolCount: 0,
        },
      },
    },
  },
};

const legacyOwner = Effect.gen(function* serveLegacyOwner() {
  const commands: {
    readonly appId: string;
    readonly command: typeof CommandEnvelope.Type.command;
    readonly expectedRevision: number;
    readonly idempotencyKey: string | undefined;
    readonly path: string;
    readonly principal: typeof GatewayContextClaimsSchema.Type.principal;
  }[] = [];
  const requests: string[] = [];
  const { privateKey, publicKey } = yield* Effect.promise(() => generateKeyPair('EdDSA', { extractable: true }));
  const privateJwk = yield* Effect.promise(() => exportJWK(privateKey));
  const configuration = yield* parseGatewayIssuerConfig({
    ONTOS_GATEWAY_ISSUER: 'https://shell.test',
    ONTOS_GATEWAY_PRIVATE_JWK: JSON.stringify({ ...privateJwk, alg: 'EdDSA', kid: 'legacy-queue', use: 'sig' }),
  });
  const server = yield* NodeHttpServer.make(() => process.getBuiltinModule('http').createServer(), {
    host: '127.0.0.1',
    port: 0,
  });
  yield* server.serve(
    HttpServerRequest.HttpServerRequest.use((request) =>
      Effect.gen(function* receiveCommand() {
        requests.push(request.url);
        const authorization = request.headers['authorization'] ?? '';
        const { payload } = yield* Effect.promise(() =>
          jwtVerify(authorization.slice('Bearer '.length), publicKey, {
            audience: 'crm',
            issuer: configuration.issuer,
          }),
        );
        const claims = yield* Schema.decodeUnknownEffect(GatewayContextClaimsSchema)(payload);
        if (request.url === '/crm-api/reads/records') {
          return HttpServerResponse.jsonUnsafe({ revision: 7 });
        }
        const envelope = yield* HttpServerRequest.schemaBodyJson(CommandEnvelope);
        commands.push({
          appId: 'crm',
          command: envelope.command,
          expectedRevision: envelope.expectedRevision,
          idempotencyKey: request.headers['idempotency-key'],
          path: request.url,
          principal: claims.principal,
        });
        return HttpServerResponse.jsonUnsafe(null);
      }).pipe(Effect.orDie),
    ),
  );
  const address = yield* Match.value(server.address).pipe(
    Match.when(NetAddress.isInetAddress, (inet) => Effect.succeed(inet)),
    Match.orElse(() => Effect.die('The CRM test owner did not bind to TCP')),
  );
  const original = yield* makeCompositionSnapshot([contract]);
  const snapshot = {
    ...original,
    composition: sealComposition({
      ...original.composition,
      modules: original.composition.modules.map((module) => ({
        ...module,
        backend: { baseUrl: `http://127.0.0.1:${address.port}/`, transport: 'node-http' as const },
      })),
    }),
  };
  const load = Effect.succeed(snapshot);
  const issuer = makeGatewayIssuerLayer({
    currentTimeSeconds: Effect.succeed(Math.floor(DateTime.toEpochMillis(snapshot.observedAt) / 1000)),
    generateJti: Effect.sync(randomUUID),
    loadAdmission: Effect.succeed({
      audiences: new Map([['crm', contract.deployment.buildMarker]]),
      revision: snapshot.composition.revision,
    }),
    loadConfig: Effect.succeed(configuration),
  }).pipe(Layer.provide(scopeGrantRegistrarLayer()));
  return {
    commands,
    layer: Layer.mergeAll(
      Layer.succeed(ActiveApplicationCompositionService, { load }),
      Layer.succeed(AgentReadRequestIdentity, { correlationId: 'legacy-command' }),
      makeInstalledModuleCatalogLayer(load),
      issuer,
    ),
    requests,
  };
});

it.live('generates native command keys lazily and runs decisions on the Action owning the engine command', () =>
  Effect.gen(function* nativeKeys() {
    const owner = yield* legacyOwner;
    let uuidCalls = 0;
    const crypto = Crypto.make({
      digest: (_algorithm, data) => Effect.succeed(data),
      randomBytes: (size) => {
        uuidCalls += 1;
        return new Uint8Array(size).fill(uuidCalls);
      },
    });
    const decide = decideLegacy(principal, 'crm', ['change-a'], 'approve', '  Reviewed  ');
    const revert = revertLegacy(principal, 'crm', 'batch-a', '  Restore  ');
    expect(uuidCalls).toBe(0);
    yield* decide.pipe(Effect.provideService(Crypto.Crypto, crypto), Effect.provide(owner.layer));
    yield* revert.pipe(Effect.provideService(Crypto.Crypto, crypto), Effect.provide(owner.layer));
    expect(uuidCalls).toBe(2);
    expect(owner.commands).toEqual([
      {
        appId: 'crm',
        command: { _tag: 'AiDecideChanges', changeIds: ['change-a'], decision: 'approve', note: 'Reviewed' },
        expectedRevision: 7,
        idempotencyKey: '01010101-0101-4101-8101-010101010101',
        path: '/crm-api/crm/actions/review-changes',
        principal,
      },
      {
        appId: 'crm',
        command: { _tag: 'AiRevertBatch', batchId: 'batch-a', note: 'Restore' },
        expectedRevision: 7,
        idempotencyKey: '02020202-0202-4202-8202-020202020202',
        path: '/crm-api/crm/actions/review-changes',
        principal,
      },
    ]);
  }).pipe(Effect.scoped),
);

it.live('keeps blank decision notes and short revert notes out of the command', () =>
  Effect.gen(function* omittedNotes() {
    const owner = yield* legacyOwner;
    yield* decideLegacy(principal, 'crm', ['change-a'], 'reject', ' ').pipe(
      Effect.provideService(Crypto.Crypto, nativeCrypto),
      Effect.provide(owner.layer),
    );
    yield* revertLegacy(principal, 'crm', 'batch-a', ' x ').pipe(
      Effect.provideService(Crypto.Crypto, nativeCrypto),
      Effect.provide(owner.layer),
    );
    expect(owner.commands).toHaveLength(2);
    for (const { command } of owner.commands) {
      expect(command).not.toHaveProperty('note');
    }
  }).pipe(Effect.scoped),
);

it.live('maps Crypto failures to AgentModuleCallError without dispatching either command', () =>
  Effect.gen(function* failedKeys() {
    const owner = yield* legacyOwner;
    const crypto: Crypto.Crypto = { ...nativeCrypto, randomUUIDv4: () => Effect.fail(cryptoFailure) };
    for (const command of [
      decideLegacy(principal, 'crm', ['change-a'], 'approve'),
      revertLegacy(principal, 'crm', 'batch-a'),
    ]) {
      const error = yield* Effect.flip(
        command.pipe(Effect.provideService(Crypto.Crypto, crypto), Effect.provide(owner.layer)),
      );
      expect(error).toBeInstanceOf(AgentModuleCallError);
      expect(error).toHaveProperty('cause', cryptoFailure);
      expect(error).toHaveProperty('stage', 'dispatch');
    }
    expect(owner.commands).toEqual([]);
    expect(owner.requests).toEqual([]);
  }).pipe(Effect.scoped),
);
