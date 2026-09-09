import { getOrThrow as getResultOrThrow, isSuccess as isResultSuccess } from 'effect/Result';
import {
  Literal,
  NonEmptyString,
  Struct,
  Trim,
  URLFromString,
  decodeResult,
  decodeUnknownResult,
  isMinLength,
  makeFilter,
} from 'effect/Schema';

import {
  DeploymentAllowlistOverlaySchema,
  DeploymentAllowlistTopologySchema,
} from './api/modules/deployment-allowlist.ts';
import type { DeploymentAllowlistOverlay, DeploymentAllowlistTopology } from './api/modules/deployment-allowlist.ts';

const contractPath = '/.well-known/ontos-module-manifest.json';

type EnvironmentReader = (name: string) => string | undefined;

const DeploymentPublicUrlVerticalSchema = Struct({
  cloudflare: Struct({
    publicUrlEnv: NonEmptyString,
  }),
  id: NonEmptyString,
});

export interface ModuleDeploymentAllowlistBuildInput {
  readonly cloudflareDeployEnabled: boolean;
  readonly developmentOverlay: unknown;
  readonly readEnvironment: EnvironmentReader;
  readonly topology: unknown;
}

export interface ModuleDeploymentAllowlistBuildOutput {
  readonly environment: string;
  readonly overlay: DeploymentAllowlistOverlay;
  readonly topology: DeploymentAllowlistTopology;
}

const productionOriginSchema = (environmentName: string, environment: string) =>
  Trim.check(
    isMinLength(1, {
      message: `${environmentName} is required for ${environment} module discovery`,
    }),
    makeFilter((value) => {
      const origin = URL.parse(value);
      return origin !== null &&
        origin.protocol === 'https:' &&
        origin.username === '' &&
        origin.password === '' &&
        origin.hash === '' &&
        origin.search === ''
        ? undefined
        : `${environmentName} must be a credential-free HTTPS origin`;
    }),
  );

/** Produces immutable build input; production URLs come only from deployment configuration. */
export const createModuleDeploymentAllowlistBuildInput = ({
  cloudflareDeployEnabled,
  developmentOverlay,
  readEnvironment,
  topology,
}: ModuleDeploymentAllowlistBuildInput): ModuleDeploymentAllowlistBuildOutput => {
  const parsedDevelopmentOverlay = getResultOrThrow(
    decodeUnknownResult(DeploymentAllowlistOverlaySchema, {
      onExcessProperty: 'preserve',
    })(developmentOverlay),
  );
  const parsedTopology = getResultOrThrow(
    decodeUnknownResult(DeploymentAllowlistTopologySchema, {
      onExcessProperty: 'preserve',
    })(topology),
  );
  const configuredEnvironment = getResultOrThrow(
    decodeUnknownResult(Trim)(readEnvironment('ULTRAMODERN_DEPLOYMENT_ENVIRONMENT') ?? ''),
  );
  const configuredEnvironmentResult = decodeResult(NonEmptyString)(configuredEnvironment);
  let environment = cloudflareDeployEnabled ? 'production' : 'development';
  if (isResultSuccess(configuredEnvironmentResult)) {
    environment = configuredEnvironmentResult.success;
  }

  if (environment === 'development') {
    const development = getResultOrThrow(
      decodeUnknownResult(Literal('development'))(parsedDevelopmentOverlay.environment),
    );
    return Object.freeze({
      environment: development,
      overlay: parsedDevelopmentOverlay,
      topology: parsedTopology,
    });
  }

  const ontosModuleManifests = Object.fromEntries(
    parsedTopology.verticals.map((vertical) => {
      const deploymentVertical = getResultOrThrow(decodeUnknownResult(DeploymentPublicUrlVerticalSchema)(vertical));
      const environmentName = deploymentVertical.cloudflare.publicUrlEnv;
      const configuredOrigin = getResultOrThrow(
        decodeUnknownResult(productionOriginSchema(environmentName, environment))(
          readEnvironment(environmentName) ?? '',
        ),
      );
      const origin = getResultOrThrow(decodeResult(URLFromString)(configuredOrigin));
      return [deploymentVertical.id, new URL(contractPath, origin).href] as const;
    }),
  );
  const overlay = getResultOrThrow(
    decodeUnknownResult(DeploymentAllowlistOverlaySchema)({
      environment,
      ontosModuleManifests,
      schemaVersion: parsedDevelopmentOverlay.schemaVersion,
    }),
  );
  Object.freeze(overlay.ontosModuleManifests);
  Object.freeze(overlay);
  return Object.freeze({ environment, overlay, topology: parsedTopology });
};
