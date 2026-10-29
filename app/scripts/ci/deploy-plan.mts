#!/usr/bin/env node
/// <reference lib="esnext" />
/// <reference types="node" />
// The single source of truth for what a stage demo deploy rebuilds. Every unit, the outbox host, the storefront and
// the database preparation get a content digest over the committed inputs that can change their output; the plan
// then reuses only what a trusted earlier run already built or left live under that exact digest. Plan flags are
// upper bounds: the release re-checks live state and recomputes these digests at its own clean HEAD.
// Dependency-free (Node builtins and git): the plan job runs it before any workspace install.
import { createHash, createHmac } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { createGitHubClient, mergeLedgers, readTrustedLedgers, unitRecordHistory } from './release-ledger.mts';
import type {
  DatabaseRecord,
  ReleaseLedger,
  ReleaseReceipt,
  RunIdentity,
  TrustedArtifact,
  UnitRecord,
} from './release-ledger.mts';
import {
  ClosureInputError,
  createClosureGraph,
  importClosure,
  isJsonObject,
  matchTrackedFiles,
  packageClosure,
  parseJsonObject,
  readRepositorySnapshot,
  rootBuildInputs,
} from './unit-closure.mts';
import type { ClosureGraph, RepositorySnapshot } from './unit-closure.mts';

/** Bumping this invalidates every digest, receipt and ledger record at once. */
export const DIGEST_VERSION = 'ontos-deploy-plan-v1';
/** Build environment every unit digest covers; plan, build and release must run with the same values. */
export const DIGEST_ENV_KEYS = Object.freeze([
  'CLOUDFLARE_ACCOUNT_ID',
  'DEPLOY_TARGET',
  'ULTRAMODERN_DEPLOYMENT_ENVIRONMENT',
  'ULTRAMODERN_DISABLE_BUILD_TS_CHECKER',
  'WORKERS_DEV_SUBDOMAIN',
]);
/** The storefront build's literal environment. */
export const STOREFRONT_ENV_KEYS = Object.freeze([
  'ONTOS_SHELL_URL',
  'ONTOS_SHELL_WORKER_NAME',
  'STOREFRONT_CATALOG_KV_ID',
  'STOREFRONT_IMAGE_HOSTS',
]);
const SHELL_ID = 'shell-super-app';
/** The only unit whose release secrets are derived (from the Shell's) rather than stored. */
const DERIVED_SECRETS_UNIT = 'projects';
const STOREFRONT_PACKAGE = 'akros-storefront';
/** Workspace-relative inputs every unit, the storefront and the host share. */
const GLOBAL_INPUT_FILES = Object.freeze([
  '.mise.toml',
  'module-federation.shared.ts',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'scripts/ci/build-edge-unit.sh',
  'scripts/ci/deploy-plan.mts',
  'scripts/ci/release-ledger.mts',
  'scripts/ci/unit-closure.mts',
  'tsconfig.base.json',
]);
const GLOBAL_INPUT_GLOBS = Object.freeze(['patches/**', 'topology/**', '!topology/application-release-intent.json']);
/** Repository-relative: the install recipe every build runs. */
const REPOSITORY_INPUT_GLOBS = Object.freeze(['.github/actions/install-app/**']);
/** The upload recipe: what turns a unit's build output into its immutable Workers. */
const RELEASE_RECIPE_ENTRIES = Object.freeze([
  'scripts/immutable-application-release.mts',
  'scripts/immutable-shell-release.mts',
]);
const SECRET_PREPARER_ENTRY = 'scripts/prepare-stage-release-secrets.mts';
const HOST_ENTRY = 'scripts/outbox-worker-host.generated.mts';
export const HOST_INPUTS_FILE = 'scripts/ci/outbox-host-inputs.json';
export const DATABASE_INPUTS_FILE = 'scripts/ci/database-preparation-inputs.json';
const HOST_OWNER_IMPORT = /from '(?<packageName>@[\w.-]+\/[\w.-]+)\/outbox-worker-host'/gu;
const TOPOLOGY_FILE = 'topology/reference-topology.json';
const RELEASE_INTENT_FILE = 'topology/application-release-intent.json';
/** How many of the newest trusted ledgers the plan merges. */
export const LEDGER_LOOKBACK = 5;
/** How many trusted artifacts of one name the plan weighs when it needs the one built at a given revision. */
const ARTIFACT_CANDIDATES = 10;
const LOOKUP_CONCURRENCY = 8;
const UNAVAILABLE = 'unavailable';

export class DeployPlanError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'DeployPlanError';
  }
}

export type Environment = Readonly<Record<string, string | undefined>>;
type SecretFingerprints = Readonly<Record<string, string>>;

/** sha256 over the sorted, de-duplicated lines. */
const digestLines = (lines: readonly string[]): string =>
  createHash('sha256')
    .update(`${lines.join('\n')}\n`)
    .digest('hex');

const sortedLines = (lines: Iterable<string>): string[] => [...new Set(lines)].toSorted();

/** JSON with object keys sorted at every depth, so equal values always serialize identically. */
export const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map((item: unknown) => canonicalJson(item)).join(',')}]`;
  }
  if (isJsonObject(value)) {
    const members = Object.keys(value)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${members.join(',')}}`;
  }
  return JSON.stringify(value ?? null);
};

/**
 * HMAC fingerprints of each unit's release secrets. A secret is bound only on a fresh upload, so rotating one must
 * change the unit's digest. Projects' secrets are derived from the Shell's, so its fingerprint covers both.
 */
export const computeSecretFingerprints = ({
  key,
  rawSecrets,
  unitIds,
}: {
  readonly key: string;
  readonly rawSecrets: string;
  readonly unitIds: readonly string[];
}): Record<string, string> => {
  let raw: unknown;
  try {
    raw = JSON.parse(rawSecrets);
  } catch {
    throw new DeployPlanError('the release secrets are not valid JSON');
  }
  if (!isJsonObject(raw)) {
    throw new DeployPlanError('the release secrets must be an owner-keyed JSON object');
  }
  const owned = (owner: string): unknown => (Object.hasOwn(raw, owner) ? raw[owner] : null);
  return Object.fromEntries(
    unitIds.map((unitId) => {
      const material =
        unitId === DERIVED_SECRETS_UNIT
          ? { [DERIVED_SECRETS_UNIT]: owned(DERIVED_SECRETS_UNIT), [SHELL_ID]: owned(SHELL_ID) }
          : owned(unitId);
      return [
        unitId,
        createHmac('sha256', key)
          .update(`${DIGEST_VERSION}\n${unitId}\n${canonicalJson(material)}`)
          .digest('hex'),
      ];
    }),
  );
};

export interface TopologyUnit {
  readonly id: string;
  readonly package: string;
  /** Workspace-relative directory. */
  readonly path: string;
}

export interface DigestContext {
  /** Glob plus import closure. */
  readonly fileLines: (globs: readonly string[], seeds: readonly string[]) => string[];
  /** Lines every unit and the storefront share. */
  readonly globalLines: () => readonly string[];
  readonly graph: ClosureGraph;
  /** Unit ids compiled into the outbox host. */
  readonly hostOwners: () => readonly string[];
  /** The Shell plus every released module, in release order. */
  readonly served: readonly TopologyUnit[];
  readonly snapshot: RepositorySnapshot;
  /** Closure lines of one unit. */
  readonly unitBlobLines: (unitId: string) => readonly string[];
  /** Every topology unit by id. */
  readonly units: ReadonlyMap<string, TopologyUnit>;
}

/** `blob` lines of repository-relative files, or `absent` for an untracked one. */
const blobLines = (snapshot: RepositorySnapshot, files: Iterable<string>): string[] =>
  [...files].map((file) => {
    const oid = snapshot.blobs.get(file);
    return oid === undefined ? `absent ${file}` : `blob ${file} ${oid}`;
  });

const topologyUnit = (entry: unknown): TopologyUnit => {
  if (
    !isJsonObject(entry) ||
    typeof entry.id !== 'string' ||
    typeof entry.package !== 'string' ||
    typeof entry.path !== 'string'
  ) {
    throw new ClosureInputError(`${TOPOLOGY_FILE} has a unit without id, package and path`);
  }
  return { id: entry.id, package: entry.package, path: entry.path };
};

const contexts = new Map<string, DigestContext>();

/** Reads one commit of the `app` workspace once and memoizes every closure derived from it. */
export const createDigestContext = (workspaceRoot: string, revision = 'HEAD'): DigestContext => {
  const snapshot = readRepositorySnapshot(workspaceRoot, revision);
  const cacheKey = `${snapshot.repoRoot}\0${snapshot.appPrefix}\0${snapshot.revision}`;
  const cached = contexts.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  const { appPrefix } = snapshot;
  const graph = createClosureGraph(snapshot);
  const topology = parseJsonObject(`${appPrefix}${TOPOLOGY_FILE}`, snapshot.read(`${appPrefix}${TOPOLOGY_FILE}`));
  const intent = parseJsonObject(
    `${appPrefix}${RELEASE_INTENT_FILE}`,
    snapshot.read(`${appPrefix}${RELEASE_INTENT_FILE}`),
  );
  const verticals: unknown[] = Array.isArray(topology.verticals) ? topology.verticals : [];
  const units = new Map([topology.shell, ...verticals].map(topologyUnit).map((unit) => [unit.id, unit]));
  const modules: unknown[] = Array.isArray(intent.modules) ? intent.modules : [];
  const served = [SHELL_ID, ...modules.map((module) => (isJsonObject(module) ? module.appId : undefined))].map((id) => {
    const unit = typeof id === 'string' ? units.get(id) : undefined;
    if (unit === undefined) {
      throw new ClosureInputError(`${RELEASE_INTENT_FILE} releases ${String(id)}, which the topology does not declare`);
    }
    return unit;
  });
  const fileLines = (globs: readonly string[], seeds: readonly string[]): string[] => {
    const matched = matchTrackedFiles(snapshot, appPrefix, globs);
    const closure = importClosure(graph, [...matched, ...seeds.map((seed) => `${appPrefix}${seed}`)]);
    return blobLines(snapshot, [...matched, ...closure.files]);
  };
  let globals: readonly string[] | undefined;
  const unitBlobs = new Map<string, readonly string[]>();
  let owners: readonly string[] | undefined;
  const readHostOwners = (): readonly string[] => {
    const entry = snapshot.read(`${appPrefix}${HOST_ENTRY}`) ?? '';
    const found = [...entry.matchAll(HOST_OWNER_IMPORT)].map(({ groups }) => {
      const packageName = groups?.packageName;
      const unit = [...units.values()].find((candidate) => candidate.package === packageName);
      if (unit === undefined) {
        throw new ClosureInputError(`${HOST_ENTRY} hosts ${String(packageName)}, which is no topology unit`);
      }
      return unit.id;
    });
    if (found.length === 0) {
      throw new ClosureInputError(`${HOST_ENTRY} names no outbox host owners`);
    }
    return found;
  };
  const context: DigestContext = {
    fileLines,
    globalLines: () => {
      globals ??= sortedLines([
        ...blobLines(
          snapshot,
          GLOBAL_INPUT_FILES.map((file) => `${appPrefix}${file}`),
        ),
        ...blobLines(snapshot, matchTrackedFiles(snapshot, appPrefix, GLOBAL_INPUT_GLOBS)),
        ...blobLines(snapshot, matchTrackedFiles(snapshot, '', REPOSITORY_INPUT_GLOBS)),
        ...blobLines(
          snapshot,
          [...graph.packages.values()].map((workspacePackage) => `${workspacePackage.dir}/package.json`),
        ),
        ...blobLines(
          snapshot,
          rootBuildInputs(
            graph,
            [...units.values()].map((unit) => `${appPrefix}${unit.path}`),
          ),
        ),
        ...fileLines([], RELEASE_RECIPE_ENTRIES),
      ]);
      return globals;
    },
    graph,
    hostOwners: () => {
      owners ??= readHostOwners();
      return owners;
    },
    served,
    snapshot,
    unitBlobLines: (unitId) => {
      const cachedLines = unitBlobs.get(unitId);
      if (cachedLines !== undefined) {
        return cachedLines;
      }
      const unit = units.get(unitId);
      if (unit === undefined) {
        throw new ClosureInputError(`unknown unit ${unitId}`);
      }
      const closure = packageClosure(graph, [{ kind: 'dir', path: `${appPrefix}${unit.path}` }]);
      const lines = [
        ...blobLines(snapshot, closure.files),
        ...(unitId === DERIVED_SECRETS_UNIT ? fileLines([], [SECRET_PREPARER_ENTRY]) : []),
      ];
      unitBlobs.set(unitId, lines);
      return lines;
    },
    units,
  };
  contexts.set(cacheKey, context);
  return context;
};

/** `env` lines, distinguishing unset from empty, plus the runner platform. */
const environmentLines = (env: Environment, keys: readonly string[]): string[] => [
  ...keys.map((key) => {
    const value = env[key];
    return `env ${key}=${value === undefined ? '<unset>' : JSON.stringify(value)}`;
  }),
  `runner ${env.RUNNER_OS ?? process.platform} ${env.RUNNER_ARCH ?? process.arch}`,
];

export interface DigestResult {
  /** sha256 hex. */
  readonly digest: string;
  /** The sorted lines it covers. */
  readonly lines: string[];
}

const unitDigestFromContext = (
  context: DigestContext,
  unitId: string,
  env: Environment,
  secretFingerprints: SecretFingerprints | undefined,
): DigestResult => {
  const unit = context.units.get(unitId);
  if (unit === undefined) {
    throw new ClosureInputError(`unknown unit ${unitId}`);
  }
  const lines = sortedLines([
    `digest-version ${DIGEST_VERSION}`,
    `unit ${unit.id} ${unit.package} ${unit.path}`,
    ...context.globalLines(),
    ...context.unitBlobLines(unitId),
    ...environmentLines(env, DIGEST_ENV_KEYS),
    `secret ${unitId} ${secretFingerprints?.[unitId] ?? UNAVAILABLE}`,
  ]);
  return { digest: digestLines(lines), lines };
};

export interface UnitDigestInput {
  readonly env: Environment;
  readonly secretFingerprints?: SecretFingerprints | undefined;
  readonly unitId: string;
  readonly workspaceRoot: string;
}

/** The content digest of one delivery unit at the workspace's committed HEAD. */
export const computeUnitDigest = ({ env, secretFingerprints, unitId, workspaceRoot }: UnitDigestInput): DigestResult =>
  unitDigestFromContext(createDigestContext(workspaceRoot), unitId, env, secretFingerprints);

/** The globs of a workspace-relative inputs file holding `{ "globs": [...] }`. */
const inputGlobs = (context: DigestContext, file: string): string[] => {
  const { globs } = parseJsonObject(file, context.snapshot.read(`${context.snapshot.appPrefix}${file}`));
  if (
    !Array.isArray(globs) ||
    globs.length === 0 ||
    !globs.every((glob): glob is string => typeof glob === 'string' && glob.length > 0)
  ) {
    throw new ClosureInputError(`${file} must list its input globs as a non-empty "globs" string array`);
  }
  return globs;
};

export interface HostDigestResult extends DigestResult {
  /** Owner unit ids. */
  readonly owners: readonly string[];
}

const hostDigestFromContext = (
  context: DigestContext,
  env: Environment,
  secretFingerprints: SecretFingerprints | undefined,
): HostDigestResult => {
  const owners = context.hostOwners();
  const lines = sortedLines([
    `digest-version ${DIGEST_VERSION}`,
    ...owners.map(
      (owner) => `host-owner ${owner} ${unitDigestFromContext(context, owner, env, secretFingerprints).digest}`,
    ),
    ...context.fileLines(inputGlobs(context, HOST_INPUTS_FILE), [HOST_INPUTS_FILE, HOST_ENTRY]),
  ]);
  return { digest: digestLines(lines), lines, owners };
};

/** The outbox host digest: its owners' unit digests plus the host's own build inputs. */
export const computeHostDigest = ({
  env,
  secretFingerprints,
  workspaceRoot,
}: Omit<UnitDigestInput, 'unitId'>): HostDigestResult =>
  hostDigestFromContext(createDigestContext(workspaceRoot), env, secretFingerprints);

const storefrontDigestFromContext = (context: DigestContext, env: Environment): DigestResult => {
  const storefront = context.graph.packages.get(STOREFRONT_PACKAGE);
  if (storefront === undefined) {
    throw new ClosureInputError(`the workspace has no ${STOREFRONT_PACKAGE} package`);
  }
  const lines = sortedLines([
    `digest-version ${DIGEST_VERSION}`,
    `storefront ${storefront.dir}`,
    ...context.globalLines(),
    ...blobLines(context.snapshot, packageClosure(context.graph, [{ kind: 'dir', path: storefront.dir }]).files),
    ...environmentLines(env, STOREFRONT_ENV_KEYS),
  ]);
  return { digest: digestLines(lines), lines };
};

/** The AKROS storefront build digest. */
export const computeStorefrontDigest = ({
  env,
  workspaceRoot,
}: {
  readonly env: Environment;
  readonly workspaceRoot: string;
}): DigestResult => storefrontDigestFromContext(createDigestContext(workspaceRoot), env);

const databaseDigestFromContext = (context: DigestContext): DigestResult => {
  const lines = sortedLines([
    `digest-version ${DIGEST_VERSION}`,
    ...context.fileLines(inputGlobs(context, DATABASE_INPUTS_FILE), [DATABASE_INPUTS_FILE]),
    ...blobLines(context.snapshot, [
      `${context.snapshot.appPrefix}package.json`,
      `${context.snapshot.appPrefix}pnpm-lock.yaml`,
    ]),
  ]);
  return { digest: digestLines(lines), lines };
};

/**
 * The digest of every committed input the sealed database preparation reads. The release pairs it with a
 * fingerprint of the identity credentials before comparing it with the ledger's database record.
 */
export const computeDatabaseInputsDigest = ({ workspaceRoot }: { readonly workspaceRoot: string }): DigestResult =>
  databaseDigestFromContext(createDigestContext(workspaceRoot));

export interface UnitInputsDocument {
  readonly digest: string;
  readonly lines: readonly string[];
  readonly sourceRevision: string;
  readonly unitId: string;
  readonly version: string;
}

/** The `inputs.json` a unit build ships beside its output: `{version, unitId, digest, sourceRevision, lines}`. */
export const unitInputsDocument = ({
  digest,
  lines,
  sourceRevision,
  unitId,
}: DigestResult & { readonly sourceRevision: string; readonly unitId: string }): UnitInputsDocument => ({
  digest,
  lines,
  sourceRevision,
  unitId,
  version: DIGEST_VERSION,
});

/** Results in input order, at most LOOKUP_CONCURRENCY at a time. */
const mapBounded = async <T, R>(items: readonly T[], work: (item: T) => Promise<R>): Promise<R[]> => {
  const results: R[] = [];
  const queue = [...items.entries()];
  const worker = async (): Promise<void> => {
    const next = queue.shift();
    if (next === undefined) {
      return;
    }
    const [index, item] = next;
    results[index] = await work(item);
    await worker();
  };
  await Promise.all(Array.from({ length: Math.min(LOOKUP_CONCURRENCY, items.length) }, async () => await worker()));
  return results;
};

export interface CloudflareReader {
  /**
   * The single version serving 100% of a Worker; undefined when the Worker has no such deployment, null when the
   * Worker does not exist (it was pruned, for example).
   */
  readonly activeVersion: (scriptName: string) => Promise<string | null | undefined>;
}

/** The version id of a deployments answer whose newest deployment serves exactly one version at 100%. */
const soleActiveVersion = (body: unknown): string | undefined => {
  if (!isJsonObject(body) || body.success !== true || !isJsonObject(body.result)) {
    return undefined;
  }
  const { deployments } = body.result;
  const newest: unknown = Array.isArray(deployments) ? deployments.at(0) : undefined;
  const versions: unknown = isJsonObject(newest) ? newest.versions : undefined;
  if (!Array.isArray(versions) || versions.length !== 1) {
    return undefined;
  }
  const version: unknown = versions.at(0);
  return isJsonObject(version) && version.percentage === 100 && typeof version.version_id === 'string'
    ? version.version_id
    : undefined;
};

const createCloudflareReader = ({
  accountId,
  fetch,
  token,
}: {
  readonly accountId: string;
  readonly fetch: typeof globalThis.fetch;
  readonly token: string;
}): CloudflareReader => ({
  activeVersion: async (scriptName) => {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}/deployments`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    // A deleted Worker answers 404: nothing of it is live.
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new DeployPlanError(`Cloudflare answered ${String(response.status)} for ${scriptName}`);
    }
    return soleActiveVersion(await response.json());
  },
});

/**
 * Whether a receipt's Workers are exactly what is live: the account origin matches and every Worker it names still
 * serves the receipt's version at 100%.
 */
const receiptIsLive = async (
  cloudflare: CloudflareReader,
  receipt: ReleaseReceipt,
  workersDevSubdomain: string | undefined,
): Promise<boolean> => {
  const { plan } = receipt;
  if (
    workersDevSubdomain === undefined ||
    plan.assetsOrigin !== `https://${plan.assetsScriptName}.${workersDevSubdomain}.workers.dev/`
  ) {
    return false;
  }
  const [assets, backend] = await Promise.all([
    cloudflare.activeVersion(plan.assetsScriptName),
    receipt.backend === undefined ? Promise.resolve() : cloudflare.activeVersion(receipt.backend.workerName),
  ]);
  return assets === receipt.assetsVersionId && (receipt.backend === undefined || backend === receipt.backend.versionId);
};

export interface ArtifactRef {
  readonly id: number;
  readonly name: string;
  /** Producer run. */
  readonly runId: number;
  /** Producer head commit. */
  readonly sourceRevision: string | undefined;
}

export interface PlannedUnit extends TopologyUnit {
  /** Reusable build artifact. */
  readonly artifact: ArtifactRef | null;
  /** Unit digest. */
  readonly digest: string;
  /** What the release does with it. */
  readonly mode: 'build' | 'reupload' | 'retain';
  /** Live receipt kept as is. */
  readonly receipt: ReleaseReceipt | null;
  /** Release secret fingerprint the digest covers (`unavailable` without a key). */
  readonly secretFingerprint: string;
}

export interface DeployPlan {
  readonly database: {
    readonly inputsDigest: string | null;
    readonly mode: 'auto' | 'full';
    readonly record: DatabaseRecord | null;
  };
  /** Digest scheme. */
  readonly digestVersion: string;
  /** Whether everything rebuilds and the database runs the full chain. */
  readonly forceFull: boolean;
  readonly forceFullReasons: readonly string[];
  /** ISO time. */
  readonly generatedAt: string;
  readonly host: {
    readonly artifact: ArtifactRef | null;
    readonly digest: string | null;
    readonly mode: 'build' | 'retain';
    readonly owners: readonly string[];
  };
  /** Records carried forward into this run's ledger. */
  readonly ledger: ReleaseLedger;
  /** Whether lookups were skipped. */
  readonly offline: boolean;
  /** HEAD the plan was computed at. */
  readonly sourceRevision: string;
  readonly storefront: {
    readonly artifact: ArtifactRef | null;
    readonly digest: string;
    readonly mode: 'build' | 'reuse';
  };
  /** Every served unit. */
  readonly units: readonly PlannedUnit[];
}

/** The producer's head commit is the revision a trusted artifact's build output carries. */
const artifactRef = ({ artifact, run }: TrustedArtifact): ArtifactRef => ({
  id: artifact.id,
  name: artifact.name,
  runId: artifact.workflow_run?.id ?? run.id,
  sourceRevision: run.head_sha ?? artifact.workflow_run?.head_sha,
});

export const unitArtifactName = (unitId: string, digest: string) => `edge-unit-${unitId}-${digest}`;
export const hostArtifactName = (digest: string) => `outbox-host-${digest}`;
export const storefrontArtifactName = (digest: string) => `akros-storefront-${digest}`;

export interface PlanOptions {
  /** Build env keys, secrets and API access. */
  readonly env: Environment;
  readonly fetch: typeof globalThis.fetch;
  /** Requested full rebuild. */
  readonly forceFull: boolean;
  readonly now: Date;
  /** Skip GitHub and Cloudflare lookups: every unit builds. */
  readonly offline: boolean;
  /** The `app` workspace directory. */
  readonly workspaceRoot: string;
}

/** Raw release secrets JSON from the file or the variable. */
const rawReleaseSecrets = (env: Environment): string | undefined => {
  const file = env.ALL_RELEASE_SECRETS_FILE;
  return file === undefined || file.length === 0 ? env.ALL_RELEASE_SECRETS : readFileSync(file, 'utf-8');
};

/** The units' secret fingerprints, or undefined (with the force-full reason recorded) when they cannot be computed. */
const secretFingerprintsFromEnvironment = (
  env: Environment,
  unitIds: readonly string[],
  reasons: string[],
): Record<string, string> | undefined => {
  const key = env.RELEASE_FINGERPRINT_KEY;
  if (key === undefined || key.length === 0) {
    reasons.push('fingerprint-key-missing');
    return undefined;
  }
  const raw = rawReleaseSecrets(env);
  if (raw === undefined || raw.length === 0) {
    reasons.push('release-secrets-missing');
    return undefined;
  }
  try {
    return computeSecretFingerprints({ key, rawSecrets: raw, unitIds });
  } catch {
    reasons.push('release-secrets-unreadable');
    return undefined;
  }
};

/** An optional digest, or undefined (with `reason` recorded) when it cannot read its inputs. */
const optionalDigest = <T,>(compute: () => T, reason: string, reasons: string[]): T | undefined => {
  try {
    return compute();
  } catch (error) {
    if (error instanceof ClosureInputError) {
      reasons.push(reason);
      return undefined;
    }
    throw error;
  }
};

export interface Lookups {
  /** Trusted artifacts of an exact name, newest first. */
  readonly artifacts: (name: string) => Promise<ArtifactRef[]>;
  /** Live Worker reader. */
  readonly cloudflare: CloudflareReader;
  /** Trusted ledgers, newest first. */
  readonly ledgers: readonly ReleaseLedger[];
}

const nonEmpty = (value: string | undefined): value is string => value !== undefined && value.length > 0;

/** Lookups, or undefined (with the force-full reason recorded) when they are unavailable. */
const openLookups = async ({ env, fetch }: PlanOptions, reasons: string[]): Promise<Lookups | undefined> => {
  const token = env.GITHUB_TOKEN ?? env.GH_TOKEN;
  const repository = env.GITHUB_REPOSITORY;
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const cloudflareToken = env.CLOUDFLARE_API_TOKEN;
  if (!nonEmpty(token) || !nonEmpty(repository)) {
    reasons.push('github-unavailable');
    return undefined;
  }
  if (!nonEmpty(accountId) || !nonEmpty(cloudflareToken)) {
    reasons.push('cloudflare-unavailable');
    return undefined;
  }
  const github = createGitHubClient({
    apiUrl: env.GITHUB_API_URL ?? 'https://api.github.com',
    fetch,
    repository,
    token,
  });
  try {
    return {
      artifacts: async (name) => {
        const trusted = await github.trustedArtifacts(name, ARTIFACT_CANDIDATES);
        return trusted.map(artifactRef);
      },
      cloudflare: createCloudflareReader({ accountId, fetch, token: cloudflareToken }),
      ledgers: await readTrustedLedgers(github, LEDGER_LOOKBACK),
    };
  } catch {
    reasons.push('ledger-lookup-failed');
    return undefined;
  }
};

interface UnitSelection {
  /** The build a reupload unpacks, or the kept Workers' own build (the Shell's ingress needs it). */
  readonly artifact: ArtifactRef | null;
  /** Kept as live Workers, or uploaded from an earlier build. */
  readonly mode: 'retain' | 'reupload';
  /** The kept ledger record. */
  readonly record: UnitRecord | null;
}

/** How a unit can avoid a build, optionally only from one source revision; undefined when it must build. */
type UnitSelector = (unitId: string, digest: string, revision?: string) => Promise<UnitSelection | undefined>;

/**
 * A unit's Workers are named by its build marker, a hash of unit, content and source revision. A receipt and a build
 * artifact of the same digest therefore belong together only when they come from the same revision, and a Shell
 * kept from revision R must unpack the build output of R, never a newer content-equal build. `history` is every
 * still-valid record, newest first; lookups and live checks are memoized across calls.
 */
const createUnitSelector = ({
  history,
  lookups,
  workersDevSubdomain,
}: {
  readonly history: readonly UnitRecord[];
  readonly lookups: Lookups;
  readonly workersDevSubdomain: string | undefined;
}): UnitSelector => {
  const artifacts = new Map<string, Promise<ArtifactRef[]>>();
  const live = new Map<string, Promise<boolean>>();
  const versions = new Map<string, Promise<string | null | undefined>>();
  const artifactsNamed = async (name: string): Promise<ArtifactRef[]> => {
    const cached = artifacts.get(name) ?? lookups.artifacts(name);
    artifacts.set(name, cached);
    return await cached;
  };
  const cloudflare: CloudflareReader = {
    activeVersion: async (scriptName) => {
      const cached = versions.get(scriptName) ?? lookups.cloudflare.activeVersion(scriptName);
      versions.set(scriptName, cached);
      return await cached;
    },
  };
  /**
   * Whether a record's identity holds exactly one of its two Workers (the pruner or an interrupted removal left the
   * other gone). Its revision cannot be uploaded again: the release refuses an identity that is half present.
   */
  const halfPresent = async ({ receipt }: UnitRecord): Promise<boolean> => {
    if (receipt.backend === undefined) {
      return false;
    }
    const [assets, backend] = await Promise.all([
      cloudflare.activeVersion(receipt.plan.assetsScriptName),
      cloudflare.activeVersion(receipt.backend.workerName),
    ]);
    return (assets === null) !== (backend === null);
  };
  /** The newest build whose revision's identity is not half present, which a reupload recreates whole. */
  const reuploadable = async (
    built: readonly ArtifactRef[],
    records: readonly UnitRecord[],
  ): Promise<ArtifactRef | undefined> => {
    const [artifact, ...rest] = built;
    if (artifact === undefined) {
      return undefined;
    }
    const occupied = await Promise.all(
      records.filter((record) => record.sourceRevision === artifact.sourceRevision).map(halfPresent),
    );
    return occupied.includes(true) ? await reuploadable(rest, records) : artifact;
  };
  const isLive = async (receipt: ReleaseReceipt): Promise<boolean> => {
    const key = [
      receipt.plan.assetsScriptName,
      receipt.assetsVersionId,
      receipt.backend?.workerName,
      receipt.backend?.versionId,
    ].join('\0');
    const cached = live.get(key) ?? receiptIsLive(cloudflare, receipt, workersDevSubdomain);
    live.set(key, cached);
    return await cached;
  };
  /** The first record of this digest (and revision) whose Workers are live and whose Shell has its own build. */
  const retained = async (
    records: readonly UnitRecord[],
    built: readonly ArtifactRef[],
    unitId: string,
  ): Promise<UnitSelection | undefined> => {
    const [record, ...rest] = records;
    if (record === undefined) {
      return undefined;
    }
    const own = built.find((artifact) => artifact.sourceRevision === record.sourceRevision) ?? null;
    if ((unitId !== SHELL_ID || own !== null) && (await isLive(record.receipt))) {
      return { artifact: own, mode: 'retain', record };
    }
    return await retained(rest, built, unitId);
  };
  return async (unitId, digest, revision) => {
    const allowed = (sourceRevision: string | undefined) => revision === undefined || sourceRevision === revision;
    const named = await artifactsNamed(unitArtifactName(unitId, digest));
    const built = named.filter((artifact) => allowed(artifact.sourceRevision));
    const records = history.filter(
      (record) => record.unitId === unitId && record.digest === digest && allowed(record.sourceRevision),
    );
    const kept = await retained(records, built, unitId);
    if (kept !== undefined) {
      return kept;
    }
    const newest = await reuploadable(built, records);
    return newest === undefined ? undefined : { artifact: newest, mode: 'reupload', record: null };
  };
};

interface HostGroup {
  readonly artifact: ArtifactRef;
  readonly selections: readonly (readonly [string, UnitSelection])[];
}

/**
 * The host compiles every owner at one revision, so it is kept only as a whole group from one revision R: a trusted
 * ledger recorded this exact host deployed at R, the host artifact built at R exists, and every served owner is kept
 * or re-uploaded from R as well. The host the ledger last recorded goes first, so an unchanged host needs no deploy.
 * Undefined when the host and every owner must build at HEAD.
 */
const selectHostGroup = async ({
  hostDigest,
  ledger,
  lookups,
  owners,
  select,
}: {
  readonly hostDigest: string;
  readonly ledger: ReleaseLedger;
  readonly lookups: Lookups;
  readonly owners: readonly PlannedUnit[];
  readonly select: UnitSelector;
}): Promise<HostGroup | undefined> => {
  const recorded = new Set(
    lookups.ledgers
      .filter((candidate) => candidate.digestVersion === DIGEST_VERSION && candidate.host?.digest === hostDigest)
      .map((candidate) => candidate.host?.sourceRevision),
  );
  const current = ledger.host?.digest === hostDigest ? ledger.host.sourceRevision : undefined;
  const hostArtifacts = await lookups.artifacts(hostArtifactName(hostDigest));
  const candidates = hostArtifacts
    .filter((artifact) => artifact.sourceRevision !== undefined && recorded.has(artifact.sourceRevision))
    .toSorted((left, right) => Number(right.sourceRevision === current) - Number(left.sourceRevision === current))
    .filter(
      (artifact, index, all) =>
        all.findIndex((candidate) => candidate.sourceRevision === artifact.sourceRevision) === index,
    );
  const tryRevision = async (remaining: readonly ArtifactRef[]): Promise<HostGroup | undefined> => {
    const [artifact, ...rest] = remaining;
    if (artifact === undefined) {
      return undefined;
    }
    const selections = await Promise.all(
      owners.map(async (owner) => [owner.id, await select(owner.id, owner.digest, artifact.sourceRevision)] as const),
    );
    const complete = selections.flatMap(([id, selection]) =>
      selection === undefined ? [] : [[id, selection] as const],
    );
    return complete.length === selections.length ? { artifact, selections: complete } : await tryRevision(rest);
  };
  return await tryRevision(candidates);
};

interface PlannedDigestSet {
  readonly database: DigestResult | undefined;
  readonly fingerprints: Record<string, string> | undefined;
  readonly host: HostDigestResult | undefined;
  readonly hostOwners: readonly string[];
  readonly storefront: DigestResult;
  readonly units: readonly PlannedUnit[];
}

/** Every digest of this checkout; an unreadable input or missing secret material records its force-full reason. */
const plannedDigests = (context: DigestContext, env: Environment, reasons: string[]): PlannedDigestSet => {
  const hostOwners = optionalDigest(() => context.hostOwners(), 'host-inputs-unreadable', reasons) ?? [];
  const fingerprintUnits = [...new Set([...context.served.map((unit) => unit.id), ...hostOwners])];
  const fingerprints = secretFingerprintsFromEnvironment(env, fingerprintUnits, reasons);
  return {
    database: optionalDigest(() => databaseDigestFromContext(context), 'database-inputs-unreadable', reasons),
    fingerprints,
    host: optionalDigest(() => hostDigestFromContext(context, env, fingerprints), 'host-inputs-unreadable', reasons),
    hostOwners,
    storefront: storefrontDigestFromContext(context, env),
    units: context.served.map((unit) => ({
      artifact: null,
      digest: unitDigestFromContext(context, unit.id, env, fingerprints).digest,
      id: unit.id,
      mode: 'build',
      package: unit.package,
      path: unit.path,
      receipt: null,
      secretFingerprint: fingerprints?.[unit.id] ?? UNAVAILABLE,
    })),
  };
};

interface ReuseSelection {
  /** The merged ledger's unit records plus the receipts this composition actually keeps. */
  readonly carried: Readonly<Record<string, UnitRecord>>;
  readonly hostArtifact: ArtifactRef | null;
  readonly units: readonly PlannedUnit[];
}

/** What each unit and the host group reuse from trusted earlier runs and live Workers. */
const selectReuse = async ({
  env,
  host,
  hostOwners,
  ledger,
  lookups,
  planned,
  run,
}: {
  readonly env: Environment;
  readonly host: HostDigestResult;
  readonly hostOwners: readonly string[];
  readonly ledger: ReleaseLedger;
  readonly lookups: Lookups;
  readonly planned: readonly PlannedUnit[];
  readonly run: Pick<RunIdentity, 'digestVersion' | 'now'>;
}): Promise<ReuseSelection> => {
  const select = createUnitSelector({
    history: unitRecordHistory(lookups.ledgers, run),
    lookups,
    workersDevSubdomain: env.WORKERS_DEV_SUBDOMAIN,
  });
  const owners = planned.filter((unit) => hostOwners.includes(unit.id));
  const group = await selectHostGroup({ hostDigest: host.digest, ledger, lookups, owners, select });
  const others = planned.filter((unit) => !hostOwners.includes(unit.id));
  const selections = new Map<string, UnitSelection | undefined>([
    ...(group?.selections ?? []),
    ...(await mapBounded(others, async (unit) => [unit.id, await select(unit.id, unit.digest)] as const)),
  ]);
  const carried = { ...ledger.units };
  const units = planned.map((unit) => {
    const selection = selections.get(unit.id);
    if (selection === undefined) {
      return unit;
    }
    if (selection.record !== null) {
      // Carry forward the receipt this composition actually keeps, not merely the newest of its digest.
      carried[unit.digest] = selection.record;
    }
    return { ...unit, artifact: selection.artifact, mode: selection.mode, receipt: selection.record?.receipt ?? null };
  });
  return { carried, hostArtifact: group?.artifact ?? null, units };
};

/** The newest trusted storefront build of this digest; none when its build literals are unknown or lookups fail. */
const reusableStorefront = async (
  lookups: Lookups,
  storefront: DigestResult,
  env: Environment,
): Promise<ArtifactRef | null> => {
  // Unset build literals mean the plan cannot know what the storefront build will use, so it builds.
  if (!STOREFRONT_ENV_KEYS.every((key) => env[key] !== undefined)) {
    return null;
  }
  const artifacts = await lookups.artifacts(storefrontArtifactName(storefront.digest)).catch((): ArtifactRef[] => []);
  return artifacts.at(0) ?? null;
};

/**
 * Trusted ledgers and live lookups, or undefined when the plan already builds everything. A newest ledger of another
 * digest scheme records a force-full reason; its older compatible records are still carried forward.
 */
const trustedLookups = async (options: PlanOptions, reasons: string[]): Promise<Lookups | undefined> => {
  if (options.offline || reasons.length > 0) {
    return undefined;
  }
  const lookups = await openLookups(options, reasons);
  const newestScheme = lookups?.ledgers.at(0)?.digestVersion;
  if (newestScheme !== undefined && newestScheme !== DIGEST_VERSION) {
    reasons.push('digest-version-changed');
  }
  return lookups;
};

/** The units, host and ledger records the plan reuses; a failed lookup records `lookup-failed` and reuses nothing. */
const reusedOrBuilt = async (
  input: Omit<Parameters<typeof selectReuse>[0], 'host' | 'lookups'> & {
    readonly host: HostDigestResult | undefined;
    readonly lookups: Lookups | undefined;
  },
  reasons: string[],
): Promise<ReuseSelection> => {
  const built: ReuseSelection = { carried: input.ledger.units, hostArtifact: null, units: input.planned };
  const { host, lookups } = input;
  if (lookups === undefined || host === undefined) {
    return built;
  }
  return await selectReuse({ ...input, host, lookups }).catch(() => {
    reasons.push('lookup-failed');
    return built;
  });
};

/**
 * Plans one stage demo deploy. Missing fingerprint key, unreadable inputs or failed lookups force a full rebuild;
 * nothing here can make the release skip more than live state later allows.
 */
export const planDeployment = async (options: PlanOptions): Promise<DeployPlan> => {
  const { env, now } = options;
  const context = createDigestContext(options.workspaceRoot);
  const reasons = [
    ...(options.forceFull ? ['requested'] : []),
    ...(env.STAGE_DEMO_FORCE_FULL === 'true' ? ['repository-variable'] : []),
  ];
  const digests = plannedDigests(context, env, reasons);
  const run = {
    digestVersion: DIGEST_VERSION,
    now,
    runId: env.GITHUB_RUN_ID ?? 'local',
    sourceRevision: context.snapshot.revision,
  };
  const lookups = await trustedLookups(options, reasons);
  const merged = mergeLedgers(lookups?.ledgers ?? [], run);
  const reuse = reasons.length === 0 ? lookups : undefined;
  const selected = await reusedOrBuilt(
    {
      env,
      host: digests.host,
      hostOwners: digests.hostOwners,
      ledger: merged,
      lookups: reuse,
      planned: digests.units,
      run,
    },
    reasons,
  );
  const fullRebuild = reasons.length > 0;
  const storefrontArtifact =
    reuse === undefined || fullRebuild ? null : await reusableStorefront(reuse, digests.storefront, env);
  return {
    database: {
      inputsDigest: digests.database?.digest ?? null,
      mode: fullRebuild || digests.database === undefined ? 'full' : 'auto',
      record: merged.database,
    },
    digestVersion: DIGEST_VERSION,
    forceFull: fullRebuild,
    forceFullReasons: reasons,
    generatedAt: now.toISOString(),
    host: {
      artifact: selected.hostArtifact,
      digest: digests.host?.digest ?? null,
      mode: selected.hostArtifact === null ? 'build' : 'retain',
      owners: digests.hostOwners,
    },
    ledger: { ...merged, units: selected.carried },
    offline: options.offline,
    sourceRevision: context.snapshot.revision,
    storefront: {
      artifact: storefrontArtifact,
      digest: digests.storefront.digest,
      mode: storefrontArtifact === null ? 'build' : 'reuse',
    },
    units: selected.units,
  };
};

/** The step outputs the stage demo deploy workflow consumes, by name, as single-line values. */
export const planOutputs = (plan: DeployPlan) => {
  const matrix = plan.units
    .filter((unit) => unit.mode === 'build')
    .map((unit) => ({
      digest: unit.digest,
      id: unit.id,
      package: unit.package,
      path: unit.path,
      secretFingerprint: unit.secretFingerprint,
    }));
  return {
    build_count: String(matrix.length),
    build_matrix: JSON.stringify(matrix),
    db_inputs_digest: plan.database.inputsDigest ?? '',
    db_mode: plan.database.mode,
    force_full: String(plan.forceFull),
    host_digest: plan.host.digest ?? '',
    host_mode: plan.host.mode,
    storefront_digest: plan.storefront.digest,
    storefront_mode: plan.storefront.mode,
    units: JSON.stringify(plan.units.map((unit) => ({ id: unit.id, package: unit.package, path: unit.path }))),
  };
};

/** The digests of a plan the release recomputes. */
export interface PlannedDigests {
  readonly database: Pick<DeployPlan['database'], 'inputsDigest'>;
  readonly digestVersion: string;
  readonly host: Pick<DeployPlan['host'], 'digest' | 'owners'>;
  readonly sourceRevision: string;
  readonly storefront: Pick<DeployPlan['storefront'], 'digest'>;
  readonly units: readonly Pick<PlannedUnit, 'digest' | 'id'>[];
}

/**
 * The release's check that a plan still holds at its own clean checkout: same revision and digest scheme, and every
 * unit, host, storefront and database digest recomputes to the planned value with the release's environment (build
 * env keys, storefront literals, secrets, fingerprint key). Returns the verified revision.
 */
export const verifyPlan = ({
  env,
  plan,
  workspaceRoot,
}: {
  readonly env: Environment;
  readonly plan: PlannedDigests;
  readonly workspaceRoot: string;
}): string => {
  const context = createDigestContext(workspaceRoot);
  if (plan.digestVersion !== DIGEST_VERSION || plan.sourceRevision !== context.snapshot.revision) {
    throw new DeployPlanError('the deploy plan was computed for another revision or digest scheme');
  }
  const fingerprints = secretFingerprintsFromEnvironment(
    env,
    [...plan.units.map((unit) => unit.id), ...plan.host.owners],
    [],
  );
  const mismatched = plan.units
    .filter((unit) => unitDigestFromContext(context, unit.id, env, fingerprints).digest !== unit.digest)
    .map((unit) => unit.id);
  if (plan.host.digest !== null && hostDigestFromContext(context, env, fingerprints).digest !== plan.host.digest) {
    mismatched.push('outbox-host');
  }
  if (storefrontDigestFromContext(context, env).digest !== plan.storefront.digest) {
    mismatched.push('akros-storefront');
  }
  if (plan.database.inputsDigest !== null && databaseDigestFromContext(context).digest !== plan.database.inputsDigest) {
    mismatched.push('database');
  }
  if (mismatched.length > 0) {
    throw new DeployPlanError(`recomputed digests differ from the plan for: ${mismatched.join(', ')}`);
  }
  return context.snapshot.revision;
};

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

const nullableString = (value: unknown): value is string | null => value === null || typeof value === 'string';

/** The digests of a deploy plan file, validated. */
const parsePlannedDigests = (text: string): PlannedDigests => {
  const plan = parseJsonObject('the deploy plan', text);
  const { database, digestVersion, host, sourceRevision, storefront, units } = plan;
  const plannedUnits = Array.isArray(units)
    ? units.flatMap((unit) =>
        isJsonObject(unit) && typeof unit.id === 'string' && typeof unit.digest === 'string'
          ? [{ digest: unit.digest, id: unit.id }]
          : [],
      )
    : [];
  if (
    typeof digestVersion !== 'string' ||
    typeof sourceRevision !== 'string' ||
    !Array.isArray(units) ||
    plannedUnits.length !== units.length ||
    !isJsonObject(host) ||
    !nullableString(host.digest) ||
    !isStringArray(host.owners) ||
    !isJsonObject(storefront) ||
    typeof storefront.digest !== 'string' ||
    !isJsonObject(database) ||
    !nullableString(database.inputsDigest)
  ) {
    throw new DeployPlanError('the deploy plan is not a deploy-plan.mts plan');
  }
  return {
    database: { inputsDigest: database.inputsDigest },
    digestVersion,
    host: { digest: host.digest, owners: host.owners },
    sourceRevision,
    storefront: { digest: storefront.digest },
    units: plannedUnits,
  };
};

const USAGE = `Usage:
  deploy-plan.mts plan --output <plan.json> [--offline] [--force-full]
  deploy-plan.mts unit-digest --unit <id> [--secret-fingerprint <hex>] [--expect-digest <d>] [--output <inputs.json>]
  deploy-plan.mts host-digest [--output <host-inputs.json>]
  deploy-plan.mts verify --plan <plan.json>`;

const writeJson = (file: string, value: unknown) => {
  writeFileSync(file, `${JSON.stringify(value, undefined, 2)}\n`);
};

/** The plan summary the plan step prints. */
const planSummary = (plan: DeployPlan): string => {
  const counts = Object.groupBy(plan.units, (unit) => unit.mode);
  const modes = (['retain', 'reupload', 'build'] as const).map(
    (mode) => `${String(counts[mode]?.length ?? 0)} ${mode}`,
  );
  return [
    `${String(plan.units.length)} units at ${plan.sourceRevision}: ${modes.join(', ')}`,
    `host ${plan.host.mode}, storefront ${plan.storefront.mode}, database ${plan.database.mode}`,
    plan.forceFull ? `full rebuild: ${plan.forceFullReasons.join(', ')}` : 'incremental',
    ...plan.units.map((unit) => `  ${unit.mode.padEnd(8)} ${unit.id} ${unit.digest.slice(0, 12)}`),
  ].join('\n');
};

const writePlan = async (
  env: Environment,
  workspaceRoot: string,
  output: string,
  flags: { forceFull: boolean; offline: boolean },
) => {
  const plan = await planDeployment({
    env,
    fetch: globalThis.fetch,
    forceFull: flags.forceFull,
    now: new Date(),
    offline: flags.offline,
    workspaceRoot,
  });
  writeJson(output, plan);
  const githubOutput = env.GITHUB_OUTPUT;
  if (nonEmpty(githubOutput)) {
    appendFileSync(
      githubOutput,
      Object.entries(planOutputs(plan))
        .map(([key, value]) => `${key}=${value}\n`)
        .join(''),
    );
  }
  console.log(planSummary(plan));
};

/** The secret fingerprints a unit digest covers: the plan's (an HMAC or `unavailable`), else the secrets' own. */
const unitFingerprints = (
  env: Environment,
  unitId: string,
  fingerprint: string | undefined,
): Record<string, string> | undefined => {
  if (fingerprint === undefined) {
    return secretFingerprintsFromEnvironment(env, [unitId], []);
  }
  return fingerprint === UNAVAILABLE ? undefined : { [unitId]: fingerprint };
};

/** Prints a unit's digest; fails when it differs from `expected`, and writes its inputs.json when asked. */
const printUnitDigest = (
  env: Environment,
  workspaceRoot: string,
  unitId: string,
  {
    expected,
    fingerprint,
    output,
  }: { expected?: string | undefined; fingerprint?: string | undefined; output?: string | undefined },
) => {
  const fingerprints = unitFingerprints(env, unitId, fingerprint);
  const result = computeUnitDigest({ env, secretFingerprints: fingerprints, unitId, workspaceRoot });
  if (expected !== undefined && expected !== result.digest) {
    throw new DeployPlanError(
      `${unitId} inputs digest ${result.digest} differs from the planned ${expected}: the build environment or checkout differs from the plan's`,
    );
  }
  if (output !== undefined) {
    const sourceRevision = env.ULTRAMODERN_SOURCE_REVISION ?? createDigestContext(workspaceRoot).snapshot.revision;
    writeJson(output, unitInputsDocument({ ...result, sourceRevision, unitId }));
  }
  console.log(result.digest);
};

const printHostDigest = (env: Environment, workspaceRoot: string, output: string | undefined) => {
  const context = createDigestContext(workspaceRoot);
  const result = computeHostDigest({
    env,
    secretFingerprints: secretFingerprintsFromEnvironment(env, context.hostOwners(), []),
    workspaceRoot,
  });
  if (output !== undefined) {
    writeJson(output, { digest: result.digest, lines: result.lines, owners: result.owners, version: DIGEST_VERSION });
  }
  console.log(result.digest);
};

const main = async (argv: readonly string[], env: Environment): Promise<void> => {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      'expect-digest': { type: 'string' },
      'force-full': { default: false, type: 'boolean' },
      offline: { default: false, type: 'boolean' },
      output: { type: 'string' },
      plan: { type: 'string' },
      'secret-fingerprint': { type: 'string' },
      unit: { type: 'string' },
    },
    strict: true,
  });
  const workspaceRoot = path.resolve(import.meta.dirname, '../..');
  if (command === 'plan' && values.output !== undefined) {
    await writePlan(env, workspaceRoot, values.output, { forceFull: values['force-full'], offline: values.offline });
  } else if (command === 'unit-digest' && values.unit !== undefined) {
    printUnitDigest(env, workspaceRoot, values.unit, {
      expected: values['expect-digest'],
      fingerprint: values['secret-fingerprint'],
      output: values.output,
    });
  } else if (command === 'host-digest') {
    printHostDigest(env, workspaceRoot, values.output);
  } else if (command === 'verify' && values.plan !== undefined) {
    const plan = parsePlannedDigests(readFileSync(values.plan, 'utf-8'));
    console.log(`every planned digest matches ${verifyPlan({ env, plan, workspaceRoot })}`);
  } else {
    throw new DeployPlanError(USAGE);
  }
};

if (import.meta.main) {
  try {
    await main(process.argv.slice(2), process.env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
