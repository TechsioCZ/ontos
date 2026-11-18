// @rstest-environment happy-dom
// @rstest-environment-options {"url":"https://shell.example.test/cs"}
import { inProcessFetch, serveApi } from '@app/shared-contracts/testing/http-double';
import { Effect, Inspectable, Redacted, Result, Schema } from 'effect';
import { HttpServerRequest } from 'effect/http';
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from 'effect/http-api';
import { expect, it } from 'effect-rstest';

import { makeReferenceGatewayCredentials } from '../../src/operation-gateway.ts';
import { makeGovernedEffectBffClient } from '../../src/client-runtime.ts';
import { pinDocumentCompositionRevision } from '../../src/document-composition-revision.ts';
import { GatewayContextApiGroup } from '../../src/gateway-context.ts';
import type { GatewayContextRequestSchema } from '../../src/gateway-context.ts';
import {
  REFERENCE_GATEWAY_CREDENTIALS_HEADER,
  ReferenceGatewayCredentialsSchema,
} from '../../src/reference-gateway.ts';

const compositionRevision = 'a'.repeat(64);
it.effect('acquires a fresh browser assertion for every provider attempt and redacts the transport bundle', () =>
  Effect.gen(function* acquireFreshReferences() {
    yield* pinDocumentCompositionRevision(compositionRevision);
    const requests: HttpServerRequest.HttpServerRequest[] = [];
    const calls: (typeof GatewayContextRequestSchema.Type)[] = [];
    const api = HttpApi.make('ReferenceGatewayIssuer').add(GatewayContextApiGroup).prefix('/shell-super-app-api');
    const handlers = HttpApiBuilder.group(api, 'gatewayContext', (group) =>
      group
        .handle('issueGatewayContext', ({ payload }) =>
          Effect.gen(function* issueReference() {
            requests.push(yield* HttpServerRequest.HttpServerRequest);
            calls.push(payload);
            return {
              apiBaseUrl: '/shell-super-app-api/module-api/party-registry/provider-build/party-registry-api',
              compositionRevision,
              expiresAt: 1_700_000_300,
              token: `fresh-attempt-${requests.length}`,
            };
          }),
        )
        .handle('issueApiKeyGatewayContext', () => Effect.die('Unexpected API-key context request'))
        .handle('issueDelegatedGatewayContext', () => Effect.die('Unexpected delegated context request')),
    );
    const network = inProcessFetch(serveApi(api, handlers));
    const acquisition = makeReferenceGatewayCredentials(['party-registry', 'party-registry', 'billing']).pipe(
      Effect.provide(network),
    );
    const bundle = yield* acquisition;
    expect(Redacted.isRedacted(bundle)).toBe(true);
    expect(Inspectable.toStringUnknown(bundle)).not.toContain('fresh-attempt');
    const decoded = yield* Schema.decodeEffect(Schema.fromJsonString(ReferenceGatewayCredentialsSchema))(
      Redacted.value(bundle),
    );
    expect(
      decoded.map((entry) => ({ audience: entry.audience, authorization: Redacted.value(entry.authorization) })),
    ).toEqual([
      { audience: 'party-registry', authorization: 'Bearer fresh-attempt-1' },
      { audience: 'party-registry', authorization: 'Bearer fresh-attempt-2' },
      { audience: 'billing', authorization: 'Bearer fresh-attempt-3' },
    ]);
    expect(
      requests.every(
        (request) => request.originalUrl === 'https://shell.example.test/shell-super-app-api/auth/gateway-context',
      ),
    ).toBe(true);
    expect(calls).toEqual(
      ['party-registry', 'party-registry', 'billing'].map((audience) => ({ audience, compositionRevision })),
    );
    const second = yield* acquisition;
    expect(Redacted.value(second)).not.toBe(Redacted.value(bundle));
    expect(requests.length).toBe(6);
  }),
);

it.effect('rejects malformed and oversized credential bundles at the public wire contract', () =>
  Effect.gen(function* rejectMalformedReferences() {
    const decode = Schema.decodeUnknownEffect(ReferenceGatewayCredentialsSchema);
    for (const input of [
      [{ audience: 'party/registry', authorization: 'Bearer token' }],
      [{ audience: 'party-registry', authorization: '' }],
      [{ audience: 'party-registry', authorization: 'x'.repeat(4001) }],
      Array.from({ length: 17 }, () => ({ audience: 'party-registry', authorization: 'Bearer token' })),
    ]) {
      expect(Result.isFailure(yield* Effect.result(decode(input)))).toBe(true);
    }
    expect(yield* decode([])).toEqual([]);
  }),
);

const ReferenceTransportApi = HttpApi.make('ReferenceTransportApi').add(
  HttpApiGroup.make('commands').add(
    HttpApiEndpoint.post('apply', '/apply', {
      payload: Schema.Struct({ command: Schema.Literal('ConfirmInvoice'), expectedRevision: Schema.Int }),
      success: Schema.Struct({ revision: Schema.Int }),
    }),
  ),
);

it.effect(
  'governed clients forward reference authority only in transport and omit an absent bundle without changing business payload',
  () =>
    Effect.gen(function* forwardTransportOnly() {
      const requests: HttpServerRequest.HttpServerRequest[] = [];
      const bodies: unknown[] = [];
      const api = ReferenceTransportApi.prefix('/shell-super-app-api/module-api/billing/owner-build/billing-api');
      const handlers = HttpApiBuilder.group(api, 'commands', (group) =>
        group.handle('apply', () =>
          Effect.gen(function* receiveCommand() {
            const request = yield* HttpServerRequest.HttpServerRequest;
            requests.push(request);
            bodies.push(yield* request.json.pipe(Effect.orDie));
            return { revision: 1 };
          }),
        ),
      );
      const network = inProcessFetch(serveApi(api, handlers));
      const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(ReferenceGatewayCredentialsSchema))([
        { audience: 'party-registry', authorization: Redacted.make('Bearer fresh-provider-assertion') },
      ]);
      const config = {
        api: ReferenceTransportApi,
        credential: Redacted.make('Bearer receiving-owner-assertion'),
        defaultApiPrefix: 'https://shell.example.test/shell-super-app-api/module-api/billing/owner-build/billing-api',
        idempotencyKey: 'finance-confirm-idempotency',
        requestCorrelation: 'reference-transport-test',
      };
      const payload = { command: 'ConfirmInvoice', expectedRevision: 0 } as const;
      yield* makeGovernedEffectBffClient(config, { referenceCredentials: Redacted.make(encoded) }).pipe(
        Effect.flatMap((client) => client.commands.apply({ payload })),
        Effect.provide(network),
      );
      yield* makeGovernedEffectBffClient(config, {}).pipe(
        Effect.flatMap((client) => client.commands.apply({ payload })),
        Effect.provide(network),
      );
      expect(requests[0]?.headers[REFERENCE_GATEWAY_CREDENTIALS_HEADER]).toBe(encoded);
      expect(requests[1] && Object.hasOwn(requests[1].headers, REFERENCE_GATEWAY_CREDENTIALS_HEADER)).toBe(false);
      expect(requests[0]?.headers['authorization']).toBe('Bearer receiving-owner-assertion');
      expect(requests[0]?.headers['idempotency-key']).toBe('finance-confirm-idempotency');
      expect(bodies).toEqual([payload, payload]);
      expect(bodies).not.toContain(encoded);
    }),
);
