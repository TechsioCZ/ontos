import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

import { NodeServices } from '@effect/platform-node';
import { ConfigProvider, Duration, Effect, Layer, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  checkStagedOwners,
  deployStagedHost,
  discardStagedHost,
  stagingFiles,
  uploadStagedHost,
  userDataFingerprint,
} from '../ci/stage-outbox-host.mts';
import { OpsShellLive } from '../ops/ops-shell.mts';
import { ZeropsApiError } from '../zerops-public-api-error.mts';
import { ZeropsPublicApi, ZeropsServiceStackIdSchema } from '../zerops-public-api.mts';
import type { ZeropsServiceUserData } from '../zerops-public-api.mts';

const SERVICE = 'host-service';
const SERVICE_STACK = Schema.decodeUnknownSync(ZeropsServiceStackIdSchema)(SERVICE);
const DIGEST = 'd'.repeat(64);
const SECRET = 'synthetic-host-secret-never-written';
const UPLOAD_URL = 'https://storage.example.test/signed-upload-never-written';
const HOST_RUNTIME = 'app/.zerops/runtime/outbox-worker-host';
const OWNERS = [
  { appId: 'shell-super-app', buildMarker: 'a'.repeat(64), sourceRevision: 'b'.repeat(40) },
  { appId: 'party-registry', buildMarker: 'c'.repeat(64), sourceRevision: 'e'.repeat(40) },
];

interface FakeVersion {
  readonly id: string;
  status: string;
}

interface FakeZerops {
  /** Runs after each version is created: a configuration writer racing the staging. */
  afterCreate?: () => void;
  readonly calls: string[];
  readonly deployed: { readonly id: string; readonly setup: string; readonly yaml: string }[];
  readonly uploads: Uint8Array[];
  userData: ZeropsServiceUserData[];
  readonly versions: FakeVersion[];
}

const unused = () => Effect.die('Unexpected API method');

const fakeZerops = (): FakeZerops & { readonly layer: Layer.Layer<ZeropsPublicApi> } => {
  const state: FakeZerops = {
    calls: [],
    deployed: [],
    uploads: [],
    userData: [{ content: Redacted.make(SECRET), id: 'user-data-1', key: 'RECOVERY_KEY' }],
    versions: [],
  };
  const versionOf = (id: string): Effect.Effect<FakeVersion, ZeropsApiError> => {
    const version = state.versions.find((candidate) => candidate.id === id);
    return version === undefined
      ? Effect.fail(new ZeropsApiError({ message: `no application version ${id}` }))
      : Effect.succeed(version);
  };
  const api = ZeropsPublicApi.of({
    appVersion: (id) =>
      versionOf(id).pipe(Effect.map((version) => ({ id, serviceStackId: SERVICE_STACK, status: version.status }))),
    createAppVersion: (serviceId, name) =>
      Effect.sync(() => {
        state.calls.push(`create ${serviceId} ${name}`);
        const id = `version-${String(state.versions.length + 1)}`;
        state.versions.push({ id, status: 'UPLOADING' });
        state.afterCreate?.();
        return { id, uploadUrl: Redacted.make(UPLOAD_URL) };
      }),
    createServiceSecret: unused,
    deleteAppVersion: (id) =>
      versionOf(id).pipe(
        Effect.flatMap((version) =>
          Effect.sync(() => {
            state.calls.push(`delete ${id}`);
            version.status = 'DELETED';
          }),
        ),
      ),
    deleteService: unused,
    deleteServiceSecret: unused,
    deployAppVersion: (id, yaml, setup) =>
      versionOf(id).pipe(
        Effect.flatMap((version) =>
          Effect.sync(() => {
            state.calls.push(`deploy ${id}`);
            state.deployed.push({ id, setup, yaml });
            version.status = 'ACTIVE';
          }),
        ),
      ),
    enableSubdomainAccess: unused,
    findServiceStack: unused,
    findServiceStackIdentity: unused,
    projectEnvFile: unused,
    projectEnvs: unused,
    serviceSecrets: unused,
    serviceStack: unused,
    serviceUserData: (serviceId) =>
      Effect.sync(() => {
        state.calls.push(`read ${serviceId}`);
        return state.userData;
      }),
    stopService: unused,
    uploadAppVersionPackage: (url, archive) =>
      Effect.sync(() => {
        expect(Redacted.value(url)).toBe(UPLOAD_URL);
        state.uploads.push(archive);
        const version = state.versions.at(-1);
        if (version !== undefined) {
          version.status = 'WAITING_TO_DEPLOY';
        }
      }),
    upsertProjectEnv: unused,
  });
  return Object.assign(state, { layer: Layer.succeed(ZeropsPublicApi, api) });
};

const config = (attempt = '1') =>
  ConfigProvider.layer(
    ConfigProvider.fromUnknown({
      GITHUB_RUN_ATTEMPT: attempt,
      GITHUB_RUN_ID: '42',
      GITHUB_SHA: 'f'.repeat(40),
      RELEASE_FINGERPRINT_KEY: 'fingerprint-key',
      ZEROPS_OUTBOX_WORKER_HOST_SERVICE_ID: SERVICE,
    }),
  );

const run = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  zerops: { readonly layer: Layer.Layer<ZeropsPublicApi> },
  attempt = '1',
) =>
  effect.pipe(
    Effect.provide(Layer.mergeAll(zerops.layer, OpsShellLive.pipe(Layer.provideMerge(NodeServices.layer)))),
    Effect.provide(config(attempt)),
  );

/** A prebuilt host archive laid out as scripts/ci/build-outbox-host.sh packs it, carrying `digest`. */
const hostArchive = (root: string, digest: string) => {
  const tree = path.join(root, 'tree');
  const runtime = path.join(tree, HOST_RUNTIME);
  mkdirSync(path.join(runtime, 'node/bin'), { recursive: true });
  writeFileSync(path.join(runtime, 'worker.mjs'), 'export {};\n');
  writeFileSync(path.join(runtime, 'node/bin/node'), '#!/bin/sh\n');
  chmodSync(path.join(runtime, 'node/bin/node'), 0o755);
  writeFileSync(
    path.join(runtime, 'worker-artifact.json'),
    JSON.stringify({
      artifactDigest: digest,
      ownerBuildIdentities: OWNERS,
      schemaVersion: 3,
      serviceId: 'outbox-worker-host',
    }),
  );
  const archive = path.join(root, 'outbox-host.tar.zst');
  const packed = spawnSync('/bin/sh', ['-c', 'tar -c -f - -C "$1" app | zstd --quiet -o "$2"', 'pack', tree, archive], {
    encoding: 'utf-8',
  });
  expect(packed.status).toBe(0);
  return archive;
};

const withStaging = <A, E, R>(use: (root: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => mkdtempSync(path.join(os.tmpdir(), 'stage-outbox-host-'))),
    use,
    (root) => Effect.sync(() => rmSync(root, { force: true, recursive: true })),
  );

const stagedDirectory = (root: string) => {
  const directory = path.join(root, 'stage');
  mkdirSync(directory, { recursive: true });
  return directory;
};

it('fingerprints every user data entry by value, independently of order, without exposing it', () => {
  const key = Redacted.make('fingerprint-key');
  const entries: ZeropsServiceUserData[] = [
    { content: Redacted.make(SECRET), id: 'one', key: 'A' },
    { content: Redacted.make('other'), id: 'two', key: 'B' },
  ];
  const fingerprint = userDataFingerprint(key, entries);
  expect(fingerprint).toMatch(/^[\da-f]{64}$/u);
  expect(userDataFingerprint(key, entries.toReversed())).toBe(fingerprint);
  expect(userDataFingerprint(key, [entries[0], { ...entries[1], content: Redacted.make('rotated') }])).not.toBe(
    fingerprint,
  );
  expect(userDataFingerprint(key, entries.slice(0, 1))).not.toBe(fingerprint);
  // A value cannot imitate the field boundary of a neighbour.
  expect(userDataFingerprint(key, [{ content: Redacted.make('x'), id: 'one', key: 'AB' }])).not.toBe(
    userDataFingerprint(key, [{ content: Redacted.make('Bx'), id: 'one', key: 'A' }]),
  );
});

it.live('uploads the verified artifact, packed as zcli packs the runtime, to an inactive version', () =>
  withStaging((root) =>
    Effect.gen(function* uploadsStagedHost() {
      const zerops = fakeZerops();
      const directory = stagedDirectory(root);
      yield* run(uploadStagedHost({ artifact: hostArchive(root, DIGEST), digest: DIGEST, directory }), zerops);
      expect(zerops.calls).toEqual([`read ${SERVICE}`, `create ${SERVICE} ${'f'.repeat(40)}`, `read ${SERVICE}`]);
      expect(zerops.deployed).toEqual([]);
      const [upload] = zerops.uploads;
      const listing = spawnSync('/usr/bin/tar', ['-t', '-f', '-'], {
        encoding: 'utf-8',
        input: gunzipSync(upload ?? []),
      });
      expect(listing.stdout.split('\n')).toEqual(
        expect.arrayContaining(['app/', `${HOST_RUNTIME}/worker.mjs`, `${HOST_RUNTIME}/node/bin/node`]),
      );
      const receiptText = readFileSync(stagingFiles(directory).receipt, 'utf-8');
      expect(JSON.parse(receiptText)).toMatchObject({
        appVersionId: 'version-1',
        artifactDigest: DIGEST,
        attempt: '42-1',
        deployStarted: false,
        owners: OWNERS,
        serviceId: SERVICE,
        uploaded: true,
      });
      expect(receiptText).not.toContain(SECRET);
      expect(receiptText).not.toContain(UPLOAD_URL);
    }),
  ),
);

it.live('stages nothing for another artifact, a stopped release or a configuration change during creation', () =>
  withStaging((root) =>
    Effect.gen(function* refusesStaging() {
      const archive = hostArchive(root, DIGEST);
      const wrong = fakeZerops();
      const mismatch = yield* Effect.flip(
        run(uploadStagedHost({ artifact: archive, digest: 'e'.repeat(64), directory: path.join(root, 'a') }), wrong),
      );
      expect(mismatch.message).toContain('not the planned one');
      expect(wrong.calls).toEqual([]);

      const stopped = fakeZerops();
      const stoppedDirectory = path.join(root, 'b');
      mkdirSync(stoppedDirectory);
      writeFileSync(stagingFiles(stoppedDirectory).stop, '');
      const stop = yield* Effect.flip(
        run(uploadStagedHost({ artifact: archive, digest: DIGEST, directory: stoppedDirectory }), stopped),
      );
      expect(stop.message).toContain('stopped before');
      expect(stopped.calls).toEqual([]);

      const raced = fakeZerops();
      raced.afterCreate = () => {
        raced.userData = [];
      };
      const racedDirectory = path.join(root, 'c');
      const race = yield* Effect.flip(
        run(uploadStagedHost({ artifact: archive, digest: DIGEST, directory: racedDirectory }), raced),
      );
      expect(race.message).toContain('changed while');
      expect(raced.uploads).toEqual([]);
      // The created version stays discardable.
      expect(JSON.parse(readFileSync(stagingFiles(racedDirectory).receipt, 'utf-8'))).toMatchObject({
        appVersionId: 'version-1',
        uploaded: false,
      });
    }),
  ),
);

it.live('publishes nothing unless the staged host carries every published owner build', () =>
  withStaging((root) =>
    Effect.gen(function* checksOwners() {
      const zerops = fakeZerops();
      const directory = stagedDirectory(root);
      yield* run(uploadStagedHost({ artifact: hostArchive(root, DIGEST), digest: DIGEST, directory }), zerops);
      const receipts = path.join(root, 'receipts');
      mkdirSync(receipts);
      const writeReceipt = (appId: string, buildMarker: string) =>
        writeFileSync(path.join(receipts, `${appId}.json`), JSON.stringify({ plan: { appId, buildMarker } }));
      for (const { appId, buildMarker } of OWNERS) {
        writeReceipt(appId, buildMarker);
      }
      yield* run(checkStagedOwners({ directory, receipts }), zerops);
      writeReceipt('party-registry', '0'.repeat(64));
      const failure = yield* Effect.flip(run(checkStagedOwners({ directory, receipts }), zerops));
      expect(failure.message).toContain('published build of: party-registry');
      rmSync(path.join(receipts, 'shell-super-app.json'));
      const missing = yield* Effect.flip(run(checkStagedOwners({ directory, receipts }), zerops));
      expect(missing.message).toContain('shell-super-app, party-registry');
    }),
  ),
);

it.live('deploys exactly the staged version once, and replaces it when the configuration changed', () =>
  withStaging((root) =>
    Effect.gen(function* deploysStagedHost() {
      const archive = hostArchive(root, DIGEST);
      const yamlFile = path.join(root, 'zerops.yaml');
      writeFileSync(yamlFile, 'zerops:\n  - setup: outbox-worker-host\n');

      const unchanged = fakeZerops();
      const directory = path.join(root, 'unchanged');
      yield* run(uploadStagedHost({ artifact: archive, digest: DIGEST, directory }), unchanged);
      const otherAttempt = yield* Effect.flip(
        run(deployStagedHost({ digest: DIGEST, directory, zeropsYaml: yamlFile }), unchanged, '2'),
      );
      expect(otherAttempt.message).toContain('another attempt');
      const otherDigest = yield* Effect.flip(
        run(deployStagedHost({ digest: 'e'.repeat(64), directory, zeropsYaml: yamlFile }), unchanged),
      );
      expect(otherDigest.message).toContain('another attempt, service, digest or deploy');
      yield* run(deployStagedHost({ digest: DIGEST, directory, zeropsYaml: yamlFile }), unchanged);
      expect(unchanged.deployed).toEqual([
        { id: 'version-1', setup: 'outbox-worker-host', yaml: 'zerops:\n  - setup: outbox-worker-host\n' },
      ]);
      expect(unchanged.calls.filter((call) => call.startsWith('create '))).toHaveLength(1);
      const again = yield* Effect.flip(
        run(deployStagedHost({ digest: DIGEST, directory, zeropsYaml: yamlFile }), unchanged),
      );
      expect(again.message).toContain('deploy');
      expect(unchanged.deployed).toHaveLength(1);

      // The configuration apply created a host secret after staging: the staged version is retired unused.
      const changed = fakeZerops();
      const changedDirectory = path.join(root, 'changed');
      yield* run(uploadStagedHost({ artifact: archive, digest: DIGEST, directory: changedDirectory }), changed);
      changed.userData = [
        ...changed.userData,
        { content: Redacted.make('created'), id: 'user-data-2', key: 'ANOTHER_KEY' },
      ];
      yield* run(deployStagedHost({ digest: DIGEST, directory: changedDirectory, zeropsYaml: yamlFile }), changed);
      expect(changed.calls.filter((call) => /^(?:create|delete|deploy) /u.test(call))).toEqual([
        `create ${SERVICE} ${'f'.repeat(40)}`,
        'delete version-1',
        `create ${SERVICE} ${'f'.repeat(40)}`,
        'deploy version-2',
      ]);
      expect(changed.uploads).toHaveLength(2);
      expect(changed.uploads[1]).toEqual(changed.uploads[0]);
    }),
  ),
);

it.live('discards only the run attempt’s own never-deployed version', () =>
  withStaging((root) =>
    Effect.gen(function* discardsStagedHost() {
      const archive = hostArchive(root, DIGEST);
      const wait = Duration.seconds(5);

      const none = fakeZerops();
      yield* run(discardStagedHost({ directory: path.join(root, 'never-started'), waitFor: wait }), none);
      const empty = path.join(root, 'empty');
      mkdirSync(empty);
      yield* run(discardStagedHost({ directory: empty, waitFor: wait }), none);
      expect(none.calls).toEqual([]);
      // The stop file makes a staging that has not created a version yet create none.
      expect(existsSync(stagingFiles(empty).stop)).toBe(true);

      const undeployed = fakeZerops();
      const staged = path.join(root, 'staged');
      yield* run(uploadStagedHost({ artifact: archive, digest: DIGEST, directory: staged }), undeployed);
      writeFileSync(stagingFiles(staged).exitCode, '0\n');
      yield* run(discardStagedHost({ directory: staged, waitFor: wait }), undeployed);
      expect(undeployed.calls.at(-1)).toBe('delete version-1');

      const deployed = fakeZerops();
      const live = path.join(root, 'live');
      yield* run(uploadStagedHost({ artifact: archive, digest: DIGEST, directory: live }), deployed);
      writeFileSync(stagingFiles(live).exitCode, '0\n');
      const yamlFile = path.join(root, 'zerops.yaml');
      writeFileSync(yamlFile, 'zerops: []\n');
      yield* run(deployStagedHost({ digest: DIGEST, directory: live, zeropsYaml: yamlFile }), deployed);
      yield* run(discardStagedHost({ directory: live, waitFor: wait }), deployed);
      expect(deployed.calls.some((call) => call.startsWith('delete '))).toBe(false);

      // A version that became active some other way is never deleted.
      const activated = fakeZerops();
      const active = path.join(root, 'active');
      yield* run(uploadStagedHost({ artifact: archive, digest: DIGEST, directory: active }), activated);
      writeFileSync(stagingFiles(active).exitCode, '0\n');
      const [version] = activated.versions;
      if (version !== undefined) {
        version.status = 'ACTIVE';
      }
      yield* run(discardStagedHost({ directory: active, waitFor: wait }), activated);
      expect(activated.calls.some((call) => call.startsWith('delete '))).toBe(false);
    }),
  ),
);
