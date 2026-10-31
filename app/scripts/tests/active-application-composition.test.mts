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
  encodeActiveApplicationCompositionSnapshot,
} from '../active-application-composition.mts';
import type {
  ActiveApplicationCompositionObservation,
  ObservedArtifact,
  ObservedModuleDeployment,
} from '../active-application-composition.mts';
import { createShellRuntimeContract } from '../generate-ontos-shell-runtime-contract.mts';
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
const PARTY_MODULE = 'party.registry';
const PAGE_EXPOSE = './PageContacts';
const SHELL_MANIFEST_URL = 'https://shell.example/mf-manifest.json';
const SHELL_REMOTE = 'shellSuperApp';

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
    runtimeContract: artifact(
      'https://shell.example/.well-known/ontos-shell-runtime.json',
      createShellRuntimeContract('shell-immutable-build'),
    ),
  },
  validity: ACTIVE_APPLICATION_COMPOSITION_POLICY.validity,
});

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
