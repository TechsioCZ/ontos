import { readFileSync } from 'node:fs';

import { DateTime, Duration, Effect, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  ActiveApplicationCompositionSnapshotSchema,
  ONTOS_SHELL_CONTRIBUTION_ABI,
} from '../../packages/core-runtime/src/index.ts';
import {
  ACTIVE_APPLICATION_COMPOSITION_POLICY,
  applicationCompositionRevision,
  assertNoConflictingPublication,
  deriveActiveApplicationCompositionSnapshot,
  deriveApplicationComposition,
  encodeActiveApplicationCompositionSnapshot,
} from '../active-application-composition.mts';
import type {
  ActiveApplicationCompositionObservation,
  ObservedArtifact,
  ObservedModuleDeployment,
} from '../active-application-composition.mts';
import {
  cloudflareOrigin,
  cloudflarePublicUrlVariable,
  modeWorkerSetups,
  otherModeWorkerSetups,
  serviceIdVariable,
} from '../publish-active-application-composition.mts';
import { createShellRuntimeContract } from '../generate-ontos-shell-runtime-contract.mts';
import { parseZeropsEnvFile } from '../zerops-public-api.mts';
import { ApplicationReleaseIntentSchema } from '../application-release-intent.mts';

const encoder = new TextEncoder();
const JsonText = Schema.fromJsonString(Schema.Unknown);
type JsonDocument = typeof JsonText.Type;
const artifact = (url: string, document: JsonDocument): ObservedArtifact => ({
  bytes: encoder.encode(Schema.encodeSync(JsonText)(document)),
  url,
});

const emptyContributions = {
  mediaAttachments: [],
  navigation: [],
  pages: [],
  publicComponents: [],
  reports: [],
  resourceDetails: [],
  search: [],
  timelines: [],
};

const moduleContract = (input: {
  readonly appId: string;
  readonly components: readonly { readonly expose: string; readonly key: string; readonly mfBoundaryId: string }[];
  readonly moduleId: string;
  readonly search: readonly string[];
}) => ({
  deployment: { appId: input.appId, buildMarker: `${input.appId}-build` },
  manifest: {
    activation: {
      defaultState: 'inactive',
      preservesHistoryWhenInactive: true,
      scope: 'tenant',
      supportedStates: ['inactive', 'active'],
    },
    module: {
      description: `${input.moduleId} module`,
      displayName: input.moduleId,
      id: input.moduleId,
      implementedAs: 'ultramodern_microvertical',
      kind: 'business_module',
    },
    publicSurface: {
      actions: [],
      api: [],
      businessPermissions: [],
      components: input.components,
      events: [],
      reports: [],
      resourceTypes: [],
      search: [],
      shellContributions: {
        ...emptyContributions,
        search: input.search.map((contributionKey) => ({
          accessDeclaration: {
            key: `${input.moduleId}.parties.search`,
            kind: 'read',
            modes: ['run'],
            placement: { group: 'parties', level: 'basic' },
            risk: 'sensitive',
            selectors: ['all'],
          },
          contributionKey,
          entrypoint: {
            access: 'read',
            authorization: { kind: 'protected' },
            entrypointKey: contributionKey,
            moduleKey: input.moduleId,
            role: 'search',
            scope: 'tenant',
          },
          searchKey: `${input.moduleId}.parties`,
        })),
      },
    },
  },
  runtime: { outboxSubscriptions: [] },
  schemaVersion: '2',
});

const shared = (entries: readonly (readonly [string, string])[]) =>
  entries.map(([name, version]) => ({ name, requiredVersion: version, singleton: true }));

const I18N_RUNTIME = '@modern-js/plugin-i18n/runtime';
const PARTY_MANIFEST_URL = 'https://party-registry.example/mf-manifest.json';

const governedShared = shared([
  [I18N_RUNTIME, '3.9.0'],
  ['@modern-js/runtime', '3.9.0'],
  ['@tanstack/react-router', '1.170.39'],
  ['react', '19.2.8'],
  ['react-dom', '19.2.8'],
  ['react-dom/client', '19.2.8'],
]);

const PARTY_REGISTRY = 'party-registry';
const PARTY_REMOTE = 'verticalPartyRegistry';
const CUSTOMER_CONTEXT = 'commerce-customer-context';
const CUSTOMER_CONTEXT_MODULE = 'commerce.customer-context';
const OUTBOX_WORKER_HOST_SETUP = 'outbox-worker-host';
const EXCLUDED_WORKER_OWNER = 'commerce-order';
const PRICE_GROUP_CATALOG = 'price-group-catalog';
const CUSTOMER_CONTEXT_WORKER = 'commerce-customer-context-worker';
const PARTY_MODULE = 'party.registry';
const PAGE_EXPOSE = './PageContacts';
const SHELL_MANIFEST_URL = 'https://shell.example/mf-manifest.json';
const SHELL_REMOTE = 'shellSuperApp';
const SHELL_APP = 'shell-super-app';

const partyRegistry: ObservedModuleDeployment = {
  appId: PARTY_REGISTRY,
  backend: { baseUrl: 'https://party-registry.example/', transport: 'node-http' },
  contract: artifact(
    'https://party-registry.example/.well-known/ontos-module-manifest.json',
    moduleContract({
      appId: PARTY_REGISTRY,
      components: [{ expose: PAGE_EXPOSE, key: 'party.registry.page-contacts', mfBoundaryId: PARTY_REMOTE }],
      moduleId: PARTY_MODULE,
      search: ['party.registry.search.parties'],
    }),
  ),
  federationManifest: artifact(PARTY_MANIFEST_URL, {
    exposes: [{ path: './Route' }, { path: PAGE_EXPOSE }],
    name: PARTY_REMOTE,
    shared: [...governedShared, { name: 'effect', requiredVersion: '4.0.0', singleton: true }],
  }),
};

const customerContext: ObservedModuleDeployment = {
  appId: CUSTOMER_CONTEXT,
  backend: { baseUrl: 'https://commerce-customer-context.example/', transport: 'node-http' },
  contract: artifact(
    'https://commerce-customer-context.example/.well-known/ontos-module-manifest.json',
    moduleContract({
      appId: CUSTOMER_CONTEXT,
      components: [],
      moduleId: CUSTOMER_CONTEXT_MODULE,
      search: [],
    }),
  ),
};

const observedAt = DateTime.makeUnsafe('2026-09-29T06:00:00.000Z');

const observation = (modules: readonly ObservedModuleDeployment[]): ActiveApplicationCompositionObservation => ({
  environment: 'stage',
  modules,
  observedAt,
  shell: {
    federationManifest: artifact(SHELL_MANIFEST_URL, {
      exposes: [],
      name: SHELL_REMOTE,
      shared: governedShared,
    }),
    runtimeContract: artifact(
      'https://shell.example/.well-known/ontos-shell-runtime.json',
      createShellRuntimeContract('shell-immutable-build'),
    ),
  },
  validity: ACTIVE_APPLICATION_COMPOSITION_POLICY.validity,
});

it.effect('derives expected content from pinned local bytes without creating observation or freshness evidence', () =>
  Effect.gen(function* derivesPlanningContent() {
    const observed = observation([partyRegistry, customerContext]);
    const expected = yield* deriveApplicationComposition({
      environment: observed.environment,
      modules: observed.modules,
      shell: observed.shell,
    });
    const snapshot = yield* deriveActiveApplicationCompositionSnapshot(observed);
    expect(expected).toEqual(snapshot.composition);
    expect(expected.revision).toBe(applicationCompositionRevision(expected));
    expect(expected).not.toHaveProperty('observedAt');
    expect(expected).not.toHaveProperty('validUntil');
    const later = yield* deriveActiveApplicationCompositionSnapshot({
      ...observed,
      observedAt: DateTime.add(observed.observedAt, { hours: 1 }),
    });
    expect(later.composition).toEqual(expected);
  }),
);

it.effect('derives a schema-valid snapshot of the complete browser and server-only inventory', () =>
  Effect.gen(function* derivesCompleteInventory() {
    const snapshot = yield* deriveActiveApplicationCompositionSnapshot(observation([partyRegistry, customerContext]));
    const { composition } = snapshot;

    expect(composition.modules.map(({ federation, moduleId }) => [moduleId, federation.execution])).toEqual([
      [CUSTOMER_CONTEXT_MODULE, 'server'],
      [PARTY_MODULE, 'browser'],
    ]);
    expect(composition.shell.contributionAbi).toEqual(ONTOS_SHELL_CONTRIBUTION_ABI);
    expect(composition.revision).toBe(applicationCompositionRevision(composition));
    expect(DateTime.formatIso(snapshot.validUntil)).toBe('2026-09-30T06:00:00.000Z');

    const party = composition.modules.find(({ moduleId }) => moduleId === PARTY_MODULE);
    expect(party?.federation).toMatchObject({
      exposes: [PAGE_EXPOSE, './Route'],
      remoteName: 'verticalPartyRegistry',
    });
    expect(party?.sharedSingletons.map(({ packageName }) => packageName)).not.toContain('effect');
    expect(party?.publicContract).toEqual({ id: PARTY_MODULE, sha256: party?.contract.sha256, version: '2' });

    const encoded = yield* encodeActiveApplicationCompositionSnapshot(snapshot);
    const decoded = yield* Schema.decodeEffect(Schema.fromJsonString(ActiveApplicationCompositionSnapshotSchema), {
      onExcessProperty: 'error',
    })(encoded);
    expect(decoded.composition).toEqual(composition);
    expect(decoded.composition.modules.find(({ moduleId }) => moduleId === PARTY_MODULE)?.contractDocument).toBe(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(partyRegistry.contract.bytes),
    );
  }),
);

it.effect('derives the same bytes regardless of observation order', () =>
  Effect.gen(function* deterministicDerivation() {
    const forward = yield* deriveActiveApplicationCompositionSnapshot(observation([partyRegistry, customerContext]));
    const reversed = yield* deriveActiveApplicationCompositionSnapshot(observation([customerContext, partyRegistry]));
    expect(yield* encodeActiveApplicationCompositionSnapshot(reversed)).toBe(
      yield* encodeActiveApplicationCompositionSnapshot(forward),
    );

    const withoutCustomerContext = yield* deriveActiveApplicationCompositionSnapshot(observation([partyRegistry]));
    expect(withoutCustomerContext.composition.revision).not.toBe(forward.composition.revision);
  }),
);

it.effect('binds exact non-ASCII contract bytes and renews freshness without changing release identity', () =>
  Effect.gen(function* exactContractAndFreshness() {
    const raw = `${new TextDecoder().decode(customerContext.contract.bytes).replace('commerce.customer-context module', 'Žluťoučký module')}\n `;
    const original = { ...customerContext, contract: { ...customerContext.contract, bytes: encoder.encode(raw) } };
    const snapshot = yield* deriveActiveApplicationCompositionSnapshot(observation([original]));
    const later = yield* deriveActiveApplicationCompositionSnapshot({
      ...observation([original]),
      observedAt: DateTime.addDuration(observedAt, Duration.hours(6)),
    });
    expect(snapshot.composition.modules[0]?.contractDocument).toBe(raw);
    expect(later.composition).toEqual(snapshot.composition);
    expect(DateTime.formatIso(later.validUntil)).toBe('2026-09-30T12:00:00.000Z');
    const normalized = yield* deriveActiveApplicationCompositionSnapshot(observation([customerContext]));
    expect(normalized.composition.revision).not.toBe(snapshot.composition.revision);
    const malformed = { ...customerContext, contract: { ...customerContext.contract, bytes: new Uint8Array([0xff]) } };
    expect((yield* Effect.flip(deriveActiveApplicationCompositionSnapshot(observation([malformed])))).reason).toBe(
      'invalid_observation',
    );
  }),
);

it.effect('binds the exact Shell artifact bytes and URLs into the approved revision', () =>
  Effect.gen(function* pinsShellArtifactEvidence() {
    const original = observation([customerContext]);
    const first = yield* deriveActiveApplicationCompositionSnapshot(original);
    expect(first.composition.shell.runtimeContract.url).toBe(original.shell.runtimeContract.url);
    expect(first.composition.shell.federationManifest.url).toBe(original.shell.federationManifest.url);
    const changedBytes = yield* deriveActiveApplicationCompositionSnapshot({
      ...original,
      shell: {
        ...original.shell,
        runtimeContract: {
          ...original.shell.runtimeContract,
          bytes: encoder.encode(`${new TextDecoder().decode(original.shell.runtimeContract.bytes)}\n`),
        },
      },
    });
    expect(changedBytes.composition.shell.deployment).toEqual(first.composition.shell.deployment);
    expect(changedBytes.composition.shell.runtimeContract.sha256).not.toBe(
      first.composition.shell.runtimeContract.sha256,
    );
    expect(changedBytes.composition.revision).not.toBe(first.composition.revision);
    const changedUrl = yield* deriveActiveApplicationCompositionSnapshot({
      ...original,
      shell: {
        ...original.shell,
        federationManifest: {
          ...original.shell.federationManifest,
          url: 'https://retained-shell.example/mf-manifest.json',
        },
      },
    });
    expect(changedUrl.composition.revision).not.toBe(first.composition.revision);
  }),
);

it.effect('rejects observations that contradict the deployment identity or Shell compatibility', () =>
  Effect.gen(function* rejectsContradictions() {
    const misidentified = yield* Effect.flip(
      deriveActiveApplicationCompositionSnapshot(observation([{ ...customerContext, appId: 'pricing' }])),
    );
    expect(misidentified.message).toMatch(/identifies commerce-customer-context, not pricing/u);

    const incompatibleShell = observation([partyRegistry]);
    const shellWithOldReact = {
      ...incompatibleShell,
      shell: {
        ...incompatibleShell.shell,
        federationManifest: artifact(SHELL_MANIFEST_URL, {
          exposes: [],
          name: SHELL_REMOTE,
          shared: shared([['react', '18.3.1']]),
        }),
      },
    };
    const incompatible = yield* Effect.flip(deriveActiveApplicationCompositionSnapshot(shellWithOldReact));
    expect(incompatible.message).toMatch(/share @modern-js\/plugin-i18n\/runtime exactly once/u);

    const olderReactShell = {
      ...incompatibleShell,
      shell: {
        ...incompatibleShell.shell,
        federationManifest: artifact(SHELL_MANIFEST_URL, {
          exposes: [],
          name: SHELL_REMOTE,
          shared: governedShared.map((entry) =>
            entry.name === 'react' ? { ...entry, requiredVersion: '18.3.1' } : entry,
          ),
        }),
      },
    };
    const olderReact = yield* Effect.flip(deriveActiveApplicationCompositionSnapshot(olderReactShell));
    expect(olderReact.message).toMatch(/valid Application Composition/u);

    const unsharedReact = observation([
      {
        ...partyRegistry,
        federationManifest: artifact(PARTY_MANIFEST_URL, {
          exposes: [{ path: PAGE_EXPOSE }],
          name: PARTY_REMOTE,
          shared: governedShared.map((entry) => (entry.name === 'react' ? { ...entry, singleton: false } : entry)),
        }),
      },
    ]);
    const unshared = yield* Effect.flip(deriveActiveApplicationCompositionSnapshot(unsharedReact));
    expect(unshared.message).toMatch(/does not share react exactly once/u);

    const withoutI18n = observation([
      {
        ...partyRegistry,
        federationManifest: artifact(PARTY_MANIFEST_URL, {
          exposes: [{ path: PAGE_EXPOSE }],
          name: PARTY_REMOTE,
          shared: governedShared.filter(({ name }) => name !== I18N_RUNTIME),
        }),
      },
    ]);
    const remoteWithoutI18n = yield* deriveActiveApplicationCompositionSnapshot(withoutI18n);
    expect(
      remoteWithoutI18n.composition.modules[0]?.sharedSingletons.map(({ packageName }) => packageName),
    ).not.toContain(I18N_RUNTIME);
  }),
);

it.effect('rejects conflicting writes under one revision and forged revisions', () =>
  Effect.gen(function* conflictingPublication() {
    const snapshot = yield* deriveActiveApplicationCompositionSnapshot(observation([partyRegistry, customerContext]));
    const encoded = yield* encodeActiveApplicationCompositionSnapshot(snapshot);

    yield* assertNoConflictingPublication(Option.none(), snapshot);
    yield* assertNoConflictingPublication(Option.some(encoded), snapshot);
    yield* assertNoConflictingPublication(Option.some('not a snapshot'), snapshot);
    const refreshed = { ...snapshot, observedAt: DateTime.addDuration(observedAt, Duration.hours(6)) };
    yield* assertNoConflictingPublication(Option.some(encoded), refreshed);

    const other = yield* deriveActiveApplicationCompositionSnapshot(observation([partyRegistry]));
    const sameRevisionOtherContent = yield* encodeActiveApplicationCompositionSnapshot({
      ...other,
      composition: { ...other.composition, revision: snapshot.composition.revision },
    });
    const conflict = yield* Effect.flip(
      assertNoConflictingPublication(Option.some(sameRevisionOtherContent), snapshot),
    );
    expect(conflict.reason).toBe('conflicting_revision');

    const forged = { ...snapshot, composition: { ...snapshot.composition, revision: 'f'.repeat(64) } };
    expect((yield* Effect.flip(assertNoConflictingPublication(Option.none(), forged))).reason).toBe(
      'conflicting_revision',
    );
  }),
);

it.effect('rejects older publications and ambiguous equal-time promotions before storage writes', () =>
  Effect.gen(function* orderedPublications() {
    const current = yield* deriveActiveApplicationCompositionSnapshot(observation([partyRegistry, customerContext]));
    const encoded = yield* encodeActiveApplicationCompositionSnapshot(current);
    const older = { ...current, observedAt: DateTime.addDuration(observedAt, Duration.hours(-1)) };
    expect((yield* Effect.flip(assertNoConflictingPublication(Option.some(encoded), older))).reason).toBe(
      'stale_observation',
    );
    const different = yield* deriveActiveApplicationCompositionSnapshot(observation([partyRegistry]));
    expect((yield* Effect.flip(assertNoConflictingPublication(Option.some(encoded), different))).reason).toBe(
      'stale_observation',
    );
    const shorterLease = { ...current, validUntil: DateTime.addDuration(current.validUntil, Duration.hours(-1)) };
    expect((yield* Effect.flip(assertNoConflictingPublication(Option.some(encoded), shorterLease))).reason).toBe(
      'stale_observation',
    );
  }),
);

const readReferenceTopology = () =>
  Schema.decodeUnknownSync(
    Schema.fromJsonString(
      Schema.Struct({
        verticals: Schema.Array(
          Schema.Struct({
            cloudflare: Schema.optionalKey(Schema.Struct({ workerName: Schema.optionalKey(Schema.String) })),
            id: Schema.String,
            package: Schema.optionalKey(Schema.String),
          }),
        ),
      }),
    ),
  )(readFileSync(new URL('../../topology/reference-topology.json', import.meta.url), 'utf-8'));

it.effect('resolves exactly the Outbox Worker mode setup definitions', () =>
  Effect.gen(function* workerModeSetups() {
    const zeropsYaml = readFileSync(new URL('../../zerops.yaml', import.meta.url), 'utf-8');
    const topology = readReferenceTopology();
    const intent = Schema.decodeUnknownSync(Schema.fromJsonString(ApplicationReleaseIntentSchema))(
      readFileSync(new URL('../../topology/application-release-intent.json', import.meta.url), 'utf-8'),
    );
    const members = intent.modules.map(({ appId }) => appId);
    expect(yield* otherModeWorkerSetups(zeropsYaml, topology, 'dedicated')).toEqual([OUTBOX_WORKER_HOST_SETUP]);
    expect(yield* otherModeWorkerSetups(zeropsYaml, topology, 'host')).toEqual([
      'party-registry-worker',
      CUSTOMER_CONTEXT_WORKER,
      'inventory-worker',
      'privacy-worker',
      'commerce-order-worker',
      'payment-worker',
      'symmy-integration-worker',
      'communications-worker',
    ]);
    expect(yield* modeWorkerSetups(zeropsYaml, topology, 'host', members)).toEqual([OUTBOX_WORKER_HOST_SETUP]);
    expect(yield* modeWorkerSetups(zeropsYaml, topology, 'dedicated', members)).toEqual([
      'party-registry-worker',
      CUSTOMER_CONTEXT_WORKER,
      'inventory-worker',
      'privacy-worker',
      'symmy-integration-worker',
    ]);
    expect(serviceIdVariable(OUTBOX_WORKER_HOST_SETUP)).toBe('ZEROPS_OUTBOX_WORKER_HOST_SERVICE_ID');
    expect(serviceIdVariable(CUSTOMER_CONTEXT_WORKER)).toBe('ZEROPS_COMMERCE_CUSTOMER_CONTEXT_WORKER_SERVICE_ID');
    expect(serviceIdVariable('shellsuperapp')).toBe('ZEROPS_SHELL_SERVICE_ID');
  }),
);

it.effect('excludes non-topology workers and undefined topology workers from mode setup inventory', () =>
  Effect.gen(function* excludesUndeclaredWorkerSetups() {
    const yaml = 'zerops:\n  - setup: catalog-worker\n  - setup: unrelated-worker\n  - setup: outbox-worker-host\n';
    const topology = { verticals: [{ id: 'catalog' }, { id: EXCLUDED_WORKER_OWNER }] };
    expect(yield* modeWorkerSetups(yaml, topology, 'dedicated', ['catalog'])).toEqual(['catalog-worker']);
    expect(yield* otherModeWorkerSetups(yaml, topology, 'host')).toEqual(['catalog-worker']);
    expect(yield* modeWorkerSetups(yaml, topology, 'host', ['catalog'])).toEqual([OUTBOX_WORKER_HOST_SETUP]);
    expect(yield* otherModeWorkerSetups(yaml, topology, 'dedicated')).toEqual([OUTBOX_WORKER_HOST_SETUP]);
    expect(yield* modeWorkerSetups(yaml, topology, 'dedicated', [EXCLUDED_WORKER_OWNER])).toEqual([]);
    expect(yield* modeWorkerSetups(yaml, topology, 'host', [EXCLUDED_WORKER_OWNER])).toEqual([]);
  }),
);

it.effect('observes a placed unit on Cloudflare at the Worker URL its edge build is given', () =>
  Effect.gen(function* cloudflareOrigins() {
    const placement = {
      buildEnvironment: {
        ULTRAMODERN_PUBLIC_URL_PRICE_GROUP_CATALOG: 'https://price-group-catalog.example.workers.dev',
        ULTRAMODERN_PUBLIC_URL_SHELL_SUPER_APP: 'https://stage.example.test',
      },
      units: [PRICE_GROUP_CATALOG, SHELL_APP],
    };
    expect(cloudflarePublicUrlVariable(SHELL_APP)).toBe('ULTRAMODERN_PUBLIC_URL_SHELL_SUPER_APP');
    expect(yield* cloudflareOrigin(placement, PRICE_GROUP_CATALOG)).toBe(
      'https://price-group-catalog.example.workers.dev',
    );
    expect(yield* cloudflareOrigin(placement, SHELL_APP)).toBe('https://stage.example.test');
    // An unplaced unit, or a placed one without its public URL, has no Worker to observe.
    for (const appId of ['catalog', 'pricing']) {
      const failure = yield* Effect.flip(
        cloudflareOrigin({ ...placement, units: [...placement.units, 'pricing'] }, appId),
      );
      expect(failure.reason).toBe('invalid_observation');
      expect(failure.message).toContain(`buildEnvironment.${cloudflarePublicUrlVariable(appId)}`);
    }
  }),
);

it('refreshes well inside the validity window on the configured schedule', () => {
  const { refreshCron, refreshInterval, validity } = ACTIVE_APPLICATION_COMPOSITION_POLICY;
  expect(Duration.toMillis(validity)).toBeGreaterThanOrEqual(3 * Duration.toMillis(refreshInterval));
  expect(refreshCron).toMatch(/^\d+ \*\/6 \* \* \*$/u);
});

it('reads quoted Zerops env-file values', () => {
  const environment = parseZeropsEnvFile('catalog_zeropsSubdomain="https://catalog.example"\nPLAIN=value\ninvalid\n');
  expect(environment.get('catalog_zeropsSubdomain')).toBe('https://catalog.example');
  expect(environment.get('PLAIN')).toBe('value');
  expect(environment.has('invalid')).toBe(false);
});

it('serves the Shell runtime contract without a locale redirect', () => {
  const shellConfig = readFileSync(new URL('../../apps/shell-super-app/modern.config.ts', import.meta.url), 'utf-8');
  const ignored = /ignoreRedirectRoutes: \[(?<routes>[^\]]*)\]/u.exec(shellConfig)?.groups?.routes ?? '';
  expect(ignored).toContain("'/.well-known'");
});

it.effect('publishes exact intrinsic dependencies and capabilities from observed owner requirements', () =>
  Effect.gen(function* publisherDerivesOwnerRequirements() {
    const base = moduleContract({
      appId: CUSTOMER_CONTEXT,
      components: [],
      moduleId: CUSTOMER_CONTEXT_MODULE,
      search: [],
    });
    const requiredCapability = { id: 'fixture.intrinsic-compatibility', version: '1' };
    const declared = {
      ...customerContext,
      contract: artifact(customerContext.contract.url, {
        ...base,
        manifest: {
          ...base.manifest,
          requirements: {
            coreCapabilities: [requiredCapability],
            intrinsic: [{ moduleId: PARTY_MODULE, requiredOperations: [] }],
            operations: [],
            schemaVersion: '1',
          },
        },
      }),
    };
    const input = observation([partyRegistry, declared]);
    const fixtureRuntime = createShellRuntimeContract('shell-immutable-build');
    const trustedFixture = {
      ...input,
      shell: {
        ...input.shell,
        runtimeContract: artifact(input.shell.runtimeContract.url, {
          ...fixtureRuntime,
          coreCapabilities: [requiredCapability],
        }),
      },
    };
    const snapshot = yield* deriveActiveApplicationCompositionSnapshot(trustedFixture);
    const consumer = snapshot.composition.modules.find(({ moduleId }) => moduleId === CUSTOMER_CONTEXT_MODULE);
    expect(consumer?.dependencies).toEqual([PARTY_MODULE]);
    expect(consumer?.requiredCoreCapabilities).toEqual([requiredCapability]);
    const missing = yield* Effect.flip(
      deriveActiveApplicationCompositionSnapshot({ ...trustedFixture, modules: [declared] }),
    );
    expect(missing.reason).toBe('invalid_observation');
    const missingCause = yield* Schema.decodeUnknownEffect(Schema.Struct({ reason: Schema.String }))(missing.cause);
    expect(missingCause.reason).toMatch(/dependency party.registry/u);
    const missingCapability = yield* Effect.flip(deriveActiveApplicationCompositionSnapshot(input));
    expect(missingCapability.reason).toBe('invalid_observation');
    const missingCapabilityCause = yield* Schema.decodeUnknownEffect(Schema.Struct({ reason: Schema.String }))(
      missingCapability.cause,
    );
    expect(missingCapabilityCause.reason).toMatch(/Core capability/u);
  }),
);
