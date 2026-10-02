import { Config, Effect, Redacted, Schema, Stream } from 'effect';
import { HttpClient, HttpClientRequest } from 'effect/unstable/http';

import {
  ONTOS_MODULE_CONTRACT_MAX_BYTES,
  ONTOS_MODULE_CONTRACT_PATH,
  OntosModuleDeploymentContractSchema,
} from '../packages/core-runtime/src/index.ts';
import { moduleReleaseWorkerName } from '../packages/core-runtime/src/http/module-release-identity.ts';
import {
  ApplicationCompositionBackendSchema,
  ApplicationCompositionCloudflareWorkerBackendSchema,
} from '../packages/core-runtime/src/modules/application-composition.ts';
import type { ApplicationCompositionBackend } from '../packages/core-runtime/src/modules/application-composition.ts';
import {
  ACTIVE_APPLICATION_COMPOSITION_POLICY,
  ARTIFACT_FETCH_TIMEOUT,
  ActiveApplicationCompositionPublicationError,
} from './active-application-composition.mts';
import type { ObservedArtifact } from './active-application-composition.mts';
import { validateNativeCompositionSourceUrl } from './configure-runtime-composition-source.mts';

const NativeAccountSubdomainSchema = Schema.Struct({
  result: Schema.Struct({ subdomain: Schema.NonEmptyString }),
  success: Schema.Literal(true),
});
const NativeWorkerSubdomainSchema = Schema.Struct({
  result: Schema.Struct({ enabled: Schema.Literal(true) }),
  success: Schema.Literal(true),
});
const NativeWorkerDeploymentsSchema = Schema.Struct({
  result: Schema.Struct({
    deployments: Schema.Array(
      Schema.Struct({
        versions: Schema.Array(
          Schema.Struct({
            percentage: Schema.Number,
            version_id: ApplicationCompositionCloudflareWorkerBackendSchema.fields.versionId,
          }),
        ),
      }),
    ),
  }),
  success: Schema.Literal(true),
});
const NativeWorkerVersionSchema = Schema.Struct({
  result: Schema.Struct({ id: ApplicationCompositionCloudflareWorkerBackendSchema.fields.versionId }),
  success: Schema.Literal(true),
});

interface BoundedBody {
  readonly chunks: readonly Uint8Array[];
  readonly length: number;
}

const observationFailed = (appId: string) =>
  new ActiveApplicationCompositionPublicationError({
    message: `${appId} native backend identity could not be independently observed`,
    reason: 'invalid_observation',
  });

/** Read one native endpoint without letting provider bodies or credentials enter errors. */
const readBackendBytes = (appId: string, request: HttpClientRequest.HttpClientRequest) =>
  Effect.gen(function* readBackend() {
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
    const response = yield* client.execute(request);
    const body = yield* Stream.runFoldEffect(
      response.stream,
      (): BoundedBody => ({ chunks: [], length: 0 }),
      (previous, chunk) => {
        const length = previous.length + chunk.byteLength;
        return length > ONTOS_MODULE_CONTRACT_MAX_BYTES
          ? Effect.fail(observationFailed(appId))
          : Effect.succeed({ chunks: [...previous.chunks, chunk], length });
      },
    );
    const bytes = new Uint8Array(body.length);
    let offset = 0;
    for (const chunk of body.chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }).pipe(
    Effect.timeoutOrElse({
      duration: ARTIFACT_FETCH_TIMEOUT,
      orElse: () => Effect.fail(observationFailed(appId)),
    }),
    Effect.mapError(() => observationFailed(appId)),
  );

const readBackendDocument = (appId: string, request: HttpClientRequest.HttpClientRequest) =>
  readBackendBytes(appId, request).pipe(
    Effect.flatMap((bytes) =>
      Effect.try({
        catch: () => observationFailed(appId),
        try: () => new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      }),
    ),
  );

/** Observe the exact native destination before admitting its release into composition. */
export const observeApplicationCompositionBackend = (input: {
  readonly appId: string;
  readonly backend: ApplicationCompositionBackend;
  readonly contract: ObservedArtifact;
}) =>
  Effect.gen(function* observeBackend() {
    const { appId, contract } = input;
    const backend = yield* Schema.decodeUnknownEffect(ApplicationCompositionBackendSchema, {
      onExcessProperty: 'error',
    })(input.backend);
    if (backend.transport === 'node-http') {
      const bytes = yield* readBackendBytes(
        appId,
        HttpClientRequest.get(new URL(ONTOS_MODULE_CONTRACT_PATH, backend.baseUrl).href).pipe(
          HttpClientRequest.setHeader('cache-control', 'no-cache'),
        ),
      );
      if (bytes.length !== contract.bytes.length || !bytes.every((value, index) => value === contract.bytes[index])) {
        return yield* observationFailed(appId);
      }
      return backend;
    }

    const sourceUrl = yield* Config.String(ACTIVE_APPLICATION_COMPOSITION_POLICY.sourceUrlVariable).pipe(
      Effect.flatMap(validateNativeCompositionSourceUrl),
    );
    const accountId = new URL(sourceUrl).pathname.split('/').at(4);
    if (accountId === undefined) {
      return yield* observationFailed(appId);
    }
    const token = yield* Config.Redacted('CLOUDFLARE_API_TOKEN');
    if (Redacted.value(token).trim() === '') {
      return yield* observationFailed(appId);
    }
    const contractDocument = yield* Effect.try({
      catch: () => observationFailed(appId),
      try: () => new TextDecoder('utf-8', { fatal: true }).decode(contract.bytes),
    }).pipe(
      Effect.flatMap(
        Schema.decodeEffect(
          Schema.fromJsonString(Schema.Struct({ deployment: OntosModuleDeploymentContractSchema.fields.deployment })),
        ),
      ),
    );
    const expectedWorkerName = yield* moduleReleaseWorkerName(appId, contractDocument.deployment.buildMarker);
    if (contractDocument.deployment.appId !== appId || backend.workerName !== expectedWorkerName) {
      return yield* observationFailed(appId);
    }

    const api = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers`;
    const worker = `${api}/scripts/${encodeURIComponent(backend.workerName)}`;
    const observeNativeDocument = (url: string) =>
      readBackendDocument(
        appId,
        HttpClientRequest.get(url).pipe(
          HttpClientRequest.bearerToken(Redacted.value(token)),
          HttpClientRequest.setHeader('cache-control', 'no-cache'),
        ),
      );
    const [account, availability, history, version] = yield* Effect.all(
      [
        observeNativeDocument(`${api}/subdomain`).pipe(
          Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(NativeAccountSubdomainSchema))),
        ),
        observeNativeDocument(`${worker}/subdomain`).pipe(
          Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(NativeWorkerSubdomainSchema))),
        ),
        observeNativeDocument(`${worker}/deployments`).pipe(
          Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(NativeWorkerDeploymentsSchema))),
        ),
        observeNativeDocument(`${worker}/versions/${encodeURIComponent(backend.versionId)}`).pipe(
          Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(NativeWorkerVersionSchema))),
        ),
      ],
      { concurrency: 2 },
    );
    const versions = history.result.deployments[0]?.versions;
    if (
      backend.baseUrl !== `https://${expectedWorkerName}.${account.result.subdomain}.workers.dev/` ||
      !availability.result.enabled ||
      versions?.length !== 1 ||
      versions[0]?.percentage !== 100 ||
      versions[0]?.version_id !== backend.versionId ||
      version.result.id !== backend.versionId
    ) {
      return yield* observationFailed(appId);
    }
    return backend;
  }).pipe(Effect.mapError(() => observationFailed(input.appId)));
