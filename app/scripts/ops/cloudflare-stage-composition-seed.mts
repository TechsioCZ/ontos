import { Config, ConfigProvider, Console, Duration, Effect, Redacted, Schema } from 'effect';
import { HttpClient, HttpClientRequest } from 'effect/http';

import { validateActiveApplicationCompositionSnapshot } from '../../packages/core-runtime/src/index.ts';
import { decodeActiveApplicationCompositionSnapshot } from '../active-application-composition.mts';
import { COMPOSITION_KV_ID_VARIABLE, PLACEMENT_LABEL, PLACEMENT_PATH, PlacementSchema } from './stage-edge-units.mts';
import { StageOperationError } from './stage-operation-error.mts';
import { readStageEdgeTopology } from './stage-edge-topology.mts';
import { decodeInput, readAppText } from './stage-operations.mts';

const COMPOSITION_NAMESPACE = 'ontos-stage-active-application-composition';
const seedFailure = (message: string) => (cause: unknown) =>
  Schema.is(StageOperationError)(cause) ? cause : new StageOperationError({ message });

/** Both credentials are parsed only from their explicit files, never the ambient account/token. */
const seedCredentials = (path: string) =>
  Effect.gen(function* seedCredentialsEffect() {
    const provider = yield* ConfigProvider.fromDotEnv({ path });
    return yield* Config.all({
      accountId: Config.NonEmptyString('CLOUDFLARE_ACCOUNT_ID'),
      apiToken: Config.Redacted('CLOUDFLARE_API_TOKEN'),
    }).parse(provider);
  });

export const validateSeedSnapshot = (bytes: Uint8Array) =>
  Effect.try(() => new TextDecoder('utf-8', { fatal: true }).decode(bytes)).pipe(
    Effect.flatMap(decodeActiveApplicationCompositionSnapshot),
    Effect.flatMap(validateActiveApplicationCompositionSnapshot),
    Effect.mapError(
      seedFailure('the old active composition snapshot is invalid or expired; refresh it before seeding'),
    ),
  );

interface CompositionKvCredentials {
  readonly accountId: string;
  readonly apiToken: Redacted.Redacted;
  readonly namespaceId: string;
}

const compositionKvUrl = ({ accountId, namespaceId }: CompositionKvCredentials) =>
  `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/active`;

const NamespaceIdSchema = Schema.NonEmptyString.pipe(Schema.brand('CloudflareKvNamespaceId'));
const NamespacePageSchema = Schema.Struct({
  result: Schema.Array(Schema.Struct({ id: NamespaceIdSchema, title: Schema.String })),
  success: Schema.Boolean,
});

const findCompositionNamespace = (credentials: Omit<CompositionKvCredentials, 'namespaceId'>) =>
  Effect.gen(function* findCompositionNamespaceEffect() {
    const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
    for (let page = 1; ; page += 1) {
      const response = yield* client.execute(
        HttpClientRequest.get(
          `https://api.cloudflare.com/client/v4/accounts/${credentials.accountId}/storage/kv/namespaces?page=${String(page)}&per_page=100`,
        ).pipe(HttpClientRequest.bearerToken(Redacted.value(credentials.apiToken))),
      );
      const result = yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(NamespacePageSchema)));
      if (!result.success) {
        return yield* new StageOperationError({ message: 'Cloudflare rejected the composition namespace lookup' });
      }
      const namespace = result.result.find(({ title }) => title === COMPOSITION_NAMESPACE);
      if (namespace !== undefined) {
        return namespace.id;
      }
      if (result.result.length < 100) {
        return yield* new StageOperationError({
          message: `account ${credentials.accountId} lacks KV namespace ${COMPOSITION_NAMESPACE}`,
        });
      }
    }
  }).pipe(
    Effect.timeout(Duration.seconds(60)),
    Effect.mapError(
      seedFailure('composition namespace lookup failed; check account credentials and namespace permissions'),
    ),
  );

/** Copies the original bytes, not a decoded/re-encoded projection. No token or snapshot is logged. */
export const copyCompositionSnapshot = (
  source: CompositionKvCredentials,
  target: CompositionKvCredentials,
  dryRun: boolean,
) =>
  Effect.gen(function* copyCompositionSnapshotEffect() {
    const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
    const response = yield* client.execute(
      HttpClientRequest.get(compositionKvUrl(source)).pipe(
        HttpClientRequest.bearerToken(Redacted.value(source.apiToken)),
      ),
    );
    const bytes = new Uint8Array(yield* response.arrayBuffer);
    yield* validateSeedSnapshot(bytes);
    if (dryRun) {
      return yield* Console.log(
        `DRY RUN: copy the verified unexpired active snapshot byte-for-byte from account ${source.accountId} into account ${target.accountId}, namespace ${target.namespaceId}`,
      );
    }
    const written = yield* client.execute(
      HttpClientRequest.put(compositionKvUrl(target)).pipe(
        HttpClientRequest.bearerToken(Redacted.value(target.apiToken)),
        HttpClientRequest.bodyUint8Array(bytes, 'application/octet-stream'),
      ),
    );
    const result = yield* written.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ success: Schema.Boolean }))),
    );
    if (!result.success) {
      return yield* new StageOperationError({ message: 'Cloudflare rejected the composition KV seed' });
    }
    return yield* Console.log('Copied the unexpired active composition snapshot byte-for-byte into the new namespace');
  }).pipe(
    Effect.timeout(Duration.seconds(60)),
    Effect.mapError(seedFailure('composition KV seed failed; no credentials or snapshot values were logged')),
  );

export const seedComposition = ({
  dryRun,
  envFile,
  oldEnvFile,
}: {
  readonly dryRun: boolean;
  readonly envFile: string;
  readonly oldEnvFile: string;
}) =>
  Effect.gen(function* seedCompositionEffect() {
    const topology = yield* readStageEdgeTopology;
    const source = yield* seedCredentials(oldEnvFile);
    const target = yield* seedCredentials(envFile);
    if (target.accountId !== topology.accountId || source.accountId === target.accountId) {
      return yield* new StageOperationError({
        message:
          'seed-composition requires distinct old/new accounts and the new account must equal topology/stage-edge.json accountId',
      });
    }
    const placement = yield* decodeInput(PlacementSchema, PLACEMENT_LABEL)(yield* readAppText(...PLACEMENT_PATH));
    const namespaceId = placement.buildEnvironment[COMPOSITION_KV_ID_VARIABLE];
    if (!namespaceId) {
      return yield* new StageOperationError({
        message: `${PLACEMENT_LABEL}: ${COMPOSITION_KV_ID_VARIABLE} is empty; provision the new composition namespace before seeding`,
      });
    }
    const sourceNamespaceId = yield* findCompositionNamespace(source);
    const targetNamespaceId = yield* findCompositionNamespace(target);
    if (targetNamespaceId !== namespaceId) {
      return yield* new StageOperationError({
        message: `${PLACEMENT_LABEL} composition namespace ID does not match the new account; run provision first`,
      });
    }
    return yield* copyCompositionSnapshot(
      { ...source, namespaceId: sourceNamespaceId },
      { ...target, namespaceId },
      dryRun,
    );
  });
