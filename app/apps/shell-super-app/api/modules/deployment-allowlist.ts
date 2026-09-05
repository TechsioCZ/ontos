// @effect-diagnostics preferSchemaOverJson:off
import { Effect, Schema, Predicate } from 'effect';
import { ONTOS_MODULE_CONTRACT_PATH, OntosDeploymentAppIdSchema } from '@app/core-runtime';
import type { OntosDeploymentAppId } from '@app/core-runtime';

export class DeploymentAllowlistConfigurationError extends Schema.TaggedError<DeploymentAllowlistConfigurationError>()(
  'DeploymentAllowlistConfigurationError',
  {
    code: Schema.Literal('deployment_allowlist_invalid'),
    reason: Schema.String,
  },
) {}

export interface DeploymentAllowlistEntry {
  readonly appId: OntosDeploymentAppId;
  readonly contractUrl: string;
}

export interface DeploymentAllowlist {
  readonly entries: readonly DeploymentAllowlistEntry[];
  readonly revision: string;
}

type JsonValue = Schema.Schema.Type<typeof Schema.Json>;
const JsonObjectSchema = Schema.Record(Schema.String, Schema.Json);
type JsonObject = Schema.Schema.Type<typeof JsonObjectSchema>;

export interface DeploymentAllowlistInput {
  readonly environment: JsonValue;
  readonly overlay: JsonValue;
  readonly topology: JsonValue;
}

const invalid = (reason: string): DeploymentAllowlistConfigurationError =>
  new DeploymentAllowlistConfigurationError({
    code: 'deployment_allowlist_invalid',
    reason,
  });

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Build-time globals and JSON files enter here and are decoded immediately by the Json object schema.
const object = (
  value: unknown,
): Effect.Effect<JsonObject, DeploymentAllowlistConfigurationError> => {
  if (!Predicate.isObjectKeyword(value) || value === null || Array.isArray(value)) {
    return Effect.fail(invalid('expected object'));
  }
  return Schema.decodeUnknownEffect(JsonObjectSchema)(value).pipe(
    Effect.mapError((error) => invalid(error.message)),
  );
};

const member = (
  record: Readonly<Record<string, JsonValue | undefined>>,
  key: string,
): Effect.Effect<JsonValue, DeploymentAllowlistConfigurationError> => {
  const value = record[key];
  return value === undefined
    ? Effect.fail(invalid(`missing JSON member ${key}`))
    : Effect.succeed(value);
};

const isLoopback = (hostname: string): boolean =>
  hostname === 'localhost' ||
  hostname === '127.0.0.1' ||
  hostname === '[::1]' ||
  hostname.endsWith('.localhost');

const normalizeContractUrl = <Value>(
  value: Value,
  environment: string,
): Effect.Effect<string, DeploymentAllowlistConfigurationError> => {
  if (!Predicate.isString(value)) {
    return Effect.fail(invalid('contract URL must be a string'));
  }

  return Effect.sync(() => URL.parse(value)).pipe(
    Effect.flatMap((url) => {
      if (url === null) {
        return Effect.fail(invalid('Invalid URL'));
      }
      if (
        url.username !== '' ||
        url.password !== '' ||
        url.hash !== '' ||
        url.search !== '' ||
        url.pathname !== ONTOS_MODULE_CONTRACT_PATH
      ) {
        return Effect.fail(invalid('contract URL contains unsupported authority or path data'));
      }
      const developmentLoopback =
        environment === 'development' && url.protocol === 'http:' && isLoopback(url.hostname);
      if (url.protocol !== 'https:' && !developmentLoopback) {
        return Effect.fail(invalid('contract URL must use HTTPS outside loopback development'));
      }
      return Effect.succeed(url.href);
    }),
  );
};

const decodeAppId = (
  value: unknown,
): Effect.Effect<OntosDeploymentAppId, DeploymentAllowlistConfigurationError> =>
  Schema.decodeUnknownEffect(OntosDeploymentAppIdSchema)(value).pipe(
    Effect.mapError((error) => invalid(error.message)),
  );

/** Decodes the generated topology/overlay pairing. Reachability never adds an entry. */
export const deriveDeploymentAllowlist = (
  input: DeploymentAllowlistInput,
): Effect.Effect<DeploymentAllowlist, DeploymentAllowlistConfigurationError> =>
  Effect.gen(function* () {
    const { environment } = input;
    if (!Predicate.isString(environment) || environment.length === 0) {
      return yield* invalid('environment is missing');
    }

    const topology = yield* object(input.topology);
    const overlay = yield* object(input.overlay);
    const verticals = topology['verticals'];
    if (overlay['environment'] !== environment || !Array.isArray(verticals)) {
      return yield* invalid('topology and environment disagree');
    }

    const appIds: OntosDeploymentAppId[] = [];
    for (const entry of verticals) {
      const vertical = yield* object(entry);
      if (vertical['kind'] !== 'vertical') {
        return yield* invalid('topology contains an invalid vertical');
      }
      appIds.push(yield* decodeAppId(vertical['id']));
    }
    if (new Set(appIds).size !== appIds.length) {
      return yield* invalid('topology contains duplicate app IDs');
    }

    const configured = yield* object(yield* member(overlay, 'ontosModuleManifests'));
    const configuredIds = Object.keys(configured).toSorted();
    const expectedIds = [...appIds].toSorted();
    if (JSON.stringify(configuredIds) !== JSON.stringify(expectedIds)) {
      return yield* invalid('allowlist keys do not exactly match topology verticals');
    }

    const normalizedUrls = new Set<string>();
    const entries: DeploymentAllowlistEntry[] = [];
    for (const appId of expectedIds) {
      const contractUrl = yield* normalizeContractUrl(configured[appId], environment);
      if (normalizedUrls.has(contractUrl)) {
        return yield* invalid('allowlist contains duplicate normalized URLs');
      }
      normalizedUrls.add(contractUrl);
      entries.push(Object.freeze({ appId, contractUrl }));
    }

    const revision = JSON.stringify({
      entries,
      environment,
      schemaVersion: overlay['schemaVersion'],
    });
    return Object.freeze({ entries: Object.freeze(entries), revision });
  });

declare const ULTRAMODERN_MODULE_DEPLOYMENT_ALLOWLIST: unknown;

export const deploymentAllowlist = Effect.suspend(() =>
  Effect.gen(function* () {
    const injected = yield* object(ULTRAMODERN_MODULE_DEPLOYMENT_ALLOWLIST);
    return yield* deriveDeploymentAllowlist({
      environment: yield* member(injected, 'environment'),
      overlay: yield* member(injected, 'overlay'),
      topology: yield* member(injected, 'topology'),
    });
  }),
);
