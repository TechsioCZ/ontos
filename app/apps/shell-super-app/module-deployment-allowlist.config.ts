import { Predicate, Schema } from 'effect';

const contractPath = '/.well-known/ontos-module-manifest.json';

type EnvironmentReader = (name: string) => string | undefined;
type JsonValue = Schema.Schema.Type<typeof Schema.Json>;
type JsonObject = Readonly<Record<string, JsonValue>>;
const JsonObjectSchema = Schema.Record(Schema.String, Schema.Json);

export interface ModuleDeploymentAllowlistBuildInput {
  readonly cloudflareDeployEnabled: boolean;
  readonly developmentOverlay: JsonValue;
  readonly readEnvironment: EnvironmentReader;
  readonly topology: JsonValue;
}

export type ModuleDeploymentAllowlistBuildOutput =
  | {
      readonly environment: 'development';
      readonly overlay: JsonValue;
      readonly topology: JsonValue;
    }
  | {
      readonly environment: string;
      readonly ontosModuleManifests: Readonly<Record<string, string>>;
      readonly topology: JsonValue;
    };

const object = (value: JsonValue, label: string): JsonObject => {
  if (!Predicate.isObjectKeyword(value) || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return Schema.decodeUnknownSync(JsonObjectSchema)(value);
};

const publicUrlEnvironmentName = (vertical: JsonObject): string => {
  const direct = object(vertical['cloudflare'], 'vertical cloudflare metadata')['publicUrlEnv'];
  if (!Predicate.isString(direct) || direct.length === 0) {
    throw new TypeError('vertical Cloudflare public URL environment name is missing');
  }
  return direct;
};

/** Produces immutable build input; production URLs come only from deployment configuration. */
export const createModuleDeploymentAllowlistBuildInput = ({
  cloudflareDeployEnabled,
  developmentOverlay,
  readEnvironment,
  topology,
}: ModuleDeploymentAllowlistBuildInput): ModuleDeploymentAllowlistBuildOutput => {
  const configuredEnvironment = readEnvironment('ULTRAMODERN_DEPLOYMENT_ENVIRONMENT')?.trim();
  let environment = cloudflareDeployEnabled ? 'production' : 'development';
  if (configuredEnvironment !== undefined && configuredEnvironment.length > 0) {
    environment = configuredEnvironment;
  }
  if (environment === 'development') {
    const overlay = object(developmentOverlay, 'development overlay');
    if (overlay['environment'] !== 'development') {
      throw new TypeError('development overlay environment is invalid');
    }
    return Object.freeze({ environment, overlay, topology });
  }

  const topologyObject = object(topology, 'reference topology');
  const { verticals } = topologyObject;
  if (!Array.isArray(verticals)) {
    throw new TypeError('reference topology verticals must be an array');
  }
  const ontosModuleManifests = Object.fromEntries(
    verticals.map((value) => {
      const vertical = object(value, 'topology vertical');
      const appId = vertical['id'];
      if (!Predicate.isString(appId) || appId.length === 0) {
        throw new TypeError('topology vertical app ID is missing');
      }
      const environmentName = publicUrlEnvironmentName(vertical);
      const configuredOrigin = readEnvironment(environmentName)?.trim();
      if (configuredOrigin === undefined || configuredOrigin.length === 0) {
        throw new TypeError(`${environmentName} is required for ${environment} module discovery`);
      }
      const origin = new URL(configuredOrigin);
      if (
        origin.protocol !== 'https:' ||
        origin.username !== '' ||
        origin.password !== '' ||
        origin.hash !== '' ||
        origin.search !== ''
      ) {
        throw new TypeError(`${environmentName} must be a credential-free HTTPS origin`);
      }
      return [appId, new URL(contractPath, origin).href] as const;
    }),
  );
  const development = object(developmentOverlay, 'development overlay');
  const overlay = Object.freeze({
    environment,
    ontosModuleManifests: Object.freeze(ontosModuleManifests),
    schemaVersion: development['schemaVersion'],
  });
  return Object.freeze({ environment, overlay, topology });
};
