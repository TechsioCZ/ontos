import { Config, Duration, Effect, Option, Redacted, Schema, Stream } from 'effect';
import { HttpClient, HttpClientRequest } from 'effect/unstable/http';
import type { HttpClientResponse } from 'effect/unstable/http';

import { ZeropsPublicApi } from './zerops-public-api.mts';

/** Explicit old deployments owned by the initial cutover, never a discovered account-wide inventory. */
export interface InitialCutoverProviderInventory {
  readonly cloudflare: {
    readonly accountId: string;
    readonly workerNames: readonly string[];
  };
  readonly zeropsServiceIds: readonly string[];
}

const snapshotInventory = (inventory: InitialCutoverProviderInventory): InitialCutoverProviderInventory => ({
  cloudflare: {
    accountId: inventory.cloudflare.accountId,
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

/** Decode only the small provider envelope; a successful GET returns executable bytes and is not read. */
const cloudflareEnvelope = (response: HttpClientResponse.HttpClientResponse, operation: Operation) =>
  Effect.gen(function* decodeCloudflareEnvelope() {
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
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(CloudflareEnvelopeSchema))(
      body.text + decoder.decode(),
    );
  });

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
  const envelope = yield* cloudflareEnvelope(response, 'read');
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
          const envelope = yield* cloudflareEnvelope(response, 'delete');
          if (!envelope.success || envelope.errors.length !== 0) {
            yield* failure('cloudflare', 'delete', 'provider did not confirm Worker deletion');
          }
        }).pipe(bounded('cloudflare', 'delete')),
      ),
    ];
    yield* Effect.all(operations, { concurrency: PROVIDER_CONCURRENCY, discard: true });
    yield* verifyInitialCutoverProviderInventory(snapshot);
  },
);
