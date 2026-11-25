import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

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
const SOURCE_WORKER_GATEWAY = `${REVIEWED_SOURCE_WORKER_DEPENDENT}/src/workers/portal-auth-communication-source-gateway.ts`;
const SPECIFIER_SUBPATH = String.raw`(?<subpath>(?:\/[A-Za-z0-9_./-]*)?)`;
const COMMUNICATIONS_SPECIFIER = /['"`]@app\/communications(?<subpath>(?:\/[A-Za-z0-9_./-]*)?)['"`]/gu;
const COMMUNICATIONS_CONTRACTS_SPECIFIER = new RegExp(
  `['"\`]@app\\/communications-contracts${SPECIFIER_SUBPATH}['"\`]`,
  'gu',
);

/** Subpaths of a package a source names (empty for the bare package) that are not in the allowed set. */
const unpublishedSubpaths = (specifier: RegExp, source: string, allowed: readonly string[]) =>
  [...source.matchAll(specifier)]
    .map((match) => match.groups?.subpath ?? '')
    .filter((subpath) => !allowed.includes(subpath));
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

it('limits the reviewed Portal Auth source worker dependency to the published request contract and submit client', () => {
  const dependencies = declaredDependencies(REVIEWED_SOURCE_WORKER_DEPENDENT);
  expect(dependencies.has(COMMUNICATIONS_PACKAGE)).toBe(false);
  expect(importsOf(REVIEWED_SOURCE_WORKER_DEPENDENT, COMMUNICATIONS_PACKAGE)).toEqual([]);
  // Every contracts subpath the package names, in production code and tests alike, is a published one.
  expect(
    unpublishedUses(COMMUNICATIONS_CONTRACTS_SPECIFIER, REVIEWED_SOURCE_WORKER_DEPENDENT, [
      PUBLISHED_REQUEST_CONTRACT,
      PUBLISHED_SUBMIT_REQUEST_CLIENT,
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
