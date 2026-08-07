const contractPath = '/.well-known/ontos-module-manifest.json';

type EnvironmentReader = (name: string) => string | undefined;

export interface ModuleDeploymentAllowlistBuildInput {
  readonly cloudflareDeployEnabled: boolean;
  readonly developmentOverlay: unknown;
  readonly readEnvironment: EnvironmentReader;
  readonly topology: unknown;
}

const object = (value: unknown, label: string): Readonly<Record<string, unknown>> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
};

const publicUrlEnvironmentName = (vertical: Readonly<Record<string, unknown>>): string => {
  const direct = object(vertical['cloudflare'], 'vertical cloudflare metadata')['publicUrlEnv'];
  if (typeof direct !== 'string' || direct.length === 0) {
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
}: ModuleDeploymentAllowlistBuildInput): Readonly<Record<string, unknown>> => {
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
      if (typeof appId !== 'string' || appId.length === 0) {
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
