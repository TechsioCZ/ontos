import { readFileSync } from 'node:fs';

import { ConfigProvider, DateTime, Duration, Effect, Layer, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { parse } from 'yaml';

import {
  ActiveApplicationCompositionConfigLive,
  ActiveApplicationCompositionService,
  ActiveApplicationCompositionSnapshotSchema,
  ONTOS_SHELL_CONTRIBUTION_ABI,
} from '../../packages/core-runtime/src/index.ts';
import {
  ACTIVE_APPLICATION_COMPOSITION_POLICY,
  applicationCompositionRevision,
  assertNoConflictingPublication,
  deriveActiveApplicationCompositionSnapshot,
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
  compositionConsumerSetups,
  edgeCompositionConsumers,
  modeWorkerSetups,
  otherModeWorkerSetups,
  serviceIdVariable,
  targetConsumerSetups,
} from '../publish-active-application-composition.mts';
import { shellRuntimeContract } from '../generate-ontos-shell-runtime-contract.mts';
import { parseZeropsEnvFile } from '../zerops-public-api.mts';

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
          contributionKey,
          entrypoint: {
            access: 'read',
            authorization: { kind: 'context_permission', permission: 'module.access' },
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
const OUTBOX_WORKER_HOST_SETUP = 'outbox-worker-host';
const PRICE_GROUP_CATALOG = 'price-group-catalog';
const CUSTOMER_CONTEXT_WORKER = 'commerce-customer-context-worker';
const PARTY_MODULE = 'party.registry';
const PAGE_EXPOSE = './PageContacts';
const SHELL_MANIFEST_URL = 'https://shell.example/mf-manifest.json';
const refreshWorkflowUrl = new URL(
  '../../../.github/workflows/active-application-composition-refresh.yml',
  import.meta.url,
);
const SHELL_REMOTE = 'shellSuperApp';
const SHELL_APP = 'shell-super-app';

const partyRegistry: ObservedModuleDeployment = {
  appId: PARTY_REGISTRY,
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
  contract: artifact(
    'https://commerce-customer-context.example/.well-known/ontos-module-manifest.json',
    moduleContract({
      appId: CUSTOMER_CONTEXT,
      components: [],
      moduleId: 'commerce.customer-context',
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
    runtimeContract: artifact('https://shell.example/.well-known/ontos-shell-runtime.json', shellRuntimeContract),
  },
  validity: ACTIVE_APPLICATION_COMPOSITION_POLICY.validity,
});

const loadAsConsumer = (encoded: string) =>
  ActiveApplicationCompositionService.pipe(
    Effect.flatMap(({ load }) => load),
    Effect.provide(
      Layer.mergeAll(
        ActiveApplicationCompositionConfigLive,
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({ [ACTIVE_APPLICATION_COMPOSITION_POLICY.projectVariable]: encoded }),
        ),
      ),
    ),
  );

it.effect('derives a schema-valid snapshot of the complete browser and server-only inventory', () =>
  Effect.gen(function* derivesCompleteInventory() {
    const snapshot = yield* deriveActiveApplicationCompositionSnapshot(observation([partyRegistry, customerContext]));
    const { composition } = snapshot;

    expect(composition.modules.map(({ federation, moduleId }) => [moduleId, federation.execution])).toEqual([
      ['commerce.customer-context', 'server'],
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
    expect((yield* loadAsConsumer(encoded)).composition.revision).toBe(composition.revision);
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

it.effect('restarts exactly the Outbox Worker mode services whose start preflight requires the snapshot', () =>
  Effect.gen(function* consumers() {
    const zeropsYaml = readFileSync(new URL('../../zerops.yaml', import.meta.url), 'utf-8');
    const topology = readReferenceTopology();
    expect(yield* compositionConsumerSetups(zeropsYaml, topology, 'dedicated')).toEqual([
      CUSTOMER_CONTEXT,
      CUSTOMER_CONTEXT_WORKER,
    ]);
    // The host mode runs the Commerce worker in the Outbox Worker host in place of its dedicated service.
    expect(yield* compositionConsumerSetups(zeropsYaml, topology, 'host')).toEqual([
      CUSTOMER_CONTEXT,
      OUTBOX_WORKER_HOST_SETUP,
    ]);
    // A mode switch leaves these running; the deploy detects them to reconcile the workers of both modes.
    expect(yield* otherModeWorkerSetups(zeropsYaml, topology, 'dedicated')).toEqual([OUTBOX_WORKER_HOST_SETUP]);
    expect(yield* otherModeWorkerSetups(zeropsYaml, topology, 'host')).toEqual([
      'party-registry-worker',
      CUSTOMER_CONTEXT_WORKER,
      'price-group-catalog-worker',
    ]);
    // A switch also shows as this mode's workers not running yet.
    expect(yield* modeWorkerSetups(zeropsYaml, topology, 'host')).toEqual([OUTBOX_WORKER_HOST_SETUP]);
    expect(yield* modeWorkerSetups(zeropsYaml, topology, 'dedicated')).toEqual(
      yield* otherModeWorkerSetups(zeropsYaml, topology, 'host'),
    );
    expect(serviceIdVariable(OUTBOX_WORKER_HOST_SETUP)).toBe('ZEROPS_OUTBOX_WORKER_HOST_SERVICE_ID');
    expect(serviceIdVariable(CUSTOMER_CONTEXT_WORKER)).toBe('ZEROPS_COMMERCE_CUSTOMER_CONTEXT_WORKER_SERVICE_ID');
    expect(serviceIdVariable('shellsuperapp')).toBe('ZEROPS_SHELL_SERVICE_ID');
  }),
);

it.effect('restarts only the Zerops-hosted consumers of each deploy target in either Outbox Worker mode', () =>
  Effect.gen(function* consumersPerTarget() {
    const zeropsYaml = readFileSync(new URL('../../zerops.yaml', import.meta.url), 'utf-8');
    const topology = readReferenceTopology();
    const deliveryUnits = new Set([CUSTOMER_CONTEXT, 'shellsuperapp']);
    const consumersOf = (target: 'cloudflare' | 'zerops', mode: 'dedicated' | 'host') =>
      compositionConsumerSetups(zeropsYaml, topology, mode).pipe(
        Effect.map((consumers) => targetConsumerSetups(consumers, target, deliveryUnits)),
      );
    // On Zerops every consumer is a Zerops service; on Cloudflare the vertical runs as a Worker, and
    // only the mode's Outbox Workers stay on Zerops to be restarted. The mode is independent of the target.
    expect(yield* consumersOf('zerops', 'dedicated')).toEqual([CUSTOMER_CONTEXT, CUSTOMER_CONTEXT_WORKER]);
    expect(yield* consumersOf('zerops', 'host')).toEqual([CUSTOMER_CONTEXT, OUTBOX_WORKER_HOST_SETUP]);
    expect(yield* consumersOf('cloudflare', 'host')).toEqual([OUTBOX_WORKER_HOST_SETUP]);
    expect(yield* consumersOf('cloudflare', 'dedicated')).toEqual([CUSTOMER_CONTEXT_WORKER]);
  }),
);

it('hands each publication to the placed Worker consumers, which have no Zerops project variable', () => {
  const topology = readReferenceTopology();
  const placement = { buildEnvironment: {}, units: [CUSTOMER_CONTEXT, PRICE_GROUP_CATALOG] };

  expect(edgeCompositionConsumers([CUSTOMER_CONTEXT, OUTBOX_WORKER_HOST_SETUP], topology, placement)).toEqual([
    { packageName: '@app/commerce-customer-context', workerName: 'app-commerce-customer-context' },
  ]);
  // A consumer that is not placed stays a Zerops service and reads the project variable.
  expect(edgeCompositionConsumers([CUSTOMER_CONTEXT], topology, { buildEnvironment: {}, units: [] })).toEqual([]);
});

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
  const workflow = Schema.decodeUnknownSync(
    Schema.Struct({ on: Schema.Struct({ schedule: Schema.Array(Schema.Struct({ cron: Schema.String })) }) }),
  )(parse(readFileSync(refreshWorkflowUrl, 'utf-8')));
  expect(workflow.on.schedule).toEqual([{ cron: refreshCron }]);
  expect(refreshCron).toMatch(/^\d+ \*\/6 \* \* \*$/u);
});

it('leaves the refresh to the stage deploy while the Outbox Workers drift from the Outbox Worker mode', () => {
  const workflow = Schema.decodeUnknownSync(
    Schema.Struct({
      jobs: Schema.Record(
        Schema.String,
        Schema.Struct({
          steps: Schema.Array(
            Schema.Struct({ id: Schema.optional(Schema.String), if: Schema.optional(Schema.String) }),
          ),
        }),
      ),
    }),
  )(parse(readFileSync(refreshWorkflowUrl, 'utf-8')));
  const steps = Object.values(workflow.jobs).flatMap((job) => job.steps);
  const gates = steps.flatMap((step) => (step.if?.includes('steps.worker-drift') === true ? [step.if] : []));
  expect(steps.some((step) => step.id === 'worker-drift')).toBe(true);
  const refreshes = "steps.worker-drift.outputs.drift != 'true'";
  expect(gates).toEqual([
    "steps.worker-drift.outputs.drift == 'true'",
    refreshes,
    refreshes,
    refreshes,
    `env.DEPLOY_TARGET == 'cloudflare' && ${refreshes}`,
  ]);
});

it('refreshes the production composition on Zerops, in its own environment and concurrency group', () => {
  const workflow = Schema.decodeUnknownSync(
    Schema.Struct({
      jobs: Schema.Struct({
        'refresh-production': Schema.Struct({
          concurrency: Schema.Struct({ group: Schema.String }),
          env: Schema.Record(Schema.String, Schema.String),
          environment: Schema.Struct({ deployment: Schema.Boolean, name: Schema.String }),
          steps: Schema.Array(
            Schema.Struct({ if: Schema.optional(Schema.String), run: Schema.optional(Schema.String) }),
          ),
        }),
      }),
    }),
  )(parse(readFileSync(refreshWorkflowUrl, 'utf-8')));
  const production = workflow.jobs['refresh-production'];
  expect(production.environment).toEqual({ deployment: false, name: 'production' });
  expect(production.concurrency.group).toBe('zerops-production');
  expect(production.env.DEPLOY_TARGET).toBe('zerops');
  // Production names its own Outbox Worker mode; the publisher has no default for it.
  expect(production.env.OUTBOX_WORKER_MODE).toBe(`\${{ vars.OUTBOX_WORKER_MODE }}`);
  const runs = production.steps.map(({ run }) => run ?? '').join('\n');
  expect(runs).toContain('deployment-base:resolve --environment production --optional');
  expect(runs).toContain('--environment production');
  expect(runs).not.toContain('--environment stage');
  // An unconfigured or never-deployed production has no snapshot, so the lane publishes nothing.
  const publish = production.steps.find(({ run }) => run?.includes('active-composition:publish publish') === true);
  expect(publish?.if).toBe("steps.base.outputs.base != ''");
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
