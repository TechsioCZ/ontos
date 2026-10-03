import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DateTime, Duration, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { governedSharedSingletonPackages } from '../../module-federation.shared.ts';
import { OntosShellRuntimeContractSchema } from '../../packages/core-runtime/src/modules/application-composition.ts';
import {
  ONTOS_MODULE_CONTRACT_SCHEMA_VERSION,
  OntosModuleDeploymentContractSchema,
} from '../../packages/core-runtime/src/modules/manifest.ts';
import { deriveActiveApplicationCompositionSnapshot } from '../active-application-composition.mts';
import { deriveLocalTopologyProofPaths, LocalTopologyOwnerSchema } from '../cloudflare-local-topology-fixture.mts';
import { createShellRuntimeContract } from '../generate-ontos-shell-runtime-contract.mts';

const partyAppId = 'party-registry';
const partyModuleId = 'party.registry';
const partyComponentKey = 'party.registry.page-people';
const partyEntrypointKey = 'party.registry.page.people';
const partyExpose = './People';
const partyRemoteName = 'partyRegistry';
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
          backend: { baseUrl: 'https://localhost:8791/', transport: 'node-http' },
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
    baseUrl: 'https://localhost:8791/',
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
