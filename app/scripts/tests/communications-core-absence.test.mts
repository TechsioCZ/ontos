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
 * The one reviewed relationship that reaches Communications through a package dependency: Privacy's owner inventory asks
 * Communications for owner coverage through the Communications-owned, published Owner Coverage contract (#1410). Privacy
 * owns the governed call; its package never imports Communications source, the Communication Request contract package or the
 * email provider, and its production code reaches Communications only through the published descriptors: the Owner Coverage
 * contract and the owner execution receipt Read it asks for a dispatched Privacy Measure (#1410).
 */
const REVIEWED_COMMUNICATIONS_DEPENDENT = 'verticals/privacy';
const PUBLISHED_OWNER_COVERAGE_DESCRIPTOR = '/api/privacy-owner-coverage';
const PUBLISHED_OWNER_RECEIPT_CLIENT = '/api/privacy-owner-execution-outcome/client';
const PUBLISHED_PRODUCTION_SUBPATHS = [PUBLISHED_OWNER_COVERAGE_DESCRIPTOR, PUBLISHED_OWNER_RECEIPT_CLIENT] as const;
const PUBLISHED_OWNER_COVERAGE_SUBPATHS = [
  ...PUBLISHED_PRODUCTION_SUBPATHS,
  '/privacy-owner/coverage',
  '/privacy-owner/inventory',
  '/privacy-owner/outcome',
] as const;
const COMMUNICATIONS_SPECIFIER = /['"`]@app\/communications(?<subpath>(?:\/[A-Za-z0-9_./-]*)?)['"`]/gu;

/**
 * The second reviewed relationship (#1406 D1, pending owner review): Commerce Customer Context's own Portal Auth source worker
 * submits each committed Portal Auth request to the public `submit-communication-request` Action through its published,
 * generated client. That client is the only Communications subpath the package names, and only the source worker's gateway
 * names it: Communications admits a request only from the source module's own Outbox Worker.
 */
const REVIEWED_SOURCE_WORKER_DEPENDENT = 'verticals/commerce-customer-context';
const PUBLISHED_SUBMIT_REQUEST_CLIENT = '/api/submit-communication-request-action/client';
const SOURCE_WORKER_GATEWAY = `${REVIEWED_SOURCE_WORKER_DEPENDENT}/src/workers/portal-auth-communication-source-gateway.ts`;
const REVIEWED_COMMUNICATIONS_DEPENDENTS = [
  REVIEWED_COMMUNICATIONS_DEPENDENT,
  REVIEWED_SOURCE_WORKER_DEPENDENT,
] as const;

/** Workspace packages that depend on the private deployment package without being a reviewed relationship. */
const unreviewedCommunicationsDependents = (dependents: readonly string[]) =>
  dependents.filter((directory) => !REVIEWED_COMMUNICATIONS_DEPENDENTS.some((reviewed) => reviewed === directory));
/** Subpaths of `@app/communications` a source names (empty for the bare package) that are not in the allowed set. */
const unpublishedCommunicationsSubpaths = (source: string, allowed: readonly string[]) =>
  [...source.matchAll(COMMUNICATIONS_SPECIFIER)]
    .map((match) => match.groups?.subpath ?? '')
    .filter((subpath) => !allowed.includes(subpath));
const unpublishedCommunicationsUses = (directory: string, allowed: readonly string[]) =>
  sourceFiles(directory).filter(
    (file) => unpublishedCommunicationsSubpaths(readFileSync(path.join(appRoot, file), 'utf-8'), allowed).length > 0,
  );

it('lets no other workspace package depend on the private Communications deployment package', () => {
  const workspace = WORKSPACE_PARENTS.flatMap((parent) => workspaceDirectories(parent));
  const dependents = workspace.filter(
    (directory) =>
      directory !== 'verticals/communications' && declaredDependencies(directory).has(COMMUNICATIONS_PACKAGE),
  );
  // The deployment package is private to its owner. Source owners import only the schema-only contract package; the
  // reviewed exceptions are Privacy's published Owner Coverage descriptors and the Portal Auth source worker's published
  // submit client.
  expect(unreviewedCommunicationsDependents(dependents)).toEqual([]);
});

it('limits the reviewed Privacy dependency to the published Owner Coverage contract', () => {
  const dependencies = declaredDependencies(REVIEWED_COMMUNICATIONS_DEPENDENT);
  expect(dependencies.has(COMMUNICATIONS_CONTRACTS_PACKAGE)).toBe(false);
  expect(dependencies.has(EMAIL_DELIVERY_PACKAGE)).toBe(false);
  expect(importsOf(REVIEWED_COMMUNICATIONS_DEPENDENT, COMMUNICATIONS_CONTRACTS_PACKAGE)).toEqual([]);
  expect(importsOf(REVIEWED_COMMUNICATIONS_DEPENDENT, EMAIL_DELIVERY_PACKAGE)).toEqual([]);
  // Production code reaches Communications only through the published descriptor; test doubles may also use the
  // published Owner Coverage assessment, inventory and outcome vocabulary.
  expect(
    unpublishedCommunicationsUses(`${REVIEWED_COMMUNICATIONS_DEPENDENT}/src`, PUBLISHED_PRODUCTION_SUBPATHS),
  ).toEqual([]);
  expect(
    unpublishedCommunicationsUses(`${REVIEWED_COMMUNICATIONS_DEPENDENT}/shared`, PUBLISHED_PRODUCTION_SUBPATHS),
  ).toEqual([]);
  expect(
    unpublishedCommunicationsUses(`${REVIEWED_COMMUNICATIONS_DEPENDENT}/tests`, PUBLISHED_OWNER_COVERAGE_SUBPATHS),
  ).toEqual([]);
});

it('limits the reviewed Portal Auth source worker dependency to the published submit client', () => {
  // Every Communications subpath the package names, in production code and tests alike, is the published submit client.
  expect(unpublishedCommunicationsUses(REVIEWED_SOURCE_WORKER_DEPENDENT, [PUBLISHED_SUBMIT_REQUEST_CLIENT])).toEqual(
    [],
  );
  // Only the source worker's gateway names it; no API, page, Action or relay code of the package reaches Communications.
  expect(importsOf(REVIEWED_SOURCE_WORKER_DEPENDENT, COMMUNICATIONS_PACKAGE)).toEqual([SOURCE_WORKER_GATEWAY]);
});

it('still rejects any other dependent and any import beyond the reviewed published subpaths', () => {
  expect(unreviewedCommunicationsDependents(REVIEWED_COMMUNICATIONS_DEPENDENTS)).toEqual([]);
  expect(
    unreviewedCommunicationsDependents([
      'verticals/commerce-order',
      REVIEWED_SOURCE_WORKER_DEPENDENT,
      REVIEWED_COMMUNICATIONS_DEPENDENT,
      'verticals/commerce-cart',
      SHELL_DIRECTORY,
    ]),
  ).toEqual(['verticals/commerce-order', 'verticals/commerce-cart', SHELL_DIRECTORY]);
  const sourceWorkerAllowed = [PUBLISHED_SUBMIT_REQUEST_CLIENT];
  expect(
    unpublishedCommunicationsSubpaths(
      "import { executeSubmitCommunicationRequestWithAuthorization } from '@app/communications/api/submit-communication-request-action/client';",
      sourceWorkerAllowed,
    ),
  ).toEqual([]);
  expect(
    unpublishedCommunicationsSubpaths(
      [
        "import { Api } from '@app/communications/api/submit-communication-request-action';",
        "import { client } from '@app/communications/api/client';",
        "import { receipt } from '@app/communications/api/privacy-owner-execution-outcome/client';",
        "import { entry } from '@app/communications/outbox-worker-host';",
        'await import("@app/communications")',
      ].join('\n'),
      sourceWorkerAllowed,
    ),
  ).toEqual([
    '/api/submit-communication-request-action',
    '/api/client',
    '/api/privacy-owner-execution-outcome/client',
    '/outbox-worker-host',
    '',
  ]);
  const allowed = [PUBLISHED_OWNER_COVERAGE_DESCRIPTOR];
  expect(
    unpublishedCommunicationsSubpaths(
      "import { operation } from '@app/communications/api/privacy-owner-coverage';",
      allowed,
    ),
  ).toEqual([]);
  expect(
    unpublishedCommunicationsSubpaths("import { client } from '@app/communications/api/client';", allowed),
  ).toEqual(['/api/client']);
  expect(
    unpublishedCommunicationsSubpaths("import { x } from '@app/communications/src/domain/policy';", allowed),
  ).toEqual(['/src/domain/policy']);
  expect(unpublishedCommunicationsSubpaths('await import("@app/communications")', allowed)).toEqual(['']);
  // The schema-only contract package is a different package and is not mistaken for the deployment package.
  expect(
    unpublishedCommunicationsSubpaths("import type { Request } from '@app/communications-contracts';", allowed),
  ).toEqual([]);
});

it('keeps the Communication Request contract schema-only and independent of the deployment and its provider', () => {
  const dependencies = declaredDependencies('packages/communications-contracts');
  expect(dependencies.has(COMMUNICATIONS_PACKAGE)).toBe(false);
  expect(dependencies.has(EMAIL_DELIVERY_PACKAGE)).toBe(false);
  expect(importsOf('packages/communications-contracts/src', COMMUNICATIONS_PACKAGE)).toEqual([]);
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
