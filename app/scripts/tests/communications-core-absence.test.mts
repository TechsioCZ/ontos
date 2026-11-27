import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { Array as EffectArray, Effect, Order, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  privacyDispatchConsumerOfWorker,
  privacyDispatchConsumers,
} from '../../packages/shared-contracts/src/privacy-dispatch-consumers.ts';
import { ApplicationReleaseIntentSchema, selectApplicationReleaseUnits } from '../application-release-intent.mts';

/**
 * E21 (#1392): Communications is optional. Lean Core, staff Auth and unrelated compositions neither depend on it nor
 * need its database, templates or provider configuration (ADR-0022).
 */
const appRoot = path.resolve(import.meta.dirname, '../..');
const COMMUNICATIONS_PACKAGE = '@app/communications';
const COMMUNICATIONS_CONTRACTS_PACKAGE = '@app/communications-contracts';
const COMMUNICATIONS_APP_ID = 'communications';
const EMAIL_DELIVERY_PACKAGE = '@app/email-delivery';

const ManifestSchema = Schema.Struct({
  dependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  devDependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  name: Schema.String,
  optionalDependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  peerDependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});
const readManifest = (directory: string) =>
  Schema.decodeUnknownSync(Schema.fromJsonString(ManifestSchema))(
    readFileSync(path.join(appRoot, directory, 'package.json'), 'utf-8'),
  );
const WORKSPACE_PARENTS = ['apps', 'packages', 'verticals'] as const;
const workspaceDirectories = (parent: (typeof WORKSPACE_PARENTS)[number]) =>
  readdirSync(path.join(appRoot, parent), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${parent}/${entry.name}`)
    .filter((directory) => {
      try {
        readManifest(directory);
        return true;
      } catch {
        return false;
      }
    });
const declaredDependencies = (directory: string) => {
  const manifest = readManifest(directory);
  return new Set(
    [manifest.dependencies, manifest.devDependencies, manifest.optionalDependencies, manifest.peerDependencies].flatMap(
      (group) => Object.keys(group ?? {}),
    ),
  );
};

const sourceFiles = (directory: string): readonly string[] =>
  readdirSync(path.join(appRoot, directory), { withFileTypes: true }).flatMap((entry) => {
    if (['dist', 'dist-cloudflare', 'node_modules', '.output'].includes(entry.name)) {
      return [];
    }
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      return sourceFiles(relative);
    }
    return /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/u.test(entry.name) ? [relative] : [];
  });
const QUOTES = ["'", '"', '`'] as const;
const mentionsSpecifier = (source: string, specifier: string) =>
  QUOTES.some(
    (quote) => source.includes([quote, specifier, quote].join('')) || source.includes([quote, specifier, '/'].join('')),
  );
const importsOf = (directory: string, specifier: string) =>
  sourceFiles(directory).filter((file) =>
    mentionsSpecifier(readFileSync(path.join(appRoot, file), 'utf-8'), specifier),
  );

const SHELL_DIRECTORY = 'apps/shell-super-app';
const leanCoreAndStaffDirectories = ['packages/core-runtime', 'packages/gateway-principal-verifier', SHELL_DIRECTORY];

it('keeps lean Core, staff Auth and the Shell free of any Communications or provider dependency', () => {
  for (const directory of leanCoreAndStaffDirectories) {
    const dependencies = declaredDependencies(directory);
    expect([directory, dependencies.has(COMMUNICATIONS_PACKAGE)]).toEqual([directory, false]);
    expect([directory, dependencies.has(COMMUNICATIONS_CONTRACTS_PACKAGE)]).toEqual([directory, false]);
    expect([directory, dependencies.has(EMAIL_DELIVERY_PACKAGE)]).toEqual([directory, false]);
  }
});

it('never imports Communications source from lean Core, staff Auth or the Shell', () => {
  for (const directory of leanCoreAndStaffDirectories) {
    expect(importsOf(directory, COMMUNICATIONS_PACKAGE)).toEqual([]);
    expect(importsOf(directory, COMMUNICATIONS_CONTRACTS_PACKAGE)).toEqual([]);
    expect(importsOf(directory, EMAIL_DELIVERY_PACKAGE)).toEqual([]);
  }
});

/**
 * No workspace package other than the Communications deployment itself depends on the private deployment package
 * `@app/communications`: a module reaches Communications only through the schema-only, Communications-owned contracts package
 * (`@app/communications-contracts`), never through another module package. Two relationships are reviewed, and each may name
 * only its own published subpaths of that contracts package:
 *
 * - Privacy's owner inventory asks Communications for owner coverage through the published Owner Coverage contract and its
 *   owner execution receipt Read for a dispatched Privacy Measure (#1410);
 * - Commerce Customer Context's own Portal Auth source worker submits each committed request to the public
 *   `submit-communication-request` Action through its published client, and only the worker's gateway names that client
 *   (#1406 D1): Communications admits a request only from the source module's own Outbox Worker.
 *
 * Neither names the deployment package, the email provider, or any Communications source.
 */
const REVIEWED_PRIVACY_DEPENDENT = 'verticals/privacy';
const PUBLISHED_OWNER_COVERAGE_DESCRIPTOR = '/privacy-owner-coverage';
const PUBLISHED_OWNER_RECEIPT_CLIENT = '/privacy-owner-execution-outcome/client';
const PUBLISHED_PRIVACY_PRODUCTION_SUBPATHS = [
  PUBLISHED_OWNER_COVERAGE_DESCRIPTOR,
  PUBLISHED_OWNER_RECEIPT_CLIENT,
] as const;
const PUBLISHED_PRIVACY_TEST_SUBPATHS = [
  ...PUBLISHED_PRIVACY_PRODUCTION_SUBPATHS,
  '/privacy-owner/coverage',
  '/privacy-owner/inventory',
  '/privacy-owner/outcome',
] as const;
const REVIEWED_SOURCE_WORKER_DEPENDENT = 'verticals/commerce-customer-context';
const PUBLISHED_REQUEST_CONTRACT = '/communication-request';
const PUBLISHED_SUBMIT_REQUEST_CLIENT = '/submit-communication-request/client';
// the enrollment replay reads the outcome of its own request through the published, schema-only outcome Read (#1406 T3-16)
const PUBLISHED_OUTCOME_FEED_CONTRACT = '/communication-outcome-feed';
const PUBLISHED_COMMUNICATION_HISTORY_CONTRACT = '/communication-history';
const SOURCE_WORKER_GATEWAY = `${REVIEWED_SOURCE_WORKER_DEPENDENT}/src/workers/portal-auth-communication-source-gateway.ts`;
const SPECIFIER_SUBPATH = String.raw`(?<subpath>(?:\/[A-Za-z0-9_./-]*)?)`;
const COMMUNICATIONS_SPECIFIER = /['"`]@app\/communications(?<subpath>(?:\/[A-Za-z0-9_./-]*)?)['"`]/gu;
const COMMUNICATIONS_CONTRACTS_SPECIFIER = new RegExp(
  `['"\`]@app\\/communications-contracts${SPECIFIER_SUBPATH}['"\`]`,
  'gu',
);

/** Subpaths of a package a source names (empty for the bare package) that are not in the allowed set. */
const unpublishedSubpaths = (specifier: RegExp, source: string, allowed: readonly string[]) => {
  const published = new Set(allowed);
  return [...source.matchAll(specifier)]
    .map((match) => match.groups?.['subpath'] ?? '')
    .filter((subpath) => !published.has(subpath));
};
const unpublishedUses = (specifier: RegExp, directory: string, allowed: readonly string[]) =>
  sourceFiles(directory).filter(
    (file) => unpublishedSubpaths(specifier, readFileSync(path.join(appRoot, file), 'utf-8'), allowed).length > 0,
  );

it('lets no other workspace package depend on the private Communications deployment package', () => {
  const workspace = WORKSPACE_PARENTS.flatMap((parent) => workspaceDirectories(parent));
  const dependents = workspace.filter(
    (directory) =>
      directory !== 'verticals/communications' && declaredDependencies(directory).has(COMMUNICATIONS_PACKAGE),
  );
  // The deployment package is private to its owner: every other package reaches Communications through its contracts package.
  expect(dependents).toEqual([]);
  for (const directory of workspace.filter((candidate) => candidate !== 'verticals/communications')) {
    const nonTestSources = importsOf(directory, COMMUNICATIONS_PACKAGE).filter((file) => !file.includes('/tests/'));
    expect([directory, nonTestSources]).toEqual([directory, []]);
  }
});

it('limits the reviewed Privacy dependency to the published Owner Coverage contract', () => {
  const dependencies = declaredDependencies(REVIEWED_PRIVACY_DEPENDENT);
  expect(dependencies.has(COMMUNICATIONS_PACKAGE)).toBe(false);
  expect(dependencies.has(COMMUNICATIONS_CONTRACTS_PACKAGE)).toBe(true);
  expect(dependencies.has(EMAIL_DELIVERY_PACKAGE)).toBe(false);
  expect(importsOf(REVIEWED_PRIVACY_DEPENDENT, COMMUNICATIONS_PACKAGE)).toEqual([]);
  expect(importsOf(REVIEWED_PRIVACY_DEPENDENT, EMAIL_DELIVERY_PACKAGE)).toEqual([]);
  // Production code reaches Communications only through the published descriptor and receipt client; test doubles may also
  // use the published Owner Coverage assessment, inventory and outcome vocabulary.
  for (const directory of ['src', 'shared']) {
    expect(
      unpublishedUses(
        COMMUNICATIONS_CONTRACTS_SPECIFIER,
        `${REVIEWED_PRIVACY_DEPENDENT}/${directory}`,
        PUBLISHED_PRIVACY_PRODUCTION_SUBPATHS,
      ),
    ).toEqual([]);
  }
  expect(
    unpublishedUses(
      COMMUNICATIONS_CONTRACTS_SPECIFIER,
      `${REVIEWED_PRIVACY_DEPENDENT}/tests`,
      PUBLISHED_PRIVACY_TEST_SUBPATHS,
    ),
  ).toEqual([]);
});

it('limits the reviewed Portal Auth source worker dependency to the published request, outcome and history contracts and the submit client', () => {
  const dependencies = declaredDependencies(REVIEWED_SOURCE_WORKER_DEPENDENT);
  expect(dependencies.has(COMMUNICATIONS_PACKAGE)).toBe(false);
  expect(importsOf(REVIEWED_SOURCE_WORKER_DEPENDENT, COMMUNICATIONS_PACKAGE)).toEqual([]);
  // Every contracts subpath the package names, in production code and tests alike, is a published one.
  expect(
    unpublishedUses(COMMUNICATIONS_CONTRACTS_SPECIFIER, REVIEWED_SOURCE_WORKER_DEPENDENT, [
      PUBLISHED_REQUEST_CONTRACT,
      PUBLISHED_SUBMIT_REQUEST_CLIENT,
      PUBLISHED_OUTCOME_FEED_CONTRACT,
      PUBLISHED_COMMUNICATION_HISTORY_CONTRACT,
    ]),
  ).toEqual([]);
  // Only the source worker's gateway names the submit client; no API, page, Action or relay code of the package reaches Communications.
  expect(
    sourceFiles(REVIEWED_SOURCE_WORKER_DEPENDENT).filter((file) =>
      mentionsSpecifier(
        readFileSync(path.join(appRoot, file), 'utf-8'),
        `${COMMUNICATIONS_CONTRACTS_PACKAGE}${PUBLISHED_SUBMIT_REQUEST_CLIENT}`,
      ),
    ),
  ).toEqual([SOURCE_WORKER_GATEWAY]);
});

it('still rejects any import beyond the reviewed published subpaths', () => {
  const workerAllowed = [PUBLISHED_REQUEST_CONTRACT, PUBLISHED_SUBMIT_REQUEST_CLIENT];
  expect(
    unpublishedSubpaths(
      COMMUNICATIONS_CONTRACTS_SPECIFIER,
      "import { executeSubmitCommunicationRequestWithAuthorization } from '@app/communications-contracts/submit-communication-request/client';",
      workerAllowed,
    ),
  ).toEqual([]);
  expect(
    unpublishedSubpaths(
      COMMUNICATIONS_CONTRACTS_SPECIFIER,
      [
        "import { Api } from '@app/communications-contracts/submit-communication-request';",
        "import { receipt } from '@app/communications-contracts/privacy-owner-execution-outcome/client';",
        "import { x } from '@app/communications-contracts/src/communication-request';",
        'await import("@app/communications-contracts")',
      ].join('\n'),
      workerAllowed,
    ),
  ).toEqual([
    '/submit-communication-request',
    '/privacy-owner-execution-outcome/client',
    '/src/communication-request',
    '',
  ]);
  // The private deployment package is a different package and is rejected on any subpath, even a published contracts one.
  expect(
    unpublishedSubpaths(
      COMMUNICATIONS_SPECIFIER,
      [
        "import { client } from '@app/communications/api/client';",
        "import { entry } from '@app/communications/outbox-worker-host';",
        'await import("@app/communications")',
        "import type { Request } from '@app/communications-contracts';",
      ].join('\n'),
      [],
    ),
  ).toEqual(['/api/client', '/outbox-worker-host', '']);
});

it('keeps the Communications contracts schema-only and independent of the deployment, its provider and the Privacy deployment', () => {
  const dependencies = declaredDependencies('packages/communications-contracts');
  expect(dependencies.has(COMMUNICATIONS_PACKAGE)).toBe(false);
  expect(dependencies.has(EMAIL_DELIVERY_PACKAGE)).toBe(false);
  expect(dependencies.has('@app/privacy')).toBe(false);
  expect(importsOf('packages/communications-contracts/src', COMMUNICATIONS_PACKAGE)).toEqual([]);
  expect(importsOf('packages/communications-contracts/src', '@app/privacy')).toEqual([]);
});

const ReviewedTopologySchema = Schema.Struct({
  shell: Schema.Struct({
    cloudflare: Schema.Struct({ workerName: Schema.NonEmptyString }),
    id: Schema.String,
    package: Schema.NonEmptyString,
    path: Schema.NonEmptyString,
  }),
  verticals: Schema.Array(
    Schema.Struct({
      cloudflare: Schema.Struct({ workerName: Schema.NonEmptyString }),
      id: Schema.String,
      package: Schema.NonEmptyString,
      path: Schema.NonEmptyString,
    }),
  ),
});
const topology = Schema.decodeUnknownSync(Schema.fromJsonString(ReviewedTopologySchema))(
  readFileSync(path.join(appRoot, 'topology/reference-topology.json'), 'utf-8'),
);
const available = [topology.shell, ...topology.verticals].map((unit) => ({
  id: unit.id,
  packageName: unit.package,
  path: unit.path,
  workerName: unit.cloudflare.workerName,
}));
const reviewedIntent = Schema.decodeUnknownSync(Schema.fromJsonString(ApplicationReleaseIntentSchema))(
  readFileSync(path.join(appRoot, 'topology/application-release-intent.json'), 'utf-8'),
);

it.effect('releases lean Core with no business module, so Communications is neither selected nor required', () =>
  Effect.gen(function* leanCoreSelection() {
    expect(available.map(({ id }) => id)).toContain(COMMUNICATIONS_APP_ID);

    const selection = yield* selectApplicationReleaseUnits({ modules: [] }, available, []);

    expect(selection.complete).toEqual([]);
    expect(selection.removed).toEqual([]);
    expect(selection.shell.unit.id).toBe('shell-super-app');
  }),
);

it.effect('releases the reviewed unrelated composition without Communications or its configuration', () =>
  Effect.gen(function* unrelatedSelection() {
    expect(reviewedIntent.modules.map(({ appId }) => appId)).not.toContain(COMMUNICATIONS_APP_ID);

    const selection = yield* selectApplicationReleaseUnits(reviewedIntent, available, []);

    expect(selection.complete.map(({ id }) => id)).toEqual(reviewedIntent.modules.map(({ appId }) => appId));
    expect(selection.complete.map(({ id }) => id)).not.toContain(COMMUNICATIONS_APP_ID);
    expect(selection.fresh.map(({ id }) => id)).not.toContain(COMMUNICATIONS_APP_ID);
    expect(selection.retained.map(({ id }) => id)).not.toContain(COMMUNICATIONS_APP_ID);
  }),
);

it.effect('selects Communications only when a reviewed intent names it, and then only that deployment', () =>
  Effect.gen(function* explicitSelection() {
    const withCommunications = yield* selectApplicationReleaseUnits(
      { modules: [...reviewedIntent.modules, { appId: COMMUNICATIONS_APP_ID }] },
      available,
      [],
    );
    const without = yield* selectApplicationReleaseUnits(reviewedIntent, available, []);

    expect(withCommunications.complete.map(({ id }) => id)).toEqual([
      ...without.complete.map(({ id }) => id),
      COMMUNICATIONS_APP_ID,
    ]);
  }),
);

/**
 * E21 on the Communications constants that now live INSIDE lean Core (R-D4): the shared gateway contract, the Privacy dispatch
 * consumer registry, the stage workload keys, the provenance vocabulary and the Shell's dispatch evidence. They are inert,
 * frozen data (keys, tags and an appId); no lean-Core source imports Communications, reads its configuration or starts anything of
 * it. This guard pins EXACTLY which identifiers are allowed to mention Communications in each lean-Core source file, so a new
 * constant, a new coupling or a new file fails here and has to be reviewed. Comments are not scanned.
 */
const LEAN_CORE_SOURCE_DIRECTORIES = [
  'packages/shared-contracts/src',
  'packages/core-runtime/src',
  'packages/gateway-principal-verifier/src',
  'apps/shell-super-app/api',
  'apps/shell-super-app/src',
] as const;
const RECEIPT_TAG = 'CommunicationsReceipt';
const COMMUNICATIONS_MODULE = 'communications.core';
const REVIEWED_COMMUNICATIONS_CONSTANTS = {
  'apps/shell-super-app/api/auth/gateway-privacy-dispatch-evidence.ts': [RECEIPT_TAG],
  'packages/core-runtime/src/auth/system-principal-context-provenance.ts': [RECEIPT_TAG],
  'packages/core-runtime/src/install/stage-accounts-file.ts': [
    'commerce.customer-context.portal-auth-communication-relay',
    'communications.core.messaging-adapter',
    'communications.core.request-source',
  ],
  'packages/shared-contracts/src/gateway-context.ts': [
    RECEIPT_TAG,
    'communications',
    COMMUNICATIONS_MODULE,
    'communications.core.api.privacy-owner-execution-outcome',
    'communications.core.privacy-owner-execution-outcome.read',
  ],
  'packages/shared-contracts/src/privacy-dispatch-consumers.ts': [
    RECEIPT_TAG,
    'communications',
    COMMUNICATIONS_MODULE,
    'communications.core.owner-execution-evidence-recorded.v1',
    'communications.core.receive-privacy-measure',
    'communications.core.record-owner-execution-evidence',
    'communications.core.report-privacy-owner-outcome',
    'communications.core.requirement.privacy-report-recorded-owner-outcome',
    'communications.moduleKey',
    'privacy.core.requirement.communications-owner-execution-outcome',
  ],
} satisfies Record<string, readonly string[]>;
const COMMUNICATIONS_IDENTIFIER = /(?<![\w.-])[\w.-]*[Cc]ommunications?[\w.-]*/gu;
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//gu;
const LINE_COMMENT = /\/\/.*/gu;

/** The distinct identifiers of a source that mention Communications, outside comments. */
const communicationsIdentifiersOf = (source: string): readonly string[] => [
  ...new Set(
    [...source.replaceAll(BLOCK_COMMENT, '').replaceAll(LINE_COMMENT, '').matchAll(COMMUNICATIONS_IDENTIFIER)].map(
      ([identifier]) => identifier,
    ),
  ),
];
const isTestOrBuildOutput = (file: string) =>
  /\/(?:tests?|dist|\.output)\//u.test(file) || /\.test\.[cm]?[jt]sx?$/u.test(file);

it('pins every Communications constant inside lean Core, the Shell and the gateway verifier to a reviewed identifier', () => {
  const found = Object.fromEntries(
    LEAN_CORE_SOURCE_DIRECTORIES.flatMap((directory) =>
      sourceFiles(directory)
        .filter((file) => !isTestOrBuildOutput(file))
        .flatMap((file) => {
          const identifiers = communicationsIdentifiersOf(readFileSync(path.join(appRoot, file), 'utf-8'));
          return identifiers.length === 0 ? [] : [[file, EffectArray.sort(identifiers, Order.String)] as const];
        }),
    ),
  );
  const reviewed = Object.fromEntries(
    Object.entries(REVIEWED_COMMUNICATIONS_CONSTANTS).map(([file, identifiers]) => [
      file,
      EffectArray.sort(identifiers, Order.String),
    ]),
  );
  expect(found).toEqual(reviewed);
});

it('keeps the Communications identifier scan honest: it finds an added constant and ignores a comment', () => {
  expect(communicationsIdentifiersOf("const key = 'communications.core.new-thing';")).toEqual([
    'communications.core.new-thing',
  ]);
  expect(communicationsIdentifiersOf('// Communications is mentioned here only\n/* Communications */')).toEqual([]);
  // an import of the contracts or the deployment package names Communications as well, so it is found too
  expect(communicationsIdentifiersOf("import { x } from '@app/communications-contracts/y';")).toEqual([
    'communications-contracts',
  ]);
});

it('keeps the Communications dispatch consumer inert, frozen data that no other consumer depends on', () => {
  const consumer = privacyDispatchConsumers[COMMUNICATIONS_MODULE];
  expect(consumer).toBeDefined();
  expect(Object.isFrozen(consumer)).toBe(true);
  // every string it carries names Communications' own keys or the Privacy requirement for its receipt: data, never an
  // endpoint or a credential
  expect(JSON.stringify(consumer)).not.toMatch(/https?:|secret|password|token/iu);
  // Symmy's consumer is keyed and resolved independently of it
  expect(privacyDispatchConsumerOfWorker('integration.symmy.symmy-job-privacy-dispatch')?.moduleKey).toBe(
    'integration.symmy',
  );
  expect(privacyDispatchConsumerOfWorker('communications.core.receive-privacy-measure')?.moduleKey).toBe(
    'communications.core',
  );
  expect(privacyDispatchConsumerOfWorker('unrelated.worker')).toBeUndefined();
});

it('declares no Communications deployment configuration on the Shell service of the deployment manifest', () => {
  const manifest = readFileSync(path.join(appRoot, 'zerops.yaml'), 'utf-8');
  const section = (setup: string) => {
    const start = manifest.indexOf(`  - setup: '${setup}'`);
    const next = manifest.indexOf('\n  - setup:', start + 1);
    return manifest.slice(start, next === -1 ? manifest.length : next);
  };
  expect(section('shellsuperapp').length).toBeGreaterThan(0);
  expect(section('shellsuperapp')).not.toMatch(/communications/iu);
  // the control: the section that DOES belong to Communications names it, so the pattern is not simply blind
  expect(section('communications')).toMatch(/communications/iu);
});

it.effect('releases every single business module without selecting Communications unless it is named', () =>
  Effect.gen(function* everyModuleAlone() {
    const businessModules = available.filter(({ id }) => id !== COMMUNICATIONS_APP_ID && id !== 'shell-super-app');
    expect(businessModules.length).toBeGreaterThan(1);
    for (const { id } of businessModules) {
      const selection = yield* selectApplicationReleaseUnits({ modules: [{ appId: id }] }, available, []);
      expect([id, selection.complete.map(({ id: selected }) => selected)]).toEqual([id, [id]]);
      expect(selection.fresh.map(({ id: selected }) => selected)).not.toContain(COMMUNICATIONS_APP_ID);
      expect(selection.retained.map(({ id: selected }) => selected)).not.toContain(COMMUNICATIONS_APP_ID);
    }
    // the control: naming it selects it and only it
    const named = yield* selectApplicationReleaseUnits({ modules: [{ appId: COMMUNICATIONS_APP_ID }] }, available, []);
    expect(named.complete.map(({ id }) => id)).toEqual([COMMUNICATIONS_APP_ID]);
  }),
);
