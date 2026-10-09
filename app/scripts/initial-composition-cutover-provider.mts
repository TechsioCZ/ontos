import { createHash } from 'node:crypto';

import { Config, Duration, Effect, Option, Redacted, Schema, Stream } from 'effect';
import { HttpClient, HttpClientRequest } from 'effect/unstable/http';
import type { HttpClientResponse } from 'effect/unstable/http';

import { ACTIVE_APPLICATION_COMPOSITION_EDGE_KEY } from '../packages/core-runtime/src/modules/active-application-composition-edge.ts';
import { ONTOS_APPLICATION_COMPOSITION_MAX_BYTES } from '../packages/core-runtime/src/modules/application-composition-limits.ts';

import { ZeropsPublicApi } from './zerops-public-api.mts';

/** Explicit old deployments owned by the initial cutover, never a discovered account-wide inventory. */
export interface InitialCutoverProviderInventory {
  readonly cloudflare: {
    readonly accountId: string;
    readonly compositionPointer: { readonly namespaceId: string; readonly sha256: string };
    readonly workerNames: readonly string[];
  };
  readonly zeropsServiceIds: readonly string[];
}

const snapshotInventory = (inventory: InitialCutoverProviderInventory): InitialCutoverProviderInventory => ({
  cloudflare: {
    accountId: inventory.cloudflare.accountId,
    compositionPointer: { ...inventory.cloudflare.compositionPointer },
    workerNames: [...inventory.cloudflare.workerNames],
  },
  zeropsServiceIds: [...inventory.zeropsServiceIds],
});

/** Provider failures intentionally contain no request, response payload, credentials, or nested cause. */
export class InitialCutoverProviderError extends Schema.TaggedError<InitialCutoverProviderError>()(
  'InitialCutoverProviderError',
  {
    operation: Schema.Literals(['read', 'delete', 'verify']),
    provider: Schema.Literals(['zerops', 'cloudflare', 'inventory']),
    reason: Schema.String,
  },
) {}

const OPERATION_TIMEOUT = Duration.seconds(10);
const NODE_RETIREMENT_TIMEOUT = Duration.minutes(15);
const PROVIDER_CONCURRENCY = 4;
const MAX_RESPONSE_BYTES = 65_536;
const CloudflareEnvelopeSchema = Schema.Struct({
  errors: Schema.Array(Schema.Struct({ code: Schema.Number })),
  success: Schema.Boolean,
});
const CloudflareNamespaceSchema = Schema.Struct({
  ...CloudflareEnvelopeSchema.fields,
  result: Schema.Struct({ id: Schema.String }),
});

type Provider = InitialCutoverProviderError['provider'];
type Operation = InitialCutoverProviderError['operation'];

const failure = (provider: Provider, operation: Operation, reason: string) =>
  new InitialCutoverProviderError({ operation, provider, reason });

const bounded =
  (provider: Provider, operation: Operation) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.mapError(() => failure(provider, operation, 'provider operation failed')),
      Effect.timeoutOrElse({
        duration: provider === 'zerops' && operation === 'delete' ? NODE_RETIREMENT_TIMEOUT : OPERATION_TIMEOUT,
        orElse: () => Effect.fail(failure(provider, operation, 'provider operation timed out')),
      }),
    );

/** Read only small native envelopes; executable GET bodies are never consumed. */
const cloudflareResponseText = (response: HttpClientResponse.HttpClientResponse, operation: Operation) =>
  Effect.gen(function* readCloudflareEnvelopeText() {
    const decoder = new TextDecoder();
    const body = yield* response.stream.pipe(
      Stream.runFoldEffect(
        () => ({ bytes: 0, text: '' }),
        (state, chunk) => {
          const bytes = state.bytes + chunk.byteLength;
          return bytes > MAX_RESPONSE_BYTES
            ? Effect.fail(failure('cloudflare', operation, 'provider response exceeded byte limit'))
            : Effect.succeed({ bytes, text: state.text + decoder.decode(chunk, { stream: true }) });
        },
      ),
    );
    return body.text + decoder.decode();
  });

const decodeCloudflareEnvelope = (response: HttpClientResponse.HttpClientResponse, operation: Operation) =>
  cloudflareResponseText(response, operation).pipe(
    Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(CloudflareEnvelopeSchema))),
  );

const compositionPointerRequest = Effect.fn('InitialCutover.compositionPointerRequest')(
  function* compositionPointerRequest(
    inventory: InitialCutoverProviderInventory,
    method: 'GET' | 'DELETE',
    namespaceOnly: boolean,
  ) {
    const token = yield* Config.Redacted('CLOUDFLARE_API_TOKEN');
    const client = yield* HttpClient.HttpClient;
    const namespace = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(inventory.cloudflare.accountId)}/storage/kv/namespaces/${encodeURIComponent(inventory.cloudflare.compositionPointer.namespaceId)}`;
    const url = namespaceOnly ? namespace : `${namespace}/values/${ACTIVE_APPLICATION_COMPOSITION_EDGE_KEY}`;
    return yield* client.execute(
      HttpClientRequest.make(method)(url).pipe(
        HttpClientRequest.bearerToken(Redacted.value(token)),
        HttpClientRequest.setHeader('cache-control', 'no-cache'),
      ),
    );
  },
);

const verifyCompositionNamespace = Effect.fn('InitialCutover.verifyCompositionNamespace')(
  function* verifyCompositionNamespace(inventory: InitialCutoverProviderInventory) {
    const response = yield* compositionPointerRequest(inventory, 'GET', true);
    if (response.status !== 200) {
      return yield* failure('cloudflare', 'read', 'provider did not confirm the reviewed composition namespace');
    }
    const envelope = yield* cloudflareResponseText(response, 'read').pipe(
      Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(CloudflareNamespaceSchema))),
    );
    if (
      !envelope.success ||
      envelope.errors.length !== 0 ||
      envelope.result.id !== inventory.cloudflare.compositionPointer.namespaceId
    ) {
      return yield* failure('cloudflare', 'read', 'provider did not confirm the reviewed composition namespace');
    }
    return yield* Effect.void;
  },
);

const verifyCompositionPointerAbsent = Effect.fn('InitialCutover.verifyCompositionPointerAbsent')(
  function* verifyCompositionPointerAbsent(inventory: InitialCutoverProviderInventory) {
    yield* verifyCompositionNamespace(inventory);
    const response = yield* compositionPointerRequest(inventory, 'GET', false);
    // The native raw-value endpoint's 404 establishes key absence only after namespace identity was proved.
    if (response.status !== 404) {
      return yield* failure('cloudflare', 'verify', 'provider did not confirm composition pointer absence');
    }
    return yield* Effect.void;
  },
);

const retireCompositionPointer = Effect.fn('InitialCutover.retireCompositionPointer')(
  function* retireCompositionPointer(inventory: InitialCutoverProviderInventory) {
    yield* verifyCompositionNamespace(inventory);
    const response = yield* compositionPointerRequest(inventory, 'GET', false);
    if (response.status !== 404) {
      if (response.status !== 200) {
        return yield* failure('cloudflare', 'read', 'provider did not return the reviewed obsolete pointer');
      }
      const hash = createHash('sha256');
      yield* response.stream.pipe(
        Stream.runFoldEffect(
          () => 0,
          (size, chunk) => {
            const next = size + chunk.byteLength;
            if (next > ONTOS_APPLICATION_COMPOSITION_MAX_BYTES) {
              return Effect.fail(failure('cloudflare', 'read', 'composition pointer exceeded byte limit'));
            }
            hash.update(chunk);
            return Effect.succeed(next);
          },
        ),
      );
      if (hash.digest('hex') !== inventory.cloudflare.compositionPointer.sha256) {
        return yield* failure('cloudflare', 'delete', 'composition pointer differs from the reviewed obsolete bytes');
      }
      const deletion = yield* compositionPointerRequest(inventory, 'DELETE', false);
      if (deletion.status < 200 || deletion.status >= 300) {
        return yield* failure('cloudflare', 'delete', 'provider did not confirm composition pointer deletion');
      }
      const envelope = yield* decodeCloudflareEnvelope(deletion, 'delete');
      if (!envelope.success || envelope.errors.length !== 0) {
        return yield* failure('cloudflare', 'delete', 'provider did not confirm composition pointer deletion');
      }
    }
    return yield* verifyCompositionPointerAbsent(inventory);
  },
);

/** RequestInit.redirect must be manual in the process-edge FetchHttpClient layer. */
const cloudflareRequest = Effect.fn('InitialCutover.cloudflareRequest')(function* cloudflareRequest(
  inventory: InitialCutoverProviderInventory,
  workerName: string,
  method: 'GET' | 'DELETE',
) {
  const token = yield* Config.Redacted('CLOUDFLARE_API_TOKEN');
  const client = yield* HttpClient.HttpClient;
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(inventory.cloudflare.accountId)}/workers/scripts/${encodeURIComponent(workerName)}`;
  return yield* client.execute(
    HttpClientRequest.make(method)(url).pipe(HttpClientRequest.bearerToken(Redacted.value(token))),
  );
});

const cloudflareWorkerPresent = Effect.fn('InitialCutover.cloudflareWorkerPresent')(function* cloudflareWorkerPresent(
  inventory: InitialCutoverProviderInventory,
  workerName: string,
) {
  const response = yield* cloudflareRequest(inventory, workerName, 'GET');
  if (response.status >= 200 && response.status < 300) {
    return true;
  }
  if (response.status !== 404) {
    return yield* failure('cloudflare', 'read', 'provider did not confirm Worker absence');
  }
  const envelope = yield* decodeCloudflareEnvelope(response, 'read');
  // 10007 is Worker not found; auth errors, generic 404s, and mixed errors never prove absence.
  if (envelope.success || envelope.errors.length === 0 || envelope.errors.some(({ code }) => code !== 10_007)) {
    return yield* failure('cloudflare', 'read', 'provider did not confirm Worker absence');
  }
  return false;
});

const nodeRuntimeBase = /^(?:(?:alpine|ubuntu)\/)?nodejs@[a-z0-9.]+$/u;

const providerChecks = (inventory: InitialCutoverProviderInventory) => [
  ...inventory.zeropsServiceIds.map((serviceId) =>
    Effect.gen(function* verifyZeropsService() {
      if (serviceId === '.' || serviceId === '..') {
        yield* failure('zerops', 'read', 'service identity cannot be a dot path segment');
      }
      const api = yield* ZeropsPublicApi;
      const service = yield* api.findServiceStack(encodeURIComponent(serviceId));
      if (Option.isSome(service)) {
        yield* failure('zerops', 'read', 'old service is still present');
      }
    }).pipe(bounded('zerops', 'read')),
  ),
  ...inventory.cloudflare.workerNames.map((workerName) =>
    cloudflareWorkerPresent(inventory, workerName).pipe(
      Effect.flatMap((present) =>
        present ? Effect.fail(failure('cloudflare', 'read', 'old Worker is still deployed')) : Effect.void,
      ),
      bounded('cloudflare', 'read'),
    ),
  ),
];

/** Observation only: the authority owner binds the complete inventory and proof to the first publication. */
export const verifyInitialCutoverProviderInventory = Effect.fn('InitialCutover.verifyProviderInventory')(
  function* verifyInitialCutoverProviderInventory(inventory: InitialCutoverProviderInventory) {
    const snapshot = snapshotInventory(inventory);
    yield* Effect.all(providerChecks(snapshot), { concurrency: PROVIDER_CONCURRENCY, discard: true });
    yield* verifyCompositionPointerAbsent(snapshot).pipe(bounded('cloudflare', 'verify'));
  },
);

/** Permanently retire only explicit old runtime inventory, then verify absence before persisting proof. */
export const quiesceInitialCutoverProviderInventory = Effect.fn('InitialCutover.quiesceProviderInventory')(
  function* quiesceInitialCutoverProviderInventory(inventory: InitialCutoverProviderInventory) {
    const snapshot = snapshotInventory(inventory);
    const operations = [
      ...snapshot.zeropsServiceIds.map((serviceId) =>
        Effect.gen(function* deleteOldZeropsRuntime() {
          if (serviceId === '.' || serviceId === '..') {
            yield* failure('zerops', 'delete', 'service identity cannot be a dot path segment');
          }
          const api = yield* ZeropsPublicApi;
          const encodedId = encodeURIComponent(serviceId);
          const service = yield* api.findServiceStackIdentity(encodedId).pipe(bounded('zerops', 'read'));
          if (Option.isSome(service)) {
            if (service.value.isSystem || !nodeRuntimeBase.test(service.value.base)) {
              yield* failure('zerops', 'delete', 'retirement target is not a user Node.js runtime');
            }
            yield* api.deleteService(encodedId);
          }
        }).pipe(bounded('zerops', 'delete')),
      ),
      ...snapshot.cloudflare.workerNames.map((workerName) =>
        Effect.gen(function* deleteOldCloudflareWorker() {
          if (!(yield* cloudflareWorkerPresent(snapshot, workerName))) {
            return;
          }
          const response = yield* cloudflareRequest(snapshot, workerName, 'DELETE');
          if (response.status < 200 || response.status >= 300) {
            yield* failure('cloudflare', 'delete', 'provider did not confirm Worker deletion');
          }
          const envelope = yield* decodeCloudflareEnvelope(response, 'delete');
          if (!envelope.success || envelope.errors.length !== 0) {
            yield* failure('cloudflare', 'delete', 'provider did not confirm Worker deletion');
          }
        }).pipe(bounded('cloudflare', 'delete')),
      ),
    ];
    yield* Effect.all(operations, { concurrency: PROVIDER_CONCURRENCY, discard: true });
    yield* Effect.all(providerChecks(snapshot), { concurrency: PROVIDER_CONCURRENCY, discard: true });
    // Supported first publishers require the receipt, so none can write a new pointer during this retirement.
    yield* retireCompositionPointer(snapshot).pipe(bounded('cloudflare', 'delete'));
  },
);
