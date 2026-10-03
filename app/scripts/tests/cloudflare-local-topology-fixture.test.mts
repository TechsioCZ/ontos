import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { brotliCompressSync, gzipSync } from 'node:zlib';

import { NodeHttpServer, NodeServices } from '@effect/platform-node';
import { DateTime, Duration, Effect, Match, Ref, Schema } from 'effect';
import { HttpServerRequest, HttpServerResponse } from 'effect/unstable/http';
import { NetAddress } from 'effect/unstable/net';
import { ChildProcess } from 'effect/unstable/process';
import { expect, it } from 'effect-rstest';

import { governedSharedSingletonPackages } from '../../module-federation.shared.ts';
import { OntosShellRuntimeContractSchema } from '../../packages/core-runtime/src/modules/application-composition.ts';
import {
  ONTOS_MODULE_CONTRACT_SCHEMA_VERSION,
  OntosModuleDeploymentContractSchema,
} from '../../packages/core-runtime/src/modules/manifest.ts';
import {
  decodeActiveApplicationCompositionSnapshot,
  deriveActiveApplicationCompositionSnapshot,
  encodeActiveApplicationCompositionSnapshot,
} from '../active-application-composition.mts';
import {
  deriveLocalTopologyProofPaths,
  deriveLocalWorkerdProofFixture,
  discoverLocalTopologyOwners,
  LocalTopologyOwnerSchema,
} from '../cloudflare-local-topology-fixture.mts';
import { createShellRuntimeContract } from '../generate-ontos-shell-runtime-contract.mts';
import { collectToolingProcess } from './tooling-process-fixture.mts';

const partyAppId = 'party-registry';
const partyModuleId = 'party.registry';
const partyComponentKey = 'party.registry.page-people';
const partyEntrypointKey = 'party.registry.page.people';
const partyExpose = './People';
const partyRemoteName = 'partyRegistry';
const partyOwnerBaseUrl = 'https://localhost:8791/';
const federationManifestFixtureSchema = Schema.Struct({
  exposes: Schema.Array(Schema.Struct({ path: Schema.NonEmptyString })),
  name: Schema.NonEmptyString,
  shared: Schema.Array(
    Schema.Struct({ name: Schema.NonEmptyString, requiredVersion: Schema.NonEmptyString, singleton: Schema.Boolean }),
  ),
});
const decodeModuleContract = Schema.decodeUnknownSync(OntosModuleDeploymentContractSchema, {
  onExcessProperty: 'error',
});
const encodeModuleContract = Schema.encodeSync(Schema.fromJsonString(OntosModuleDeploymentContractSchema));
const encodeFederationManifest = Schema.encodeSync(Schema.fromJsonString(federationManifestFixtureSchema));
const encodeShellRuntimeContract = Schema.encodeSync(Schema.fromJsonString(OntosShellRuntimeContractSchema));

const artifact = (url: string, document: string) => ({
  bytes: new TextEncoder().encode(document),
  url,
});

const snapshot = (routePath: string) =>
  Effect.gen(function* approvedLocalFixture() {
    const shared = governedSharedSingletonPackages.map((name) => ({ name, requiredVersion: '1.0.0', singleton: true }));
    return yield* deriveActiveApplicationCompositionSnapshot({
      environment: 'development',
      modules: [
        {
          appId: partyAppId,
          backend: { baseUrl: partyOwnerBaseUrl, transport: 'node-http' },
          contract: artifact(
            'https://localhost:8791/.well-known/ontos-module-manifest.json',
            encodeModuleContract(
              decodeModuleContract({
                deployment: { appId: partyAppId, buildMarker: 'party-local-build' },
                manifest: {
                  activation: {
                    defaultState: 'inactive',
                    preservesHistoryWhenInactive: true,
                    scope: 'tenant',
                    supportedStates: ['inactive', 'active'],
                  },
                  module: {
                    description: 'Local fixture',
                    displayName: 'Party Registry',
                    id: partyModuleId,
                    implementedAs: 'ultramodern_microvertical',
                    kind: 'business_module',
                  },
                  publicSurface: {
                    actions: [],
                    api: [],
                    businessPermissions: [],
                    components: [{ expose: partyExpose, key: partyComponentKey, mfBoundaryId: partyRemoteName }],
                    events: [],
                    reports: [],
                    resourceTypes: [],
                    search: [],
                    shellContributions: {
                      mediaAttachments: [],
                      navigation: [],
                      pages: [
                        {
                          componentKey: partyComponentKey,
                          contributionKey: partyEntrypointKey,
                          entrypoint: {
                            access: 'read',
                            authorization: { kind: 'context_permission', permission: 'module.access' },
                            entrypointKey: partyEntrypointKey,
                            moduleKey: partyModuleId,
                            role: 'page',
                            scope: 'tenant',
                          },
                          expose: partyExpose,
                          routePath,
                        },
                      ],
                      publicComponents: [],
                      reports: [],
                      resourceDetails: [],
                      search: [],
                      timelines: [],
                    },
                  },
                },
                runtime: { outboxSubscriptions: [] },
                schemaVersion: ONTOS_MODULE_CONTRACT_SCHEMA_VERSION,
              }),
            ),
          ),
          federationManifest: artifact(
            'https://localhost:8791/mf-manifest.json',
            encodeFederationManifest({
              exposes: [{ path: partyExpose }],
              name: partyRemoteName,
              shared,
            }),
          ),
        },
      ],
      observedAt: yield* DateTime.now,
      shell: {
        federationManifest: artifact(
          'http://localhost:8787/mf-manifest.json',
          encodeFederationManifest({
            exposes: [],
            name: 'shellSuperApp',
            shared,
          }),
        ),
        runtimeContract: artifact(
          'http://localhost:8787/.well-known/ontos-shell-runtime.json',
          encodeShellRuntimeContract(createShellRuntimeContract('shell-local-build')),
        ),
      },
      validity: Duration.minutes(30),
    });
  });

it('accepts only explicit local canonical HTTPS owner mappings', () => {
  const decode = Schema.decodeUnknownSync(LocalTopologyOwnerSchema, { onExcessProperty: 'error' });
  const owner = {
    appId: partyAppId,
    baseUrl: partyOwnerBaseUrl,
    outputDirectory: '/owned/party/.output',
  };
  expect(decode(owner)).toEqual(owner);
  for (const baseUrl of [
    'http://localhost:8791/',
    'https://localhost/',
    'https://party-registry.example:8791/',
    'https://localhost:8791',
    'https://localhost:8791/private',
    'https://localhost:8791/?release=old',
    'https://fixture-secret@localhost:8791/',
  ]) {
    expect(() => decode({ ...owner, baseUrl })).toThrow();
  }
});

it('starts native Bash Workers with optional TLS and keeps cleanup owned by the parent', () => {
  const source = readFileSync(new URL('../prove-cloudflare-local-topology.sh', import.meta.url), 'utf-8');
  const startup = source.slice(source.indexOf('start_worker()'), source.indexOf('\nowner_port()'));
  const cleanup = source.slice(source.indexOf('cleanup()'), source.indexOf('\ntrap cleanup EXIT INT TERM'));
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ontos-cloudflare-bash-lifecycle-'));
  const worker = path.join(directory, 'fixture-worker');
  const run = path.join(directory, 'run');
  const marker = path.join(directory, 'foreign-marker');
  const setup =
    'work="$1"; wrangler="$2"; owner_private_key="known key"; owner_certificate="known cert"; pids=(); ready_logs=()';
  try {
    mkdirSync(path.join(run, 'logs'), { recursive: true });
    writeFileSync(worker, '#!/bin/bash\nprintf "<%s>\\n" "$@"\n');
    chmodSync(worker, 0o700);
    execFileSync('/bin/bash', [
      '-euo',
      'pipefail',
      '-c',
      `${setup}\n${startup}\nstart_worker http fixture 18887\nwait "\${pids[0]}"\nstart_worker https fixture 18890 https\nwait "\${pids[1]}"`,
      'fixture',
      run,
      worker,
    ]);
    const http = readFileSync(path.join(run, 'logs/http.log'), 'utf-8');
    expect(http).not.toContain('<--local-protocol>');
    expect(http).not.toContain('<>');
    expect(readFileSync(path.join(run, 'logs/https.log'), 'utf-8')).toContain(
      '<--local-protocol>\n<https>\n<--https-key-path>\n<known key>\n<--https-cert-path>\n<known cert>\n',
    );

    writeFileSync(marker, 'preserved');
    writeFileSync(worker, '#!/bin/bash\nexit 42\n');
    execFileSync('/bin/bash', [
      '-euo',
      'pipefail',
      '-c',
      `${setup}\nmarker="$3"\ncleanup() { rm -f "$marker"; }\ntrap cleanup EXIT\n${startup}\nstart_worker failed fixture 18887\nwait "\${pids[0]}" || status=$?\n[ "$status" = 42 ]\n[ -f "$marker" ]\ntrap - EXIT`,
      'fixture',
      run,
      worker,
      marker,
    ]);
    expect(readFileSync(marker, 'utf-8')).toBe('preserved');

    execFileSync('/bin/bash', [
      '-euo',
      'pipefail',
      '-c',
      `work="$1"; pids=(); dev_vars_outputs=(); local_configs=(); authority_fixture_started=false; shell_grant_withdrawn=false\n${cleanup}\ncleanup`,
      'fixture',
      run,
    ]);
    expect(existsSync(run)).toBe(false);
    expect(readFileSync(marker, 'utf-8')).toBe('preserved');
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

it.effect('derives page and complete release gateway paths from the approved contract', () =>
  Effect.gen(function* followsAdmittedContract() {
    const approved = yield* snapshot('/people');
    const paths = yield* deriveLocalTopologyProofPaths(approved);
    expect(paths.revision).toBe(approved.composition.revision);
    expect(paths.moduleIds).toEqual([partyModuleId]);
    expect(paths.party.shellPagePath).toBe('/en/people');
    expect(paths.party.ownerPagePath).toBe('/en/people');
    expect(paths.party.apiBaseUrl).toBe(
      '/shell-super-app-api/module-api/party-registry/party-local-build/party-registry-api',
    );
    expect(paths.party.entrypointKey).toBe(partyEntrypointKey);
    expect(paths.party.expose).toBe(partyExpose);
    expect(paths.party.remoteName).toBe(partyRemoteName);
    const [party] = approved.composition.modules;
    if (party?.federation.execution !== 'browser') {
      throw new Error('The test fixture must be a browser module');
    }
    expect(paths.party.federationManifest).toEqual(party.federation.manifest);
  }),
);

it.effect('rejects changed contract bytes and routes that need unprovided parameters', () =>
  Effect.gen(function* rejectsUnapprovedSelector() {
    const approved = yield* snapshot('/people');
    const altered = {
      ...approved,
      composition: {
        ...approved.composition,
        modules: approved.composition.modules.map((module) => ({
          ...module,
          contractDocument: `${module.contractDocument} `,
        })),
      },
    };
    expect(yield* deriveLocalTopologyProofPaths(altered).pipe(Effect.isFailure)).toBe(true);
    expect(
      yield* snapshot('/people/:partyId').pipe(Effect.flatMap(deriveLocalTopologyProofPaths), Effect.isFailure),
    ).toBe(true);
  }),
);

it.effect('seeds the exact approved snapshot and routes the native release API through its revision', () =>
  Effect.gen(function* provesNativeWorkerdPlacement() {
    const approved = yield* snapshot('/people');
    const fixture = yield* deriveLocalWorkerdProofFixture(approved);
    const value = yield* encodeActiveApplicationCompositionSnapshot(approved);
    expect(fixture.schemaVersion).toBe(1);
    expect(fixture.kvSeeds).toEqual([
      {
        appId: 'shell-super-app',
        binding: 'ONTOS_ACTIVE_APPLICATION_COMPOSITION',
        entries: [{ key: 'active', value }],
      },
      { appId: partyAppId, binding: 'ONTOS_ACTIVE_APPLICATION_COMPOSITION', entries: [{ key: 'active', value }] },
    ]);
    for (const seed of fixture.kvSeeds) {
      const [entry] = seed.entries;
      if (entry === undefined) {
        throw new Error('Every actual Worker must receive the approved active snapshot');
      }
      expect(yield* decodeActiveApplicationCompositionSnapshot(entry.value)).toEqual(approved);
    }
    expect(fixture.ownerTargets).toEqual([{ appId: partyAppId, baseUrl: partyOwnerBaseUrl }]);
    expect(fixture.shellApiTargets).toEqual([
      {
        appId: partyAppId,
        headers: { 'x-ontos-composition-revision': approved.composition.revision },
        routePrefix: '/shell-super-app-api/module-api/party-registry/party-local-build',
        shellId: 'shell-super-app',
      },
    ]);
  }),
);

it.effect('rejects changed artifact bytes rather than seeding an invented workerd composition', () =>
  Effect.gen(function* rejectsUnapprovedWorkerdPlacement() {
    const approved = yield* snapshot('/people');
    const altered = {
      ...approved,
      composition: {
        ...approved.composition,
        modules: approved.composition.modules.map((module) => ({
          ...module,
          contractDocument: `${module.contractDocument} `,
        })),
      },
    };
    expect(yield* deriveLocalWorkerdProofFixture(altered).pipe(Effect.isFailure)).toBe(true);
  }),
);

it.effect('discovers the selected artifact root without choosing stale workspace output paths', () =>
  Effect.gen(function* selectsActualArtifactRoot() {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'ontos-workerd-owner-discovery-'));
    try {
      mkdirSync(path.join(directory, 'verticals', partyAppId), { recursive: true });
      mkdirSync(path.join(directory, 'verticals', 'catalog'), { recursive: true });
      writeFileSync(path.join(directory, 'verticals', '.DS_Store'), 'not a delivery unit');
      const owners = yield* discoverLocalTopologyOwners(directory).pipe(Effect.provide(NodeServices.layer));
      expect(owners).toEqual([
        {
          appId: 'catalog',
          baseUrl: partyOwnerBaseUrl,
          outputDirectory: path.join(directory, 'verticals/catalog/.output'),
        },
        {
          appId: partyAppId,
          baseUrl: 'https://localhost:8792/',
          outputDirectory: path.join(directory, 'verticals/party-registry/.output'),
        },
      ]);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  }),
);

it('rejects missing or mixed native output selectors before observing any Worker artifacts', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ontos-workerd-placement-selectors-'));
  const args = [
    path.resolve('scripts/cloudflare-local-topology-fixture.mts'),
    'prepare',
    '--intent-file',
    path.resolve('topology/application-release-intent.json'),
    '--shell-origin',
    'http://localhost:8787',
    '--snapshot-file',
    path.join(directory, 'active.json'),
    '--paths-file',
    path.join(directory, 'paths.json'),
  ];
  try {
    const missing = spawnSync(process.execPath, args, { encoding: 'utf-8' });
    expect(missing.status).toBe(1);
    expect(missing.stdout + missing.stderr).toContain('CloudflareLocalTopologyFixtureError');
    expect(missing.stdout + missing.stderr).toContain('selectNativeOutputPlacement');
    for (const explicitSelector of ['--owners-file', '--shell-output']) {
      const mixed = spawnSync(process.execPath, [...args, '--artifact-root', directory, explicitSelector, directory], {
        encoding: 'utf-8',
      });
      expect(mixed.status).toBe(1);
      expect(mixed.stdout + mixed.stderr).toContain('CloudflareLocalTopologyFixtureError');
      expect(mixed.stdout + mixed.stderr).toContain('selectNativeOutputPlacement');
    }
    expect(existsSync(path.join(directory, 'active.json'))).toBe(false);
    expect(existsSync(path.join(directory, 'paths.json'))).toBe(false);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

it('aligns public proof roots and cleans its exact temporary directory when the native proof fails', () => {
  const packageSchema = Schema.Struct({ scripts: Schema.Struct({ 'cloudflare:ssr-proof': Schema.NonEmptyString }) });
  const command = Schema.decodeUnknownSync(Schema.fromJsonString(packageSchema))(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'),
  ).scripts['cloudflare:ssr-proof'];
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ontos-workerd-public-command-'));
  const metadataRoot = path.join(directory, 'metadata with spaces');
  const artifactRoot = path.join(directory, 'actual artifacts');
  const bin = path.join(directory, 'bin');
  const argumentsFile = path.join(directory, 'producer-arguments');
  const invocationFile = path.join(directory, 'native-proof-invocation');
  const cryptoInvocationFile = path.join(directory, 'native-crypto-invocations');
  const shellFile = path.join(artifactRoot, 'apps/shell-super-app/.output/.dev.vars');
  const partyFile = path.join(artifactRoot, 'verticals/party-registry/.output/.dev.vars');
  const proofDirectoryPrefix = 'ontos-workerd-proof.';
  try {
    mkdirSync(bin);
    mkdirSync(metadataRoot);
    mkdirSync(path.join(artifactRoot, 'apps/shell-super-app/.output'), { recursive: true });
    mkdirSync(path.join(artifactRoot, 'verticals/party-registry/.output'), { recursive: true });
    const producer = path.join(bin, 'node');
    writeFileSync(
      producer,
      [
        '#!/bin/sh',
        'if [ "$#" -eq 3 ] && [ "$1" = "--input-type=module" ] && [ "$2" = "-e" ] && [ "$3" = \'import { randomBytes } from "node:crypto"; process.stdout.write(randomBytes(32).toString("hex"));\' ]; then',
        String.raw`printf "crypto\n" >> "$PROOF_TEST_CRYPTO_INVOCATIONS"`,
        'exec "$PROOF_TEST_NATIVE_NODE" "$@"',
        'fi',
        'while [ "$#" -gt 0 ]; do',
        'case "$1" in',
        String.raw`--artifact-root|--intent-file) printf "%s=%s\n" "$1" "$2" >> "$PROOF_TEST_ARGUMENTS"; shift 2;;`,
        '*) shift;;',
        'esac',
        'done',
        '',
      ].join('\n'),
    );
    chmodSync(producer, 0o700);
    const nativeProof = path.join(bin, 'ultramodern-create');
    writeFileSync(
      nativeProof,
      '#!/bin/sh\ntest -d "$(dirname "$ULTRAMODERN_WORKERD_PROOF_FIXTURE")" || exit 43\nprintf "%s\\n" "$ULTRAMODERN_WORKERD_PROOF_FIXTURE" > "$PROOF_TEST_INVOCATION"\nexit 42\n',
    );
    chmodSync(nativeProof, 0o700);
    const proofEnv = {
      PATH: `${bin}:/usr/bin:/bin`,
      PROOF_TEST_ARGUMENTS: argumentsFile,
      PROOF_TEST_CRYPTO_INVOCATIONS: cryptoInvocationFile,
      PROOF_TEST_INVOCATION: invocationFile,
      PROOF_TEST_NATIVE_NODE: process.execPath,
      RUNNER_TEMP: directory,
      ULTRAMODERN_WORKERD_ARTIFACT_ROOT: artifactRoot,
      ULTRAMODERN_WORKSPACE_ROOT: metadataRoot,
    };
    const result = spawnSync('/bin/sh', ['-c', command], {
      cwd: path.resolve(import.meta.dirname, '../..'),
      encoding: 'utf-8',
      env: proofEnv,
    });
    expect(result.status).toBe(42);
    expect(readFileSync(argumentsFile, 'utf-8')).toBe(
      `--intent-file=${path.join(metadataRoot, 'topology/application-release-intent.json')}\n--artifact-root=${artifactRoot}\n`,
    );
    expect(readFileSync(invocationFile, 'utf-8')).toContain(path.join(directory, proofDirectoryPrefix));
    expect(existsSync(shellFile)).toBe(true);
    expect(existsSync(partyFile)).toBe(true);
    expect(readdirSync(directory).some((name) => name.startsWith(proofDirectoryPrefix))).toBe(false);
    const shellFields = readFileSync(shellFile, 'utf-8').trim().split('\n');
    const partyFields = readFileSync(partyFile, 'utf-8').trim().split('\n');
    const existingKeys = [
      'CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE',
      'SPICEDB_ENDPOINT',
      'SPICEDB_PRESHARED_KEY',
    ];
    expect(partyFields.length).toBe(3);
    expect(partyFields.map((line) => line.split('=', 1)[0])).toEqual(expect.arrayContaining(existingKeys));
    expect(shellFields.length).toBe(5);
    expect(shellFields.map((line) => line.split('=', 1)[0])).toEqual(
      expect.arrayContaining([...existingKeys, 'BETTER_AUTH_URL', 'BETTER_AUTH_SECRET']),
    );
    const authUrl = shellFields.find((line) => line.startsWith('BETTER_AUTH_URL='))?.slice('BETTER_AUTH_URL='.length);
    expect(authUrl).toBe('http://localhost:8787');
    expect(new URL(authUrl ?? '').protocol).toBe('http:');
    const firstSecret = shellFields
      .find((line) => line.startsWith('BETTER_AUTH_SECRET='))
      ?.slice('BETTER_AUTH_SECRET='.length);
    expect(firstSecret?.trim().length ?? 0).toBeGreaterThanOrEqual(32);
    expect(/^[a-f\d]{64}$/u.test(firstSecret ?? '')).toBe(true);
    expect(readFileSync(cryptoInvocationFile, 'utf-8')).toBe('crypto\n');

    const repeated = spawnSync('/bin/sh', ['-c', command], {
      cwd: path.resolve(import.meta.dirname, '../..'),
      encoding: 'utf-8',
      env: proofEnv,
    });
    expect(repeated.status).toBe(42);
    expect(readdirSync(directory).some((name) => name.startsWith(proofDirectoryPrefix))).toBe(false);
    const secondSecret = readFileSync(shellFile, 'utf-8')
      .split('\n')
      .find((line) => line.startsWith('BETTER_AUTH_SECRET='))
      ?.slice('BETTER_AUTH_SECRET='.length);
    expect(secondSecret?.trim().length ?? 0).toBeGreaterThanOrEqual(32);
    expect(/^[a-f\d]{64}$/u.test(secondSecret ?? '')).toBe(true);
    expect(secondSecret !== firstSecret).toBe(true);
    expect(readFileSync(cryptoInvocationFile, 'utf-8')).toBe('crypto\ncrypto\n');
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

it.live('decodes native curl JSON while preserving independent compressed wire evidence', () =>
  Effect.gen(function* provesStandardContentCoding() {
    const source = readFileSync(new URL('../prove-cloudflare-local-topology.sh', import.meta.url), 'utf-8');
    const requestStart = source.indexOf('\nrequest() {');
    expect(requestStart).toBeGreaterThanOrEqual(0);
    const requestEnd = source.indexOf('\n}\n', requestStart);
    expect(requestEnd).toBeGreaterThan(requestStart);
    const request = source.slice(requestStart + 1, requestEnd + 2);
    const document = '[]';
    const bytes = Buffer.from(document);
    const cases = [
      { bytes, coding: 'identity' },
      { bytes: gzipSync(bytes), coding: 'gzip' },
      { bytes: brotliCompressSync(bytes), coding: 'br' },
    ];
    const advertised = yield* Ref.make('');
    const server = yield* NodeHttpServer.make(() => process.getBuiltinModule('http').createServer(), {
      host: '127.0.0.1',
      port: 0,
    });
    yield* server.serve(
      HttpServerRequest.HttpServerRequest.use((incoming) =>
        Effect.gen(function* servesNativeCodedFixture() {
          const selected = cases.find(({ coding }) => incoming.url === `/${coding}`);
          if (selected === undefined) {
            return HttpServerResponse.empty({ status: 404 });
          }
          const acceptEncoding = incoming.headers['accept-encoding'];
          yield* Ref.set(advertised, acceptEncoding ?? '');
          const accepted = acceptEncoding?.split(',').map((value) => value.split(';')[0]?.trim());
          if (selected.coding !== 'identity' && accepted !== undefined && !accepted.includes(selected.coding)) {
            return HttpServerResponse.empty({ status: 406 });
          }
          return HttpServerResponse.uint8Array(selected.bytes, {
            contentType: 'application/json',
            headers: selected.coding === 'identity' ? {} : { 'content-encoding': selected.coding },
          });
        }),
      ),
    );
    const address = yield* Match.value(server.address).pipe(
      Match.when(NetAddress.isInetAddress, (inetAddress) => Effect.succeed(inetAddress)),
      Match.orElse(() => Effect.die('The content-coding fixture did not bind to TCP')),
    );
    const origin = `http://127.0.0.1:${address.port}`;
    const directory = mkdtempSync(path.join(os.tmpdir(), 'ontos-curl-content-coding-'));
    try {
      // Probe the real curl independently, so removing --compressed from request() cannot hide coded cases.
      const probe = yield* collectToolingProcess(
        ChildProcess.make(
          'curl',
          [
            '--silent',
            '--show-error',
            '--compressed',
            '--max-time',
            '30',
            '--output',
            path.join(directory, 'probe.json'),
            '--write-out',
            '%{http_code}',
            `${origin}/identity`,
          ],
          { extendEnv: true, stderr: 'pipe', stdin: 'ignore', stdout: 'pipe' },
        ),
      );
      expect(probe.status).toBe(0);
      expect(probe.stdout).toBe('200');
      expect(readFileSync(path.join(directory, 'probe.json'), 'utf-8')).toBe(document);
      const supported = new Set((yield* Ref.get(advertised)).split(',').map((value) => value.split(';')[0]?.trim()));
      const supportedCases = cases.filter(({ coding }) => coding === 'identity' || supported.has(coding));
      expect(supportedCases.length).toBeGreaterThan(1);
      for (const fixture of supportedCases) {
        const decodedFile = path.join(directory, `${fixture.coding}.decoded.json`);
        const decoded = yield* collectToolingProcess(
          ChildProcess.make(
            '/bin/bash',
            [
              '-euo',
              'pipefail',
              '-c',
              `work="$1"; shell_origin="$2"; owner_certificate="$work/unused-certificate"; jar="$work/cookies"\n${request}\nrequest "$3" "$4"`,
              'fixture',
              directory,
              origin,
              decodedFile,
              `${origin}/${fixture.coding}`,
            ],
            { extendEnv: true, stderr: 'pipe', stdin: 'ignore', stdout: 'pipe' },
          ),
        );
        expect(decoded.status).toBe(0);
        expect(decoded.stdout).toBe('200');
        expect(readFileSync(decodedFile, 'utf-8')).toBe(document);
        expect(
          Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.Unknown)))(
            readFileSync(decodedFile, 'utf-8'),
          ),
        ).toEqual([]);

        const rawFile = path.join(directory, `${fixture.coding}.raw`);
        const headerFile = path.join(directory, `${fixture.coding}.headers`);
        const raw = yield* collectToolingProcess(
          ChildProcess.make(
            'curl',
            [
              '--silent',
              '--show-error',
              '--raw',
              '--max-time',
              '30',
              '--dump-header',
              headerFile,
              '--output',
              rawFile,
              '--write-out',
              '%{http_code}',
              '--header',
              `accept-encoding: ${fixture.coding}`,
              `${origin}/${fixture.coding}`,
            ],
            { extendEnv: true, stderr: 'pipe', stdin: 'ignore', stdout: 'pipe' },
          ),
        );
        expect(raw.status).toBe(0);
        expect(raw.stdout).toBe('200');
        expect(readFileSync(rawFile)).toEqual(fixture.bytes);
        const headers = readFileSync(headerFile, 'utf-8').toLowerCase().split(/\r?\n/u);
        expect(headers).toContain(`content-length: ${fixture.bytes.byteLength}`);
        expect(headers).toContain('content-type: application/json');
        const contentEncoding = headers.find((header) => header.startsWith('content-encoding:'));
        if (fixture.coding === 'identity') {
          expect(contentEncoding).toBeUndefined();
        } else {
          expect(contentEncoding).toBe(`content-encoding: ${fixture.coding}`);
          expect(readFileSync(rawFile, 'utf-8')).not.toBe(document);
        }
      }
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
