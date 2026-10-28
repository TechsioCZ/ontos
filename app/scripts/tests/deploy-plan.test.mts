import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';

import { Array as EffectArray, Effect, Order } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  computeHostDigest,
  computeDatabaseInputsDigest,
  computeSecretFingerprints,
  computeStorefrontDigest,
  computeUnitDigest,
  DIGEST_VERSION,
  hostArtifactName,
  planDeployment,
  planOutputs,
  storefrontArtifactName,
  unitArtifactName,
  unitInputsDocument,
  verifyPlan,
} from '../ci/deploy-plan.mts';
import {
  isTrustedArtifact,
  isTrustedProducerRun,
  LEDGER_ARTIFACT_NAME,
  LEDGER_FILE,
  LEDGER_VERSION,
  mergeLedgers,
  parseLedger,
  readZipEntries,
  recordDatabase,
  recordHost,
  recordUnitReceipt,
  serializeLedger,
  TRUSTED_PRODUCER,
} from '../ci/release-ledger.mts';

const REPOSITORY = 'TechsioCZ/ontos';
const REPOSITORY_ID = 7;
const ACCOUNT = 'account-1';
const SUBDOMAIN = 'edution';
const SHELL = 'shell-super-app';
const UNIT_IDS = [SHELL, 'alpha', 'beta', 'gamma', 'projects'] as const;
const BUILD_ENV = {
  CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
  DEPLOY_TARGET: 'cloudflare',
  RUNNER_ARCH: 'X64',
  RUNNER_OS: 'Linux',
  ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'stage',
  WORKERS_DEV_SUBDOMAIN: SUBDOMAIN,
} as const;
const KEY = 'fingerprint-key';
const SECRET_RECORD = { alpha: { TOKEN: 'a' }, beta: { TOKEN: 'b' }, [SHELL]: { BETTER_AUTH_SECRET: 's' } };
const SECRETS = JSON.stringify(SECRET_RECORD);
const WORKSPACE = 'workspace:*';
/** The revision a trusted earlier run deployed, and a newer one that rebuilt content-equal units. */
const REV_A = 'a'.repeat(40);
const REV_B = 'b'.repeat(40);

type JsonValue = boolean | number | string | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

const json = (value: JsonValue): string => `${JSON.stringify(value, undefined, 2)}\n`;
const manifest = (name: string, dependencies: Readonly<Record<string, string>> = {}, scripts = {}) =>
  json({ dependencies, exports: { '.': './src/index.ts', './outbox-worker-host': './src/host.ts' }, name, scripts });

/** A minimal repository with the real layout: `app/` workspace, topology, root scripts and a database project. */
const FIXTURE_FILES = {
  '.github/actions/install-app/action.yml': 'name: install\n',
  'app/.mise.toml': '[tools]\nnode = "26"\n',
  'app/akros-storefront/package.json': manifest('akros-storefront'),
  'app/akros-storefront/src/index.ts': 'export const storefront = 1;\n',
  'app/apps/shell-super-app/package.json': manifest('@app/shell-super-app', {
    '@app/alpha': WORKSPACE,
    '@app/core': WORKSPACE,
  }),
  'app/apps/shell-super-app/src/host.ts': "export { core } from '@app/core';\n",
  'app/apps/shell-super-app/src/index.ts': "import { alpha } from '@app/alpha';\nexport const shell = alpha;\n",
  'app/apps/shell-super-app/tsconfig.json': json({
    extends: '../../tsconfig.base.json',
    references: [{ path: '../../database' }, { path: '../../packages/core' }],
  }),
  'app/database/schema.ts': 'export const schema = 1;\n',
  'app/database/tsconfig.json': json({ extends: '../tsconfig.base.json' }),
  'app/module-federation.shared.ts': 'export const shared = {};\n',
  'app/package.json': json({ name: 'app', private: true }),
  'app/packages/core/package.json': manifest('@app/core'),
  'app/packages/core/src/index.ts': 'export const core = 1;\n',
  'app/packages/core/tests/core.test.ts': "import '../../../scripts/unrelated-tooling.mts';\n",
  'app/patches/x.patch': 'patch\n',
  'app/pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
  'app/pnpm-workspace.yaml': 'packages:\n  - apps/*\n  - verticals/*\n  - packages/*\n  - akros-storefront\n',
  'app/scripts/ci/database-preparation-inputs.json': json({ globs: ['database/**', 'scripts/migrate.mts'] }),
  'app/scripts/ci/outbox-host-inputs.json': json({
    globs: ['scripts/outbox-worker-host.generated.mts', 'zerops.yaml'],
  }),
  'app/scripts/gamma-helper.mts': 'export const helper = 1;\n',
  'app/scripts/generate-contract.mts': "import './scaffolding/shared.mts';\n",
  'app/scripts/immutable-application-release.mts': "import './release-shared.mts';\n",
  'app/scripts/immutable-shell-release.mts': "import './immutable-application-release.mts';\n",
  'app/scripts/migrate-helper.mts': 'export const migrate = 1;\n',
  'app/scripts/migrate.mts': "import './migrate-helper.mts';\n",
  'app/scripts/outbox-worker-host.generated.mts': [
    "import { outboxWorkerEntry as shell } from '@app/shell-super-app/outbox-worker-host';",
    "import { outboxWorkerEntry as alpha } from '@app/alpha/outbox-worker-host';",
    '',
  ].join('\n'),
  'app/scripts/prepare-stage-release-secrets.mts': 'export const prepare = 1;\n',
  'app/scripts/release-shared.mts': 'export const recipe = 1;\n',
  'app/scripts/scaffolding/shared.mts': 'export const scaffold = 1;\n',
  'app/scripts/unrelated-tooling.mts': 'export const tooling = 1;\n',
  'app/topology/application-release-intent.json': json({
    modules: [{ appId: 'alpha' }, { appId: 'beta' }, { appId: 'gamma' }, { appId: 'projects' }],
  }),
  'app/topology/cloudflare-placement.json': json({ buildEnvironment: {} }),
  'app/topology/reference-topology.json': json({
    shell: { id: SHELL, package: '@app/shell-super-app', path: 'apps/shell-super-app' },
    verticals: ['alpha', 'beta', 'gamma', 'projects'].map((id) => ({
      id,
      package: `@app/${id}`,
      path: `verticals/${id}`,
    })),
  }),
  'app/tsconfig.base.json': json({ compilerOptions: { strict: true } }),
  'app/verticals/alpha/package.json': manifest(
    '@app/alpha',
    { '@app/core': WORKSPACE },
    { 'cloudflare:build': 'node ../../scripts/generate-contract.mts', dev: 'node ../../scripts/unrelated-tooling.mts' },
  ),
  'app/verticals/alpha/src/host.ts': 'export const host = 1;\n',
  'app/verticals/alpha/src/index.ts': "import { core } from '@app/core';\nexport const alpha = core;\n",
  'app/verticals/beta/package.json': manifest('@app/beta', { '@app/alpha': WORKSPACE }),
  'app/verticals/beta/src/index.ts': "export { alpha } from '@app/alpha';\n",
  'app/verticals/gamma/package.json': manifest('@app/gamma'),
  'app/verticals/gamma/src/index.ts': "export { helper } from '../../../scripts/gamma-helper.mts';\n",
  'app/verticals/projects/package.json': manifest('@app/projects'),
  'app/verticals/projects/src/index.ts': 'export const projects = 1;\n',
  'app/zerops.yaml': 'zerops: []\n',
} satisfies Readonly<Record<string, string>>;

const runGit = (root: string, argumentsList: readonly string[]): string =>
  execFileSync(
    '/usr/bin/git',
    [
      '-c',
      'user.email=ontos-ci@example.invalid',
      '-c',
      'user.name=OntOS CI',
      '-c',
      'commit.gpgsign=false',
      ...argumentsList,
    ],
    { cwd: root, encoding: 'utf-8' },
  ).trim();

const writeFiles = (root: string, files: Readonly<Record<string, string>>) =>
  Effect.promise(() =>
    Promise.all(
      Object.entries(files).map(async ([file, text]) => {
        await mkdir(path.dirname(path.join(root, file)), { recursive: true });
        await writeFile(path.join(root, file), text);
      }),
    ),
  );

/** Commits the edits and returns the workspace root, so every digest sees a clean HEAD. */
const commit = (root: string, files: Readonly<Record<string, string>>) =>
  Effect.gen(function* commitFixture() {
    yield* writeFiles(root, files);
    runGit(root, ['add', '-A']);
    runGit(root, ['commit', '-qm', 'fixture', '--allow-empty']);
    return path.join(root, 'app');
  });

const withRepository = (run: (root: string) => Effect.Effect<void, unknown>) =>
  Effect.gen(function* repositoryFixture() {
    const root = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(path.join(os.tmpdir(), 'ontos-deploy-plan-'))),
      (directory) => Effect.promise(() => rm(directory, { force: true, recursive: true })),
    );
    runGit(root, ['init', '-q', '-b', 'main']);
    yield* commit(root, FIXTURE_FILES);
    yield* run(root);
  }).pipe(Effect.scoped);

const fingerprints = (secrets: string = SECRETS) =>
  computeSecretFingerprints({ key: KEY, rawSecrets: secrets, unitIds: UNIT_IDS });

const digests = (workspaceRoot: string, secrets: string = SECRETS) => {
  const unitDigest = (unitId: string) =>
    computeUnitDigest({ env: BUILD_ENV, secretFingerprints: fingerprints(secrets), unitId, workspaceRoot }).digest;
  return {
    alpha: unitDigest('alpha'),
    beta: unitDigest('beta'),
    gamma: unitDigest('gamma'),
    projects: unitDigest('projects'),
    [SHELL]: unitDigest(SHELL),
  };
};

type UnitDigests = ReturnType<typeof digests>;

const changedUnits = (before: UnitDigests, after: UnitDigests) =>
  UNIT_IDS.filter((unitId) => before[unitId] !== after[unitId]);

it.live('unit digests are deterministic across checkouts and cover every closure line', () =>
  withRepository((root) =>
    Effect.gen(function* deterministicDigests() {
      const workspaceRoot = path.join(root, 'app');
      const clone = `${root}-clone`;
      runGit(path.dirname(root), ['clone', '-q', root, clone]);
      const cloned = digests(path.join(clone, 'app'));
      yield* Effect.promise(() => rm(clone, { force: true, recursive: true }));
      expect(digests(workspaceRoot)).toEqual(cloned);
      const alpha = computeUnitDigest({
        env: BUILD_ENV,
        secretFingerprints: fingerprints(),
        unitId: 'alpha',
        workspaceRoot,
      });
      expect(alpha.lines).toEqual(EffectArray.sort(alpha.lines, Order.String));
      expect(alpha.lines).toContain(`digest-version ${DIGEST_VERSION}`);
      expect(alpha.lines.some((line) => line.startsWith('blob app/packages/core/src/index.ts '))).toBe(true);
      expect(alpha.lines.some((line) => line.startsWith('blob app/scripts/generate-contract.mts '))).toBe(true);
      expect(alpha.lines.some((line) => line.startsWith('blob app/scripts/scaffolding/shared.mts '))).toBe(true);
      expect(alpha.lines.some((line) => line.startsWith('blob app/scripts/release-shared.mts '))).toBe(true);
      // A dev script and a test file point at tooling no build reads.
      expect(alpha.lines.some((line) => line.includes('unrelated-tooling'))).toBe(false);
      const document = unitInputsDocument({
        ...alpha,
        sourceRevision: runGit(root, ['rev-parse', 'HEAD']),
        unitId: 'alpha',
      });
      expect(EffectArray.sort(Object.keys(document), Order.String)).toEqual([
        'digest',
        'lines',
        'sourceRevision',
        'unitId',
        'version',
      ]);
      expect(unitArtifactName('alpha', alpha.digest)).toBe(`edge-unit-alpha-${alpha.digest}`);
    }),
  ),
);

it.live('a dependency change fans out to its dependents only', () =>
  withRepository((root) =>
    Effect.gen(function* fanOut() {
      const before = digests(path.join(root, 'app'));
      const workspaceRoot = yield* commit(root, { 'app/verticals/alpha/src/index.ts': 'export const alpha = 2;\n' });
      expect(changedUnits(before, digests(workspaceRoot))).toEqual([SHELL, 'alpha', 'beta']);
      const afterAlpha = digests(workspaceRoot);
      yield* commit(root, { 'app/packages/core/src/index.ts': 'export const core = 2;\n' });
      expect(changedUnits(afterAlpha, digests(workspaceRoot))).toEqual([SHELL, 'alpha', 'beta']);
    }),
  ),
);

it.live('a relative import leaving the package and a tsconfig-referenced project are unit inputs', () =>
  withRepository((root) =>
    Effect.gen(function* relativeInputs() {
      const before = digests(path.join(root, 'app'));
      const workspaceRoot = yield* commit(root, { 'app/scripts/gamma-helper.mts': 'export const helper = 2;\n' });
      expect(changedUnits(before, digests(workspaceRoot))).toEqual(['gamma']);
      const afterHelper = digests(workspaceRoot);
      yield* commit(root, { 'app/database/schema.ts': 'export const schema = 2;\n' });
      expect(changedUnits(afterHelper, digests(workspaceRoot))).toEqual([SHELL]);
      const afterDatabase = digests(workspaceRoot);
      yield* commit(root, { 'app/scripts/unrelated-tooling.mts': 'export const tooling = 2;\n' });
      expect(changedUnits(afterDatabase, digests(workspaceRoot))).toEqual([]);
    }),
  ),
);

it.live('a global input or the build environment invalidates every unit', () =>
  withRepository((root) =>
    Effect.gen(function* globalInputs() {
      let previous = digests(path.join(root, 'app'));
      for (const file of [
        'app/pnpm-lock.yaml',
        'app/tsconfig.base.json',
        'app/patches/x.patch',
        'app/topology/cloudflare-placement.json',
        'app/scripts/release-shared.mts',
        '.github/actions/install-app/action.yml',
      ]) {
        const workspaceRoot = yield* commit(root, { [file]: `${file} changed\n` });
        const next = digests(workspaceRoot);
        expect(changedUnits(previous, next)).toEqual([...UNIT_IDS]);
        previous = next;
      }
      const workspaceRoot = yield* commit(root, {
        'app/topology/application-release-intent.json': json({ modules: [] }),
      });
      expect(changedUnits(previous, digests(workspaceRoot))).toEqual([]);
      const toggled = computeUnitDigest({
        env: { ...BUILD_ENV, ULTRAMODERN_DISABLE_BUILD_TS_CHECKER: '1' },
        secretFingerprints: fingerprints(),
        unitId: 'gamma',
        workspaceRoot,
      });
      expect(toggled.digest).not.toBe(previous.gamma);
    }),
  ),
);

it.live('rotating a secret changes only its owner, and the Shell secret also changes Projects', () =>
  withRepository((root) =>
    Effect.sync(() => {
      const workspaceRoot = path.join(root, 'app');
      const before = digests(workspaceRoot);
      const rotatedAlpha = JSON.stringify({ ...SECRET_RECORD, alpha: { TOKEN: 'rotated' } });
      expect(changedUnits(before, digests(workspaceRoot, rotatedAlpha))).toEqual(['alpha']);
      // Key order is not content.
      const reordered = JSON.stringify(Object.fromEntries(EffectArray.reverse(Object.entries(SECRET_RECORD))));
      expect(reordered).not.toBe(SECRETS);
      expect(changedUnits(before, digests(workspaceRoot, reordered))).toEqual([]);
      const rotatedShell = JSON.stringify({ ...SECRET_RECORD, [SHELL]: { BETTER_AUTH_SECRET: 'rotated' } });
      expect(changedUnits(before, digests(workspaceRoot, rotatedShell))).toEqual([SHELL, 'projects']);
      expect(Object.values(fingerprints()).every((value) => /^[\da-f]{64}$/u.test(value))).toBe(true);
      expect(JSON.stringify(fingerprints())).not.toContain('rotated');
    }),
  ),
);

it.live('host, storefront and database digests follow only their own inputs', () =>
  withRepository((root) =>
    Effect.gen(function* auxiliaryDigests() {
      const workspaceRoot = path.join(root, 'app');
      const host = computeHostDigest({ env: BUILD_ENV, secretFingerprints: fingerprints(), workspaceRoot });
      expect(host.owners).toEqual([SHELL, 'alpha']);
      const storefront = computeStorefrontDigest({ env: BUILD_ENV, workspaceRoot });
      const database = computeDatabaseInputsDigest({ workspaceRoot });
      yield* commit(root, { 'app/scripts/migrate-helper.mts': 'export const migrate = 2;\n' });
      expect(computeDatabaseInputsDigest({ workspaceRoot }).digest).not.toBe(database.digest);
      expect(computeHostDigest({ env: BUILD_ENV, secretFingerprints: fingerprints(), workspaceRoot }).digest).toBe(
        host.digest,
      );
      yield* commit(root, { 'app/verticals/gamma/src/index.ts': 'export const gamma = 2;\n' });
      expect(computeHostDigest({ env: BUILD_ENV, secretFingerprints: fingerprints(), workspaceRoot }).digest).toBe(
        host.digest,
      );
      expect(computeStorefrontDigest({ env: BUILD_ENV, workspaceRoot }).digest).toBe(storefront.digest);
      yield* commit(root, { 'app/zerops.yaml': 'zerops: [changed]\n' });
      expect(computeHostDigest({ env: BUILD_ENV, secretFingerprints: fingerprints(), workspaceRoot }).digest).not.toBe(
        host.digest,
      );
      expect(
        computeStorefrontDigest({ env: { ...BUILD_ENV, STOREFRONT_IMAGE_HOSTS: 'cdn.example' }, workspaceRoot }).digest,
      ).not.toBe(storefront.digest);
    }),
  ),
);

interface FakeArtifact {
  readonly entries?: Readonly<Record<string, string>>;
  readonly id: number;
  readonly name: string;
  readonly runId: number;
}

interface FakeRun {
  readonly branch?: string;
  readonly event?: string;
  readonly headRepository?: string;
  readonly headSha?: string;
  readonly id: number;
  readonly path?: string;
}

interface FakeWorld {
  readonly artifacts: readonly FakeArtifact[];
  readonly runs: readonly FakeRun[];
  readonly versions: Readonly<Record<string, string>>;
}

/** A stored-or-deflated zip archive, as GitHub's artifact download endpoint returns. */
const zipOf = (entries: Readonly<Record<string, string>>): Buffer => {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const data = Buffer.from(text);
    const compressed = deflateRawSync(data);
    const fileName = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04_03_4b_50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(fileName.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02_01_4b_50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(fileName.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, fileName, compressed);
    centrals.push(central, fileName);
    offset += local.length + fileName.length + compressed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06_05_4b_50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
};

const runIdentity = (run: FakeRun) => ({
  event: run.event ?? 'push',
  head_branch: run.branch ?? TRUSTED_PRODUCER.branch,
  head_repository: {
    full_name: run.headRepository ?? REPOSITORY,
    id: run.headRepository === undefined ? REPOSITORY_ID : 99,
  },
  head_sha: run.headSha ?? REV_A,
  id: run.id,
  path: run.path ?? TRUSTED_PRODUCER.workflowPath,
  repository: { full_name: REPOSITORY, id: REPOSITORY_ID },
});

const respond = (body: JsonValue, status = 200) => Promise.resolve(Response.json(body, { status }));

/** GitHub and Cloudflare, answered from one in-memory world. */
const fakeFetch =
  (world: FakeWorld): typeof globalThis.fetch =>
  (input) => {
    const url = new URL(new Request(input).url);
    const script = /\/workers\/scripts\/(?<name>[^/]+)\/deployments$/u.exec(url.pathname)?.groups?.name;
    if (url.hostname === 'api.cloudflare.com' && script !== undefined) {
      const version = world.versions[decodeURIComponent(script)];
      return version === undefined
        ? respond({ success: false }, 404)
        : respond({
            result: { deployments: [{ versions: [{ percentage: 100, version_id: version }] }] },
            success: true,
          });
    }
    const runId = /\/actions\/runs\/(?<id>\d+)$/u.exec(url.pathname)?.groups?.id;
    const run = world.runs.find((candidate) => String(candidate.id) === runId);
    if (run !== undefined) {
      return respond(runIdentity(run));
    }
    const zipId = /\/actions\/artifacts\/(?<id>\d+)\/zip$/u.exec(url.pathname)?.groups?.id;
    const zipped = world.artifacts.find((artifact) => String(artifact.id) === zipId);
    if (zipped !== undefined) {
      return Promise.resolve(new Response(new Uint8Array(zipOf(zipped.entries ?? {}))));
    }
    if (url.pathname.endsWith('/actions/artifacts')) {
      const name = url.searchParams.get('name');
      return respond({
        artifacts: world.artifacts
          .filter((artifact) => artifact.name === name)
          .map((artifact) => {
            const producer = world.runs.find((candidate) => candidate.id === artifact.runId);
            return {
              created_at: new Date(Date.UTC(2026, 9, 1, 0, 0, artifact.id)).toISOString(),
              expired: false,
              id: artifact.id,
              name: artifact.name,
              workflow_run: {
                head_branch: producer?.branch ?? TRUSTED_PRODUCER.branch,
                head_repository_id: producer?.headRepository === undefined ? REPOSITORY_ID : 99,
                head_sha: producer?.headSha ?? REV_A,
                id: artifact.runId,
                repository_id: REPOSITORY_ID,
              },
            };
          }),
      });
    }
    return respond({ message: 'not found' }, 404);
  };

const NOW = new Date('2026-10-28T12:00:00Z');
const ONLINE_ENV = {
  ...BUILD_ENV,
  ALL_RELEASE_SECRETS: SECRETS,
  CLOUDFLARE_API_TOKEN: 'cloudflare-token',
  GITHUB_API_URL: 'https://api.github.test',
  GITHUB_REPOSITORY: REPOSITORY,
  GITHUB_RUN_ID: '500',
  GITHUB_TOKEN: 'github-token',
  ONTOS_SHELL_URL: 'https://shell.example/',
  ONTOS_SHELL_WORKER_NAME: 'app-shell-super-app',
  RELEASE_FINGERPRINT_KEY: KEY,
  STOREFRONT_CATALOG_KV_ID: 'kv-1',
  STOREFRONT_IMAGE_HOSTS: '',
};

/** Workers are named by the build marker, which hashes unit, content and source revision. */
const receiptPlan = (unitId: string, digest: string, sourceRevision: string) => {
  const marker = `${digest.slice(0, 8)}${sourceRevision.slice(0, 4)}`;
  const assetsScriptName = `ontos-assets-${marker}`;
  return {
    appId: unitId,
    assetsOrigin: `https://${assetsScriptName}.${SUBDOMAIN}.workers.dev/`,
    assetsScriptName,
    backendScriptName: `ontos-backend-${marker}`,
    buildMarker: createHash('sha256').update(`${unitId}:${digest}:${sourceRevision}`).digest('hex'),
    sourceRevision,
  };
};

const shellReceipt = (digest: string, sourceRevision: string = REV_A) => ({
  artifacts: { assetsSha256: 'c'.repeat(64), workerSha256: 'd'.repeat(64) },
  assetsVersionId: `assets-${SHELL}-${sourceRevision.slice(0, 4)}`,
  plan: receiptPlan(SHELL, digest, sourceRevision),
});

const moduleReceipt = (unitId: string, digest: string, sourceRevision: string = REV_A) => {
  const plan = receiptPlan(unitId, digest, sourceRevision);
  return {
    artifacts: { assetsSha256: 'c'.repeat(64), workerSha256: 'd'.repeat(64) },
    assetsVersionId: `assets-${unitId}-${sourceRevision.slice(0, 4)}`,
    backend: {
      baseUrl: 'https://x/',
      transport: 'cloudflare-worker',
      versionId: `backend-${unitId}-${sourceRevision.slice(0, 4)}`,
      workerName: plan.backendScriptName,
    },
    plan,
  };
};

/** A world where a trusted earlier run built, uploaded and recorded every unit at the current digests. */
const deployedWorld = (workspaceRoot: string): FakeWorld & { readonly ledgerText: string } => {
  const unitDigests = digests(workspaceRoot);
  const host = computeHostDigest({ env: BUILD_ENV, secretFingerprints: fingerprints(), workspaceRoot });
  let ledger = mergeLedgers([], {
    digestVersion: DIGEST_VERSION,
    now: NOW,
    runId: '400',
    sourceRevision: REV_A,
  });
  const versions: Record<string, string> = {};
  for (const unitId of UNIT_IDS) {
    const digest = unitDigests[unitId];
    if (unitId === SHELL) {
      const receipt = shellReceipt(digest);
      ledger = recordUnitReceipt(ledger, { digest, now: NOW, receipt, runId: '400', unitId });
      versions[receipt.plan.assetsScriptName] = receipt.assetsVersionId;
    } else {
      const receipt = moduleReceipt(unitId, digest);
      ledger = recordUnitReceipt(ledger, { digest, now: NOW, receipt, runId: '400', unitId });
      versions[receipt.plan.assetsScriptName] = receipt.assetsVersionId;
      versions[receipt.backend.workerName] = receipt.backend.versionId;
    }
  }
  ledger = recordHost(ledger, { digest: host.digest, now: NOW, runId: '400', sourceRevision: REV_A });
  const ledgerText = serializeLedger(ledger);
  return {
    artifacts: [
      { entries: { [LEDGER_FILE]: ledgerText }, id: 10, name: LEDGER_ARTIFACT_NAME, runId: 400 },
      ...UNIT_IDS.map((unitId, index) => ({
        id: 20 + index,
        name: unitArtifactName(unitId, unitDigests[unitId]),
        runId: 400,
      })),
      { id: 30, name: hostArtifactName(host.digest), runId: 400 },
      {
        id: 31,
        name: storefrontArtifactName(computeStorefrontDigest({ env: ONLINE_ENV, workspaceRoot }).digest),
        runId: 400,
      },
    ],
    ledgerText,
    runs: [{ id: 400 }],
    versions,
  };
};

const plan = (workspaceRoot: string, world: FakeWorld, env: Readonly<Record<string, string>> = ONLINE_ENV) =>
  Effect.promise(() =>
    planDeployment({ env, fetch: fakeFetch(world), forceFull: false, now: NOW, offline: false, workspaceRoot }),
  );

it.live('keeps live units and the host, and rebuilds the whole host group when one owner changes', () =>
  withRepository((root) =>
    Effect.gen(function* hostGroup() {
      const workspaceRoot = path.join(root, 'app');
      const world = deployedWorld(workspaceRoot);
      const kept = yield* plan(workspaceRoot, world);
      expect(kept.forceFull).toBe(false);
      expect(Object.fromEntries(kept.units.map((unit) => [unit.id, unit.mode]))).toEqual(
        Object.fromEntries(UNIT_IDS.map((unitId) => [unitId, 'retain'])),
      );
      expect(kept.host.mode).toBe('retain');
      expect(kept.storefront.mode).toBe('reuse');
      expect(kept.database.mode).toBe('auto');
      expect(planOutputs(kept)).toMatchObject({ build_count: '0', build_matrix: '[]', host_mode: 'retain' });

      // gamma is outside the host group: only it rebuilds.
      yield* commit(root, { 'app/verticals/gamma/src/index.ts': 'export const gamma = 2;\n' });
      const gamma = yield* plan(workspaceRoot, world);
      expect(gamma.units.filter((unit) => unit.mode === 'build').map((unit) => unit.id)).toEqual(['gamma']);
      expect(gamma.host.mode).toBe('retain');

      // beta depends on alpha but is no host owner; alpha is: the host and every owner build at HEAD.
      yield* commit(root, { 'app/verticals/alpha/src/index.ts': 'export const alpha = 2;\n' });
      const alpha = yield* plan(workspaceRoot, world);
      expect(alpha.host.mode).toBe('build');
      expect(alpha.units.filter((unit) => unit.mode === 'build').map((unit) => unit.id)).toEqual([
        SHELL,
        'alpha',
        'beta',
        'gamma',
      ]);
      const matrix: unknown = JSON.parse(planOutputs(alpha).build_matrix);
      expect(matrix).toContainEqual(expect.objectContaining({ id: 'alpha', path: 'verticals/alpha' }));
    }),
  ),
);

it.live('a deleted Worker, a missing Shell artifact or a missing host artifact stops reuse', () =>
  withRepository((root) =>
    Effect.gen(function* liveChecks() {
      const workspaceRoot = path.join(root, 'app');
      const world = deployedWorld(workspaceRoot);
      const projectsReceipt = moduleReceipt('projects', digests(workspaceRoot).projects);
      const deleted = yield* plan(workspaceRoot, {
        ...world,
        versions: Object.fromEntries(
          Object.entries(world.versions).filter(([name]) => name !== projectsReceipt.backend.workerName),
        ),
      });
      expect(deleted.units.find((unit) => unit.id === 'projects')?.mode).toBe('reupload');
      const shellArtifact = unitArtifactName(SHELL, digests(workspaceRoot)[SHELL]);
      const noShellBuild = yield* plan(workspaceRoot, {
        ...world,
        artifacts: world.artifacts.filter((artifact) => artifact.name !== shellArtifact),
      });
      expect(noShellBuild.units.find((unit) => unit.id === SHELL)?.mode).toBe('build');
      expect(noShellBuild.host.mode).toBe('build');
      const noHost = yield* plan(workspaceRoot, {
        ...world,
        artifacts: world.artifacts.filter((artifact) => !artifact.name.startsWith('outbox-host-')),
      });
      expect(noHost.host.mode).toBe('build');
      expect(noHost.units.filter((unit) => unit.mode === 'build').map((unit) => unit.id)).toEqual([SHELL, 'alpha']);
    }),
  ),
);

it.live('only the trusted stage deploy runs on the demo branch of this repository supply reuse', () =>
  withRepository((root) =>
    Effect.gen(function* trustFilter() {
      const workspaceRoot = path.join(root, 'app');
      const world = deployedWorld(workspaceRoot);
      for (const untrusted of [
        { headRepository: 'attacker/ontos' },
        { branch: 'main' },
        { event: 'pull_request' },
        { path: '.github/workflows/other.yml' },
      ]) {
        const result = yield* plan(workspaceRoot, { ...world, runs: [{ id: 400, ...untrusted }] });
        expect(result.units.every((unit) => unit.mode === 'build')).toBe(true);
        expect(result.host.mode).toBe('build');
        expect(result.ledger.units).toEqual({});
      }
      const run = runIdentity({ id: 1 });
      const artifact = {
        created_at: NOW.toISOString(),
        expired: false,
        id: 2,
        name: LEDGER_ARTIFACT_NAME,
        workflow_run: {
          head_branch: TRUSTED_PRODUCER.branch,
          head_repository_id: REPOSITORY_ID,
          id: 1,
          repository_id: REPOSITORY_ID,
        },
      };
      expect(isTrustedProducerRun(run, { repository: REPOSITORY })).toBe(true);
      expect(isTrustedArtifact(artifact, run, { repository: REPOSITORY })).toBe(true);
      expect(isTrustedArtifact({ ...artifact, expired: true }, run, { repository: REPOSITORY })).toBe(false);
      expect(
        isTrustedArtifact({ ...artifact, workflow_run: { ...artifact.workflow_run, head_repository_id: 99 } }, run, {
          repository: REPOSITORY,
        }),
      ).toBe(false);
      expect(
        isTrustedProducerRun(runIdentity({ headRepository: 'attacker/ontos', id: 1 }), { repository: REPOSITORY }),
      ).toBe(false);
    }),
  ),
);

it.live('forces a full rebuild without the fingerprint key, on request, or when the digest scheme changes', () =>
  withRepository((root) =>
    Effect.gen(function* forceFull() {
      const workspaceRoot = path.join(root, 'app');
      const world = deployedWorld(workspaceRoot);
      const { RELEASE_FINGERPRINT_KEY: _key, ...withoutKey } = ONLINE_ENV;
      const keyless = yield* plan(workspaceRoot, world, withoutKey);
      expect(keyless.forceFull).toBe(true);
      expect(keyless.forceFullReasons).toEqual(['fingerprint-key-missing']);
      expect(keyless.units.every((unit) => unit.mode === 'build' && unit.secretFingerprint === 'unavailable')).toBe(
        true,
      );
      expect(keyless.database.mode).toBe('full');
      expect(keyless.host.mode).toBe('build');
      expect(keyless.storefront.mode).toBe('build');
      const variable = yield* plan(workspaceRoot, world, { ...ONLINE_ENV, STAGE_DEMO_FORCE_FULL: 'true' });
      expect(variable.forceFullReasons).toEqual(['repository-variable']);
      const requested = yield* Effect.promise(() =>
        planDeployment({
          env: ONLINE_ENV,
          fetch: fakeFetch(world),
          forceFull: true,
          now: NOW,
          offline: false,
          workspaceRoot,
        }),
      );
      expect(planOutputs(requested)).toMatchObject({
        build_count: String(UNIT_IDS.length),
        db_mode: 'full',
        force_full: 'true',
      });
      const oldScheme = world.ledgerText.replace(
        `"digestVersion": "${DIGEST_VERSION}"`,
        '"digestVersion": "ontos-deploy-plan-v0"',
      );
      const changed = yield* plan(workspaceRoot, {
        ...world,
        artifacts: world.artifacts.map((artifact) =>
          artifact.name === LEDGER_ARTIFACT_NAME ? { ...artifact, entries: { [LEDGER_FILE]: oldScheme } } : artifact,
        ),
      });
      expect(changed.forceFullReasons).toEqual(['digest-version-changed']);
      const corrupt = yield* plan(workspaceRoot, {
        ...world,
        artifacts: world.artifacts.map((artifact) =>
          artifact.name === LEDGER_ARTIFACT_NAME
            ? { ...artifact, entries: { [LEDGER_FILE]: '{"version":' } }
            : artifact,
        ),
      });
      expect(corrupt.forceFullReasons).toEqual(['ledger-lookup-failed']);
      const missingInputs = yield* commit(root, {
        'app/scripts/ci/database-preparation-inputs.json': json({ globs: [] }),
      });
      const unreadable = yield* plan(missingInputs, world);
      expect(unreadable.forceFullReasons).toEqual(['database-inputs-unreadable']);
      expect(unreadable.database).toMatchObject({ inputsDigest: null, mode: 'full' });
    }),
  ),
);

const LATER = new Date(NOW.getTime() + 60_000);

/**
 * Run 401 at REV_B changed alpha, so it rebuilt the whole host group: the Shell's digest stayed the same, but its
 * Workers and build output carry REV_B. HEAD then rolled alpha back to REV_A's content, the host digest of run 400.
 */
const rebuiltAtRevisionB = (
  workspaceRoot: string,
  world: FakeWorld & { readonly ledgerText: string },
  { hostDeployed }: { readonly hostDeployed: boolean },
) => {
  const shellDigest = digests(workspaceRoot)[SHELL];
  const alphaB = 'c'.repeat(64);
  const shellB = shellReceipt(shellDigest, REV_B);
  const alphaReceiptB = moduleReceipt('alpha', alphaB, REV_B);
  let ledger = mergeLedgers([parseLedger(world.ledgerText)], {
    digestVersion: DIGEST_VERSION,
    now: LATER,
    runId: '401',
    sourceRevision: REV_B,
  });
  ledger = recordUnitReceipt(ledger, { digest: shellDigest, now: LATER, receipt: shellB, runId: '401', unitId: SHELL });
  ledger = recordUnitReceipt(ledger, {
    digest: alphaB,
    now: LATER,
    receipt: alphaReceiptB,
    runId: '401',
    unitId: 'alpha',
  });
  if (hostDeployed) {
    ledger = recordHost(ledger, { digest: 'd'.repeat(64), now: LATER, runId: '401', sourceRevision: REV_B });
  }
  return {
    artifacts: [
      ...world.artifacts,
      { entries: { [LEDGER_FILE]: serializeLedger(ledger) }, id: 40, name: LEDGER_ARTIFACT_NAME, runId: 401 },
      { id: 41, name: unitArtifactName(SHELL, shellDigest), runId: 401 },
      { id: 42, name: unitArtifactName('alpha', alphaB), runId: 401 },
      { id: 43, name: hostArtifactName('d'.repeat(64)), runId: 401 },
    ],
    runs: [...world.runs, { headSha: REV_B, id: 401 }],
    versions: {
      ...world.versions,
      [alphaReceiptB.backend.workerName]: alphaReceiptB.backend.versionId,
      [alphaReceiptB.plan.assetsScriptName]: alphaReceiptB.assetsVersionId,
      [shellB.plan.assetsScriptName]: shellB.assetsVersionId,
    },
  } satisfies FakeWorld;
};

const modes = (result: Awaited<ReturnType<typeof planDeployment>>) =>
  Object.fromEntries(result.units.map((unit) => [unit.id, unit.mode]));

it.live(
  'keeps the host only with every owner from the host build revision, after a rollback or a partial release',
  () =>
    withRepository((root) =>
      Effect.gen(function* hostRevision() {
        const workspaceRoot = path.join(root, 'app');
        const world = deployedWorld(workspaceRoot);
        const shellDigest = digests(workspaceRoot)[SHELL];
        const shellArtifactA = world.artifacts.find(
          (artifact) => artifact.name === unitArtifactName(SHELL, shellDigest),
        );

        // Rollback: REV_B's newer, live, content-equal Shell receipt and artifact must not join REV_A's host.
        const rolledBack = yield* plan(workspaceRoot, rebuiltAtRevisionB(workspaceRoot, world, { hostDeployed: true }));
        expect(rolledBack.forceFull).toBe(false);
        expect(rolledBack.host).toMatchObject({ artifact: { id: 30, sourceRevision: REV_A }, mode: 'retain' });
        const shell = rolledBack.units.find((unit) => unit.id === SHELL);
        expect(shell).toMatchObject({ artifact: { id: shellArtifactA?.id, sourceRevision: REV_A }, mode: 'retain' });
        expect(shell?.receipt?.plan.sourceRevision).toBe(REV_A);
        expect(shell?.receipt?.plan.buildMarker).not.toBe(shellReceipt(shellDigest, REV_B).plan.buildMarker);
        expect(rolledBack.units.find((unit) => unit.id === 'alpha')?.receipt?.plan.sourceRevision).toBe(REV_A);
        // The ledger carries forward the receipt the composition keeps.
        expect(rolledBack.ledger.units[shellDigest]?.sourceRevision).toBe(REV_A);

        // Partial release: run 401 never deployed its host and run 400's ledger expired, so only REV_B's Shell receipt
        // is known. The Shell re-uploads REV_A's build instead, and the host stays.
        const partial = rebuiltAtRevisionB(workspaceRoot, world, { hostDeployed: false });
        const withoutLedgerA = {
          ...partial,
          artifacts: partial.artifacts.filter((artifact) => artifact.id !== 10),
        };
        const reuploaded = yield* plan(workspaceRoot, withoutLedgerA);
        expect(reuploaded.host.mode).toBe('retain');
        expect(reuploaded.units.find((unit) => unit.id === SHELL)).toMatchObject({
          artifact: { id: shellArtifactA?.id, sourceRevision: REV_A },
          mode: 'reupload',
          receipt: null,
        });

        // Without REV_A's Shell build no owner group matches the host: the host and every owner build at HEAD, even
        // though REV_B's Shell Workers are live.
        const incoherent = yield* plan(workspaceRoot, {
          ...withoutLedgerA,
          artifacts: withoutLedgerA.artifacts.filter((artifact) => artifact.id !== shellArtifactA?.id),
        });
        expect(incoherent.host).toMatchObject({ artifact: null, mode: 'build' });
        expect(modes(incoherent)).toEqual({
          alpha: 'build',
          beta: 'retain',
          gamma: 'retain',
          projects: 'retain',
          [SHELL]: 'build',
        });
      }),
    ),
);

it.live('a build-only dispatch never pairs its newer Shell build with the older live Shell receipt', () =>
  withRepository((root) =>
    Effect.gen(function* buildOnlyDispatch() {
      const workspaceRoot = path.join(root, 'app');
      const world = deployedWorld(workspaceRoot);
      const unitDigests = digests(workspaceRoot);
      const shellName = unitArtifactName(SHELL, unitDigests[SHELL]);
      const shellArtifactA = world.artifacts.find((artifact) => artifact.name === shellName);
      // Run 402 at REV_B built every unit (newer, content-equal artifacts) and uploaded nothing.
      const dispatched = {
        ...world,
        artifacts: [
          ...world.artifacts,
          ...UNIT_IDS.map((unitId, index) => ({
            id: 50 + index,
            name: unitArtifactName(unitId, unitDigests[unitId]),
            runId: 402,
          })),
        ],
        runs: [...world.runs, { event: 'workflow_dispatch', headSha: REV_B, id: 402 }],
      } satisfies FakeWorld;
      const kept = yield* plan(workspaceRoot, dispatched);
      const shell = kept.units.find((unit) => unit.id === SHELL);
      expect(shell).toMatchObject({ artifact: { id: shellArtifactA?.id, sourceRevision: REV_A }, mode: 'retain' });
      expect(shell?.receipt?.plan.sourceRevision).toBe(REV_A);
      expect(kept.host.mode).toBe('retain');

      // REV_A's Shell build expired: its live Workers cannot be kept without their own build output, and REV_B's
      // build cannot join REV_A's host, so the host group builds.
      const expired = yield* plan(workspaceRoot, {
        ...dispatched,
        artifacts: dispatched.artifacts.filter((artifact) => artifact.id !== shellArtifactA?.id),
      });
      expect(expired.host.mode).toBe('build');
      expect(expired.units.find((unit) => unit.id === SHELL)).toMatchObject({ artifact: null, mode: 'build' });
    }),
  ),
);

it.live('verify recomputes the storefront digest, and unset storefront literals rebuild the storefront', () =>
  withRepository((root) =>
    Effect.gen(function* storefrontDigest() {
      const workspaceRoot = path.join(root, 'app');
      const planned = yield* Effect.promise(() =>
        planDeployment({
          env: ONLINE_ENV,
          fetch: fakeFetch({ artifacts: [], runs: [], versions: {} }),
          forceFull: false,
          now: NOW,
          offline: true,
          workspaceRoot,
        }),
      );
      expect(verifyPlan({ env: ONLINE_ENV, plan: planned, workspaceRoot })).toBe(planned.sourceRevision);
      expect(() =>
        verifyPlan({ env: { ...ONLINE_ENV, STOREFRONT_IMAGE_HOSTS: 'cdn.example' }, plan: planned, workspaceRoot }),
      ).toThrow(/akros-storefront/u);
      expect(() =>
        verifyPlan({
          env: ONLINE_ENV,
          plan: { ...planned, storefront: { ...planned.storefront, digest: '0'.repeat(64) } },
          workspaceRoot,
        }),
      ).toThrow(/for: akros-storefront$/u);

      const world = deployedWorld(workspaceRoot);
      const { STOREFRONT_IMAGE_HOSTS: _hosts, ...withoutLiteral } = ONLINE_ENV;
      const unknown = yield* plan(workspaceRoot, world, withoutLiteral);
      expect(unknown.storefront).toMatchObject({ artifact: null, mode: 'build' });
      expect(unknown.units.every((unit) => unit.mode === 'retain')).toBe(true);
    }),
  ),
);

it('the ledger carries records forward within retention and rejects malformed documents', () => {
  const run = { digestVersion: DIGEST_VERSION, now: NOW, runId: '2', sourceRevision: 'f'.repeat(40) };
  const digest = 'a'.repeat(64);
  const old = recordUnitReceipt(mergeLedgers([], { ...run, now: new Date('2026-07-01T00:00:00Z'), runId: '1' }), {
    digest: 'b'.repeat(64),
    now: new Date('2026-07-01T00:00:00Z'),
    receipt: moduleReceipt('alpha', 'b'.repeat(64)),
    runId: '1',
    unitId: 'alpha',
  });
  let fresh = recordUnitReceipt(mergeLedgers([], run), {
    digest,
    now: NOW,
    receipt: moduleReceipt('alpha', digest),
    runId: '2',
    unitId: 'alpha',
  });
  fresh = recordDatabase(fresh, {
    identityFp: 'fp',
    inputsDigest: '9'.repeat(64),
    now: NOW,
    runId: '2',
    stateHash: 'c'.repeat(64),
  });
  const merged = mergeLedgers([parseLedger(serializeLedger(fresh)), parseLedger(serializeLedger(old))], {
    ...run,
    runId: '3',
  });
  expect(Object.keys(merged.units)).toEqual([digest]);
  expect(merged.database?.stateHash).toBe('c'.repeat(64));
  expect(merged.version).toBe(LEDGER_VERSION);
  expect(() =>
    recordUnitReceipt(fresh, { digest, now: NOW, receipt: moduleReceipt('beta', digest), runId: '2', unitId: 'alpha' }),
  ).toThrow(/belongs to beta/u);
  expect(() => parseLedger('{"version":"other"}')).toThrow(/not a/u);
  expect(() => parseLedger(serializeLedger(fresh).replace(digest, 'd'.repeat(64)))).toThrow(/keyed by another digest/u);
  const wrongRevision = parseLedger(serializeLedger(fresh));
  const record = wrongRevision.units[digest];
  expect(() =>
    parseLedger(
      serializeLedger({
        ...wrongRevision,
        units: { [digest]: { ...record, sourceRevision: REV_B } },
      }),
    ),
  ).toThrow(/another source revision/u);
  const entries = readZipEntries(zipOf({ [LEDGER_FILE]: serializeLedger(fresh), 'other.txt': 'x' }));
  expect(parseLedger(entries.get(LEDGER_FILE)?.toString('utf-8') ?? '')).toEqual(fresh);
});
