import { fn as effectFn, gen as effectGen, mapError } from 'effect/Effect';
import {
  Array as ArraySchema,
  Json,
  Literal,
  NonEmptyString,
  Record as RecordSchema,
  String as StringSchema,
  Struct,
  TaggedError,
  brand,
  decodeTo,
  decodeUnknownEffect,
  encodeEffect,
  fromJsonString,
  isPattern,
  makeFilter,
  optionalKey,
} from 'effect/Schema';
import type { FilterIssue, Schema } from 'effect/Schema';

const ONTOS_MODULE_CONTRACT_PATH =
  '/.well-known/ontos-module-manifest.json' as const;
const deploymentIdPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const OntosDeploymentAppIdSchema = StringSchema.check(
  isPattern(deploymentIdPattern)
).pipe(brand('OntosDeploymentAppId'), decodeTo(StringSchema));
type OntosDeploymentAppId = typeof OntosDeploymentAppIdSchema.Type;

class DeploymentAllowlistConfigurationError extends TaggedError<DeploymentAllowlistConfigurationError>()(
  'DeploymentAllowlistConfigurationError',
  {
    cause: StringSchema,
    code: Literal('deployment_allowlist_invalid'),
    reason: StringSchema,
  }
) {}

interface DeploymentAllowlistEntry {
  readonly appId: OntosDeploymentAppId;
  readonly contractUrl: string;
}

export interface DeploymentAllowlist {
  readonly entries: readonly DeploymentAllowlistEntry[];
  readonly revision: string;
}

const DeploymentAllowlistVerticalSchema = Struct({
  cloudflare: optionalKey(
    Struct({
      publicUrlEnv: NonEmptyString,
    })
  ),
  id: OntosDeploymentAppIdSchema,
  kind: Literal('vertical'),
});

export const DeploymentAllowlistTopologySchema = Struct({
  verticals: ArraySchema(DeploymentAllowlistVerticalSchema),
});

export type DeploymentAllowlistTopology = Schema.Type<
  typeof DeploymentAllowlistTopologySchema
>;

export const DeploymentAllowlistOverlaySchema = Struct({
  environment: NonEmptyString,
  ontosModuleManifests: RecordSchema(OntosDeploymentAppIdSchema, StringSchema),
  schemaVersion: Json,
});

export type DeploymentAllowlistOverlay = Schema.Type<
  typeof DeploymentAllowlistOverlaySchema
>;

export interface DeploymentAllowlistInput {
  readonly environment: unknown;
  readonly overlay: unknown;
  readonly topology: unknown;
}

const isLoopback = (hostname: string): boolean =>
  hostname === 'localhost' ||
  hostname === '127.0.0.1' ||
  hostname === '[::1]' ||
  hostname.endsWith('.localhost');

const isContractDocumentUrl = (url: URL): boolean =>
  url.username === '' &&
  url.password === '' &&
  url.hash === '' &&
  url.search === '' &&
  url.pathname === ONTOS_MODULE_CONTRACT_PATH;

const normalizedContractUrl = (
  value: string,
  environment: string
): string | undefined => {
  const url = URL.parse(value);
  if (url === null || !isContractDocumentUrl(url)) {
    return undefined;
  }
  const developmentLoopback =
    environment === 'development' &&
    url.protocol === 'http:' &&
    isLoopback(url.hostname);
  return url.protocol === 'https:' || developmentLoopback
    ? url.href
    : undefined;
};

const contractUrlIssues = (
  overlay: DeploymentAllowlistOverlay,
  environment: string
): FilterIssue[] => {
  const issues: FilterIssue[] = [];
  const normalizedUrls = new Set<string>();
  for (const [appId, contractUrl] of Object.entries(
    overlay.ontosModuleManifests
  )) {
    const normalized = normalizedContractUrl(contractUrl, environment);
    if (normalized === undefined) {
      issues.push({
        issue: 'contract URL is invalid for this deployment environment',
        path: ['overlay', 'ontosModuleManifests', appId],
      });
    } else if (normalizedUrls.has(normalized)) {
      issues.push({
        issue: 'allowlist contains duplicate normalized URLs',
        path: ['overlay', 'ontosModuleManifests', appId],
      });
    } else {
      normalizedUrls.add(normalized);
    }
  }
  return issues;
};

const DeploymentAllowlistInputSchema = Struct({
  environment: NonEmptyString,
  overlay: DeploymentAllowlistOverlaySchema,
  topology: DeploymentAllowlistTopologySchema,
}).check(
  makeFilter((input) => {
    const issues: FilterIssue[] = [];
    if (input.overlay.environment !== input.environment) {
      issues.push({
        issue: 'topology and environment disagree',
        path: ['overlay', 'environment'],
      });
    }

    const expectedIds = new Set<string>();
    for (const [index, vertical] of input.topology.verticals.entries()) {
      if (expectedIds.has(vertical.id)) {
        issues.push({
          issue: 'topology contains duplicate app IDs',
          path: ['topology', 'verticals', index, 'id'],
        });
      }
      expectedIds.add(vertical.id);
    }

    const configuredIds = Object.keys(input.overlay.ontosModuleManifests);
    for (const configuredId of configuredIds) {
      if (!expectedIds.has(configuredId)) {
        issues.push({
          issue: 'allowlist contains an app ID absent from topology',
          path: ['overlay', 'ontosModuleManifests', configuredId],
        });
      }
    }
    for (const expectedId of expectedIds) {
      if (!Object.hasOwn(input.overlay.ontosModuleManifests, expectedId)) {
        issues.push({
          issue: 'allowlist omits a topology app ID',
          path: ['overlay', 'ontosModuleManifests', expectedId],
        });
      }
    }

    issues.push(...contractUrlIssues(input.overlay, input.environment));
    return issues;
  })
);

const DeploymentAllowlistRevisionSchema = fromJsonString(
  Struct({
    entries: ArraySchema(
      Struct({
        appId: OntosDeploymentAppIdSchema,
        contractUrl: StringSchema,
      })
    ),
    environment: NonEmptyString,
    schemaVersion: Json,
  })
);

const DeploymentAllowlistInjectionSchema = DeploymentAllowlistInputSchema;

const invalid = (cause: unknown) =>
  new DeploymentAllowlistConfigurationError({
    cause: String(cause),
    code: 'deployment_allowlist_invalid',
    reason: 'The generated module deployment allowlist is invalid',
  });

/** Decodes the generated topology/overlay pairing. Reachability never adds an entry. */
export const deriveDeploymentAllowlist = effectFn(
  'DeploymentAllowlist.deriveDeploymentAllowlist'
)(function* deriveDeploymentAllowlist(input: DeploymentAllowlistInput) {
  const decoded = yield* decodeUnknownEffect(DeploymentAllowlistInputSchema, {
    onExcessProperty: 'preserve',
  })(input).pipe(mapError(invalid));
  const entries: DeploymentAllowlistEntry[] = [];
  for (const appId of decoded.topology.verticals
    .map(({ id }) => id)
    .toSorted()) {
    const configuredUrl = decoded.overlay.ontosModuleManifests[appId];
    if (configuredUrl === undefined) {
      return yield* invalid(`allowlist omits topology app ID ${appId}`);
    }
    const contractUrl = normalizedContractUrl(
      configuredUrl,
      decoded.environment
    );
    if (contractUrl === undefined) {
      return yield* invalid(`allowlist contains an invalid URL for ${appId}`);
    }
    entries.push(Object.freeze({ appId, contractUrl }));
  }
  const revision = yield* encodeEffect(DeploymentAllowlistRevisionSchema)({
    entries,
    environment: decoded.environment,
    schemaVersion: decoded.overlay.schemaVersion,
  }).pipe(mapError(invalid));
  return Object.freeze({ entries: Object.freeze(entries), revision });
});

declare const ULTRAMODERN_MODULE_DEPLOYMENT_ALLOWLIST: unknown;

export const deploymentAllowlist = effectGen(
  function* deploymentAllowlistProgram() {
    const injected = yield* decodeUnknownEffect(
      DeploymentAllowlistInjectionSchema
    )(ULTRAMODERN_MODULE_DEPLOYMENT_ALLOWLIST).pipe(mapError(invalid));
    return yield* deriveDeploymentAllowlist(injected);
  }
);
