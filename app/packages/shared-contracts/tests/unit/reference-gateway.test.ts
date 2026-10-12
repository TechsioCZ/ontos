import { Effect, Inspectable, Redacted, Result, Schema } from 'effect';
import { FetchHttpClient } from 'effect/unstable/http';
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from 'effect/unstable/httpapi';
import { afterEach, beforeEach, expect, it } from 'effect-rstest';

import { makeReferenceGatewayCredentials } from '../../src/operation-gateway.ts';
import { makeGovernedEffectBffClient } from '../../src/client-runtime.ts';
import { pinDocumentCompositionRevision } from '../../src/document-composition-revision.ts';
import { GatewayContextRequestSchema } from '../../src/gateway-context.ts';
import {
  REFERENCE_GATEWAY_CREDENTIALS_HEADER,
  ReferenceGatewayCredentialsSchema,
} from '../../src/reference-gateway.ts';

const compositionRevision = 'a'.repeat(64);
const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
const locationDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'location');
beforeEach(() => {
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { querySelectorAll: () => [] } });
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { origin: 'https://shell.example.test', pathname: '/cs' },
  });
});
afterEach(() => {
  if (documentDescriptor === undefined) {
    Reflect.deleteProperty(globalThis, 'document');
  } else {
    Object.defineProperty(globalThis, 'document', documentDescriptor);
  }
  if (locationDescriptor === undefined) {
    Reflect.deleteProperty(globalThis, 'location');
  } else {
    Object.defineProperty(globalThis, 'location', locationDescriptor);
  }
});

it.effect(
  'acquires a fresh bounded provider assertion for each attempt, including repeated audiences, and redacts the transport bundle',
  () =>
    Effect.gen(function* acquireFreshReferences() {
      yield* pinDocumentCompositionRevision(compositionRevision);
      const requests: Request[] = [];
      const transport: typeof fetch = (input, init) => {
        requests.push(new Request(input, init));
        return Promise.resolve(
          Response.json({
            apiBaseUrl: '/shell-super-app-api/module-api/party-registry/provider-build/party-registry-api',
            compositionRevision,
            expiresAt: 1_700_000_300,
            token: `fresh-attempt-${requests.length}`,
          }),
        );
      };
      const acquisition = makeReferenceGatewayCredentials(['party-registry', 'party-registry', 'billing']).pipe(
        Effect.provideService(FetchHttpClient.Fetch, transport),
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
      const calls = yield* Effect.forEach(
        requests,
        (request) =>
          Effect.promise(() => request.json()).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(GatewayContextRequestSchema)),
          ),
        { concurrency: 1 },
      );
      expect(
        requests.every(
          (request) => request.url === 'https://shell.example.test/shell-super-app-api/auth/gateway-context',
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
      const requests: Request[] = [];
      const transport: typeof fetch = (input, init) => {
        requests.push(new Request(input, init));
        return Promise.resolve(Response.json({ revision: 1 }));
      };
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
        Effect.provideService(FetchHttpClient.Fetch, transport),
      );
      yield* makeGovernedEffectBffClient(config, {}).pipe(
        Effect.flatMap((client) => client.commands.apply({ payload })),
        Effect.provideService(FetchHttpClient.Fetch, transport),
      );
      expect(requests[0]?.headers.get(REFERENCE_GATEWAY_CREDENTIALS_HEADER)).toBe(encoded);
      expect(requests[1]?.headers.has(REFERENCE_GATEWAY_CREDENTIALS_HEADER)).toBe(false);
      expect(requests[0]?.headers.get('authorization')).toBe('Bearer receiving-owner-assertion');
      expect(requests[0]?.headers.get('idempotency-key')).toBe('finance-confirm-idempotency');
      const bodies = yield* Effect.forEach(requests, (request) => Effect.promise(() => request.json()), {
        concurrency: 1,
      });
      expect(bodies).toEqual([payload, payload]);
      expect(bodies).not.toContain(encoded);
    }),
);
