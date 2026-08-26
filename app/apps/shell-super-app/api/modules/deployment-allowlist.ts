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

export interface DeploymentAllowlistInput {
  readonly environment: JsonValue;
  readonly overlay: JsonValue;
  readonly topology: JsonValue;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Build-time globals and JSON files enter here and are decoded immediately by the Json object schema.
const object = (value: unknown) => {
  if (!Predicate.isObjectKeyword(value) || value === null || Array.isArray(value)) {
    throw new TypeError('expected object');
  }
  return Schema.decodeUnknownSync(JsonObjectSchema)(value);
};

const member = (
  record: Readonly<Record<string, JsonValue | undefined>>,
  key: string,
): JsonValue => {
  const value = record[key];
  if (value === undefined) {
    throw new TypeError(`missing JSON member ${key}`);
  }
  return value;
};

const invalid = () =>
  new DeploymentAllowlistConfigurationError({
    code: 'deployment_allowlist_invalid',
    reason: 'The generated module deployment allowlist is invalid',
  });

const isLoopback = (hostname: string): boolean =>
  hostname === 'localhost' ||
  hostname === '127.0.0.1' ||
  hostname === '[::1]' ||
  hostname.endsWith('.localhost');

const normalizeContractUrl = <Value>(value: Value, environment: string): string => {
  if (!Predicate.isString(value)) {
    throw new TypeError('contract URL must be a string');
  }
  const url = new URL(value);
  if (
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== '' ||
    url.search !== '' ||
    url.pathname !== ONTOS_MODULE_CONTRACT_PATH
  ) {
    throw new TypeError('contract URL contains unsupported authority or path data');
  }
  const developmentLoopback =
    environment === 'development' && url.protocol === 'http:' && isLoopback(url.hostname);
  if (url.protocol !== 'https:' && !developmentLoopback) {
    throw new TypeError('contract URL must use HTTPS outside loopback development');
  }
  return url.href;
};

/** Decodes the generated topology/overlay pairing. Reachability never adds an entry. */
export const deriveDeploymentAllowlist = (
  input: DeploymentAllowlistInput,
): Effect.Effect<DeploymentAllowlist, DeploymentAllowlistConfigurationError> =>
  Effect.try({
    catch: invalid,
    try: () => {
      const { environment } = input;
      if (!Predicate.isString(environment) || environment.length === 0) {
        throw new TypeError('environment is missing');
      }
      const topology = object(input.topology);
      const overlay = object(input.overlay);
      if (overlay['environment'] !== environment || !Array.isArray(topology['verticals'])) {
        throw new TypeError('topology and environment disagree');
      }
      const appIds = topology['verticals'].map((entry): OntosDeploymentAppId => {
        const vertical = object(entry);
        if (vertical['kind'] !== 'vertical') {
          throw new TypeError('topology contains an invalid vertical');
        }
        return Schema.decodeUnknownSync(OntosDeploymentAppIdSchema)(vertical['id']);
      });
      if (new Set(appIds).size !== appIds.length) {
        throw new TypeError('topology contains duplicate app IDs');
      }
      const configured = object(member(overlay, 'ontosModuleManifests'));
      const configuredIds = Object.keys(configured).toSorted();
      const expectedIds = [...appIds].toSorted();
      if (JSON.stringify(configuredIds) !== JSON.stringify(expectedIds)) {
        throw new TypeError('allowlist keys do not exactly match topology verticals');
      }
      const normalizedUrls = new Set<string>();
      const entries = expectedIds.map((appId) => {
        const contractUrl = normalizeContractUrl(configured[appId], environment);
        if (normalizedUrls.has(contractUrl)) {
          throw new TypeError('allowlist contains duplicate normalized URLs');
        }
        normalizedUrls.add(contractUrl);
        return Object.freeze({ appId, contractUrl });
      });
      const revision = JSON.stringify({
        entries,
        environment,
        schemaVersion: overlay['schemaVersion'],
      });
      return Object.freeze({ entries: Object.freeze(entries), revision });
    },
  });

declare const ULTRAMODERN_MODULE_DEPLOYMENT_ALLOWLIST: unknown;

export const deploymentAllowlist = Effect.suspend(() => {
  const injected = object(ULTRAMODERN_MODULE_DEPLOYMENT_ALLOWLIST);
  return deriveDeploymentAllowlist({
    environment: member(injected, 'environment'),
    overlay: member(injected, 'overlay'),
    topology: member(injected, 'topology'),
  });
});
