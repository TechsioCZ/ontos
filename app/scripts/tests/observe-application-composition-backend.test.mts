import { ConfigProvider, Effect, Layer, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { HttpClient, HttpClientResponse } from 'effect/unstable/http';

import { ONTOS_MODULE_CONTRACT_MAX_BYTES } from '../../packages/core-runtime/src/index.ts';
import { moduleReleaseWorkerName } from '../../packages/core-runtime/src/http/module-release-identity.ts';
import {
  ApplicationCompositionBackendSchema,
  ApplicationCompositionCloudflareWorkerBackendSchema,
} from '../../packages/core-runtime/src/modules/application-composition.ts';
import type { ApplicationCompositionBackend } from '../../packages/core-runtime/src/modules/application-composition.ts';
import type { ObservedArtifact } from '../active-application-composition.mts';
import { observeApplicationCompositionBackend } from '../observe-application-composition-backend.mts';

const ACCOUNT = 'a'.repeat(32);
const NAMESPACE_ID = 'b'.repeat(32);
const SOURCE_URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/storage/kv/namespaces/${NAMESPACE_ID}/values/active`;
const API = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers`;
const TOKEN = 'private-observation-token';
const APP_ID = 'pricing';
const BUILD_MARKER = 'release-1';
const ACCOUNT_SUBDOMAIN = 'test-account';
const VERSION_ID = 'c302ec41-290b-4d31-8105-5c3467008799';
const OTHER_VERSION_ID = 'd8409f49-a7d0-4aa3-8610-cbc13a638294';
const CONTRACT_TEXT = JSON.stringify({ deployment: { appId: APP_ID, buildMarker: BUILD_MARKER } });
const CONTRACT = { bytes: new TextEncoder().encode(CONTRACT_TEXT), url: 'https://artifacts.example.com/contract.json' };
const NODE_BACKEND = Schema.decodeUnknownSync(ApplicationCompositionBackendSchema)({
  baseUrl: 'https://private-pricing.example.com/',
  transport: 'node-http',
});
const INVALID_OBSERVATION = { error: { reason: 'invalid_observation' } };
type WorkerBackend = typeof ApplicationCompositionCloudflareWorkerBackendSchema.Type;
interface CapturedRequest {
  readonly authorization: string | null;
  readonly url: string;
}

const workerBackend = Effect.gen(function* exactWorkerRelease() {
  const workerName = yield* moduleReleaseWorkerName(APP_ID, BUILD_MARKER);
  return yield* Schema.decodeUnknownEffect(ApplicationCompositionCloudflareWorkerBackendSchema)({
    baseUrl: `https://${workerName}.${ACCOUNT_SUBDOMAIN}.workers.dev/`,
    transport: 'cloudflare-worker',
    versionId: VERSION_ID,
    workerName,
  });
});
const nativePaths = (backend: WorkerBackend) => {
  const script = `${API}/scripts/${backend.workerName}`;
  return {
    account: `${API}/subdomain`,
    availability: `${script}/subdomain`,
    deployments: `${script}/deployments`,
    version: `${script}/versions/${backend.versionId}`,
  };
};
const nativeDocuments = (backend: WorkerBackend) => {
  const paths = nativePaths(backend);
  return new Map<string, unknown>([
    [paths.account, { result: { subdomain: ACCOUNT_SUBDOMAIN }, success: true }],
    [paths.availability, { result: { enabled: true }, success: true }],
    [
      paths.deployments,
      { result: { deployments: [{ versions: [{ percentage: 100, version_id: backend.versionId }] }] }, success: true },
    ],
    [paths.version, { result: { id: backend.versionId }, success: true }],
  ]);
};
const nativeResponses = (backend: WorkerBackend, replacements: ReadonlyMap<string, unknown> = new Map()) => {
  const documents = new Map([...nativeDocuments(backend), ...replacements]);
  return (url: string) =>
    documents.has(url) ? Response.json(documents.get(url)) : new Response(null, { status: 404 });
};
const observation = (input: {
  readonly backend: ApplicationCompositionBackend;
  readonly contract?: ObservedArtifact;
  readonly requests?: CapturedRequest[];
  readonly response: (url: string) => Response;
  readonly sourceUrl?: string;
  readonly token?: string;
}) => {
  const client = HttpClient.make((request, destination) => {
    input.requests?.push({ authorization: request.headers.authorization ?? null, url: destination.href });
    return Effect.succeed(HttpClientResponse.fromWeb(request, input.response(destination.href)));
  });
  return observeApplicationCompositionBackend({
    appId: APP_ID,
    backend: input.backend,
    contract: input.contract ?? CONTRACT,
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(HttpClient.HttpClient, client),
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            CLOUDFLARE_API_TOKEN: input.token ?? TOKEN,
            ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL: input.sourceUrl ?? SOURCE_URL,
          }),
        ),
      ),
    ),
    Effect.match({ onFailure: (error) => ({ error }), onSuccess: (backend) => ({ backend }) }),
    Effect.scoped,
  );
};

it.live('observes exact contract bytes through the native private Node origin', () =>
  Effect.gen(function* observePrivateOwner() {
    const requests: CapturedRequest[] = [];
    expect(
      yield* observation({ backend: NODE_BACKEND, requests, response: () => new Response(CONTRACT_TEXT) }),
    ).toEqual({ backend: NODE_BACKEND });
    expect(requests).toEqual([
      { authorization: null, url: 'https://private-pricing.example.com/.well-known/ontos-module-manifest.json' },
    ]);
  }),
);
it.live('rejects a private owner serving different bytes instead of trusting public artifact identity', () =>
  Effect.gen(function* rejectDifferentOwner() {
    expect(
      yield* observation({ backend: NODE_BACKEND, response: () => new Response(`${CONTRACT_TEXT}\n`) }),
    ).toMatchObject(INVALID_OBSERVATION);
  }),
);
it.live('observes the account origin, enabled Worker, current complete deployment and exact immutable version', () =>
  Effect.gen(function* observeOrdinaryWorker() {
    const backend = yield* workerBackend;
    const requests: CapturedRequest[] = [];
    expect(yield* observation({ backend, requests, response: nativeResponses(backend) })).toEqual({ backend });
    expect(new Set(requests.map(({ url }) => url))).toEqual(new Set(Object.values(nativePaths(backend))));
    expect(requests).toHaveLength(4);
    expect(requests.every(({ authorization }) => authorization === `Bearer ${TOKEN}`)).toBe(true);
  }),
);
it.live(
  'rejects a Worker name or contract owner that does not match the exact app and build before native requests',
  () =>
    Effect.gen(function* rejectWrongExecutableIdentity() {
      const backend = yield* workerBackend;
      const differentName = yield* moduleReleaseWorkerName(APP_ID, 'different-release');
      const differentBackend = yield* Schema.decodeUnknownEffect(ApplicationCompositionCloudflareWorkerBackendSchema)({
        ...backend,
        baseUrl: `https://${differentName}.${ACCOUNT_SUBDOMAIN}.workers.dev/`,
        workerName: differentName,
      });
      for (const input of [
        { backend: differentBackend, contract: CONTRACT },
        {
          backend,
          contract: {
            ...CONTRACT,
            bytes: new TextEncoder().encode(
              JSON.stringify({ deployment: { appId: 'inventory', buildMarker: BUILD_MARKER } }),
            ),
          },
        },
        {
          backend,
          contract: {
            ...CONTRACT,
            bytes: new TextEncoder().encode(
              JSON.stringify({ deployment: { appId: APP_ID, buildMarker: 'different-release' } }),
            ),
          },
        },
      ]) {
        const requests: CapturedRequest[] = [];
        expect(yield* observation({ ...input, requests, response: nativeResponses(backend) })).toMatchObject(
          INVALID_OBSERVATION,
        );
        expect(requests).toEqual([]);
      }
    }),
);
it.live('rejects an origin belonging to another account without sending credentials to that origin', () =>
  Effect.gen(function* rejectWrongAccountOrigin() {
    const backend = yield* workerBackend;
    const differentOrigin = yield* Schema.decodeUnknownEffect(ApplicationCompositionCloudflareWorkerBackendSchema)({
      ...backend,
      baseUrl: `https://${backend.workerName}.other-account.workers.dev/`,
    });
    const requests: CapturedRequest[] = [];
    expect(
      yield* observation({ backend: differentOrigin, requests, response: nativeResponses(backend) }),
    ).toMatchObject(INVALID_OBSERVATION);
    expect(requests).toHaveLength(4);
    expect(requests.every(({ url }) => url.startsWith(`${API}/`))).toBe(true);
  }),
);
it.live('rejects disabled, mixed, stale or mismatched native Worker metadata', () =>
  Effect.gen(function* rejectUnapprovedWorkerVersions() {
    const backend = yield* workerBackend;
    const paths = nativePaths(backend);
    const invalid: readonly { readonly body: unknown; readonly endpoint: keyof typeof paths }[] = [
      { body: { result: { enabled: false }, success: true }, endpoint: 'availability' },
      { body: { result: { subdomain: 'different-account' }, success: true }, endpoint: 'account' },
      { body: { result: { id: OTHER_VERSION_ID }, success: true }, endpoint: 'version' },
      { body: { result: { id: 'not-a-native-uuid' }, success: true }, endpoint: 'version' },
      { body: { result: { id: VERSION_ID }, success: false }, endpoint: 'version' },
      { body: { result: { deployments: [] }, success: true }, endpoint: 'deployments' },
      {
        body: {
          result: {
            deployments: [
              {
                versions: [
                  { percentage: 50, version_id: VERSION_ID },
                  { percentage: 50, version_id: OTHER_VERSION_ID },
                ],
              },
            ],
          },
          success: true,
        },
        endpoint: 'deployments',
      },
      {
        body: {
          result: { deployments: [{ versions: [{ percentage: 100, version_id: OTHER_VERSION_ID }] }] },
          success: true,
        },
        endpoint: 'deployments',
      },
      {
        body: { result: { deployments: [{ versions: [{ percentage: 99, version_id: VERSION_ID }] }] }, success: true },
        endpoint: 'deployments',
      },
    ];
    for (const { body, endpoint } of invalid) {
      expect(
        yield* observation({ backend, response: nativeResponses(backend, new Map([[paths[endpoint], body]])) }),
      ).toMatchObject(INVALID_OBSERVATION);
    }
  }),
);
it.live('strictly rejects invalid version UUIDs, nonnative origins and obsolete dispatch or ETag fields', () =>
  Effect.gen(function* rejectObsoleteBackendReceipt() {
    const backend = yield* workerBackend;
    for (const invalid of [
      { ...backend, versionId: 'not-a-native-uuid' },
      { ...backend, baseUrl: 'https://untrusted.example.com/' },
      { namespace: 'obsolete-namespace', scriptName: backend.workerName, transport: 'cloudflare-dispatch' },
    ]) {
      expect(() =>
        Schema.decodeUnknownSync(ApplicationCompositionBackendSchema, { onExcessProperty: 'error' })(invalid),
      ).toThrow();
    }
    for (const invalid of [
      { ...backend, namespace: 'obsolete-namespace' },
      { ...backend, scriptName: backend.workerName },
      { ...backend, expectedBackendEtag: 'obsolete-etag' },
    ]) {
      const requests: CapturedRequest[] = [];
      expect(yield* observation({ backend: invalid, requests, response: nativeResponses(backend) })).toMatchObject(
        INVALID_OBSERVATION,
      );
      expect(requests).toEqual([]);
    }
  }),
);
it.live('rejects nonnative or ambiguous source URLs before issuing credentialed requests', () =>
  Effect.gen(function* rejectCredentialDestination() {
    const backend = yield* workerBackend;
    for (const sourceUrl of [
      'https://untrusted.example.com/active',
      SOURCE_URL.replace('https:', 'http:'),
      SOURCE_URL.replace('https://', 'https://user@'),
      `${SOURCE_URL}?redirect=other`,
      `${SOURCE_URL}#fragment`,
    ]) {
      const requests: CapturedRequest[] = [];
      expect(yield* observation({ backend, requests, response: nativeResponses(backend), sourceUrl })).toMatchObject(
        INVALID_OBSERVATION,
      );
      expect(requests).toEqual([]);
    }
  }),
);
it.live('rejects missing native credentials before observation without exposing the credential', () =>
  Effect.gen(function* rejectBlankToken() {
    const backend = yield* workerBackend;
    const requests: CapturedRequest[] = [];
    const result = yield* observation({ backend, requests, response: nativeResponses(backend), token: ' ' });
    expect(result).toMatchObject(INVALID_OBSERVATION);
    expect(requests).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  }),
);
it.live('rejects failed status, redirects and malformed metadata without leaking provider bodies', () =>
  Effect.gen(function* rejectUntrustedResponses() {
    const backend = yield* workerBackend;
    for (const response of [
      () => new Response(`${TOKEN}: provider failure`, { status: 403 }),
      () =>
        new Response(`${TOKEN}: redirect`, { headers: { location: 'https://untrusted.example.com/' }, status: 302 }),
      () => new Response(`${TOKEN}: malformed metadata`),
      () => new Response(Uint8Array.of(0xff, 0xfe)),
    ]) {
      const result = yield* observation({ backend, response });
      expect(result).toMatchObject(INVALID_OBSERVATION);
      expect(JSON.stringify(result)).not.toContain(TOKEN);
      expect(JSON.stringify(result)).not.toContain('untrusted.example.com');
    }
  }),
);

it.live('accepts valid native metadata at the byte limit and rejects one extra legal JSON whitespace byte', () =>
  Effect.gen(function* enforceNativeBodyLimit() {
    const backend = yield* workerBackend;
    const endpoint = nativePaths(backend).availability;
    const document = JSON.stringify({ result: { enabled: true }, success: true });
    const encoder = new TextEncoder();
    const atLimit = encoder.encode(
      document + ' '.repeat(ONTOS_MODULE_CONTRACT_MAX_BYTES - encoder.encode(document).byteLength),
    );
    const native = nativeResponses(backend);
    const response = (exceedsLimit: boolean) => (url: string) =>
      url === endpoint
        ? new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(atLimit);
                if (exceedsLimit) {
                  controller.enqueue(Uint8Array.of(32));
                }
                controller.close();
              },
            }),
          )
        : native(url);
    expect(atLimit.byteLength).toBe(ONTOS_MODULE_CONTRACT_MAX_BYTES);
    expect(yield* observation({ backend, response: response(false) })).toEqual({ backend });
    const oversized = yield* observation({ backend, response: response(true) });
    expect(oversized).toMatchObject(INVALID_OBSERVATION);
    expect(JSON.stringify(oversized)).not.toContain(TOKEN);
    expect(JSON.stringify(oversized)).not.toContain('untrusted.example.com');
  }),
);
