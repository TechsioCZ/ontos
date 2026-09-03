import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { TrustedPrincipalContextSchema } from '../../../packages/core-runtime/src/actions/principal-context.ts';
import type { TrustedPrincipalContext } from '../../../packages/core-runtime/src/actions/principal-context.ts';
import {
  defineEffectBff,
  Effect,
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
  HttpEffect,
  HttpServerResponse,
  Layer,
  Schema,
} from '@modern-js/plugin-bff/effect-edge';
import {
  GATEWAY_ASSERTION_CLOCK_SKEW_SECONDS,
  GATEWAY_ASSERTION_TTL_SECONDS,
} from '../../../packages/shared-contracts/src/gateway-context.ts';
import { SignJWT, exportJWK, generateKeyPair, generateSecret, importJWK } from 'jose';
import type { JWK } from 'jose';
import { issueGatewayContextAssertion } from '../../../apps/shell-super-app/api/auth/gateway-issuer.ts';
import type { GatewayIssuerConfigValue } from '../../../apps/shell-super-app/api/auth/gateway-issuer-config.ts';
import { getHelpText, runScaffold } from '../cli.mts';
import type { ScaffoldCommand } from '../cli.mts';
import type { JsonValue } from '../shared.mts';
import {
  assertPublishedOutboxDependencyUsage,
  publishedOutboxContractExports,
} from '../../published-outbox-contracts.mts';

interface Fixture {
  readonly root: string;
}

type GeneratedPrincipalErrorTag =
  | 'ActionPrincipalConfigurationError'
  | 'ActionPrincipalExpiredError'
  | 'ActionPrincipalInvalidError'
  | 'ActionPrincipalMissingError'
  | 'ActionPrincipalScopeError'
  | 'ActionPrincipalUnavailableError';

interface FixtureVertical {
  readonly appId: string;
  readonly mfBoundaryId: string;
  readonly moduleId: string;
  readonly namespace: string;
  readonly slug: string;
}

interface GeneratedPrincipalEnvironment {
  readonly ONTOS_GATEWAY_ISSUER?: string;
  readonly ONTOS_GATEWAY_PUBLIC_JWKS?: string;
}

const StringRecordSchema = Schema.Record(Schema.String, Schema.String);
const FixturePackageSchema = Schema.Struct({
  dependencies: StringRecordSchema,
  exports: StringRecordSchema,
  modernjs: Schema.Record(Schema.String, Schema.Json),
  scripts: StringRecordSchema,
});
const EsbuildMetafileSchema = Schema.Struct({
  inputs: Schema.Record(
    Schema.String,
    Schema.Struct({
      bytes: Schema.Number,
    }),
  ),
});
const RetryableProblemSchema = Schema.Struct({
  retryable: Schema.optional(Schema.Boolean),
});
const FixtureTsconfigSchema = Schema.Struct({
  references: Schema.Array(Schema.Struct({ path: Schema.String })),
});
const InventoryLocaleSchema = Schema.Struct({
  inventory: Schema.Struct({
    existing: Schema.optional(Schema.String),
    pages: Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.String)),
  }),
});

const decodeFixturePackage = (source: string) =>
  Schema.decodeUnknownSync(FixturePackageSchema, { onExcessProperty: 'preserve' })(
    JSON.parse(source),
  );
const decodeInventoryLocale = (source: string) =>
  Schema.decodeUnknownSync(InventoryLocaleSchema, { onExcessProperty: 'preserve' })(
    JSON.parse(source),
  );

const inventoryVertical: FixtureVertical = {
  appId: 'inventory-stock',
  mfBoundaryId: 'verticalInventoryStock',
  moduleId: 'inventory.stock',
  namespace: 'inventory',
  slug: 'inventory-stock',
};

const billingVertical: FixtureVertical = {
  appId: 'billing',
  mfBoundaryId: 'verticalBilling',
  moduleId: 'billing.core',
  namespace: 'billing',
  slug: 'billing',
};

const hrVertical: FixtureVertical = {
  appId: 'hr',
  mfBoundaryId: 'verticalHr',
  moduleId: 'hr.core',
  namespace: 'hr',
  slug: 'hr',
};

const contactsVertical: FixtureVertical = {
  appId: 'contacts',
  mfBoundaryId: 'verticalContacts',
  moduleId: 'contacts.core',
  namespace: 'contacts',
  slug: 'contacts',
};

const json = (value: JsonValue): string => `${JSON.stringify(value, null, 2)}\n`;
const appRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const require = createRequire(import.meta.url);
const createEntry = require.resolve('@modern-js/create');
const esbuildPath = require.resolve('esbuild/bin/esbuild', {
  paths: [path.dirname(createEntry)],
});
const oxfmtPath = path.join(appRoot, 'node_modules', '.bin', 'oxfmt');
const tscPath = path.join(appRoot, 'node_modules', '.bin', 'tsc');

const makeGatewayKey = async (
  kid: string,
): Promise<{
  configuration: GatewayIssuerConfigValue;
  publicJwk: JWK;
}> => {
  const pair = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  const privateJwk = await exportJWK(pair.privateKey);
  const publicJwk = await exportJWK(pair.publicKey);
  return {
    configuration: {
      issuer: 'https://shell.example.test',
      privateJwk: {
        alg: 'EdDSA',
        crv: 'Ed25519',
        d: privateJwk.d ?? '',
        kid,
        kty: 'OKP',
        use: 'sig',
        x: privateJwk.x ?? '',
      },
    },
    publicJwk: { ...publicJwk, alg: 'EdDSA', kid, use: 'sig' },
  };
};

const writeFixtureFile = async (
  root: string,
  relativePath: string,
  content: string,
): Promise<void> => {
  const filePath = path.join(root, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf-8');
};

const createVertical = async (root: string, vertical: FixtureVertical): Promise<void> => {
  await writeFixtureFile(
    root,
    `verticals/${vertical.slug}/module-federation.config.ts`,
    'export default { exposes: {} };\n',
  );
  await writeFixtureFile(
    root,
    `verticals/${vertical.slug}/tsconfig.json`,
    json({
      compilerOptions: { composite: true },
      include: ['src', 'shared'],
      references: [],
    }),
  );
  await writeFixtureFile(
    root,
    `verticals/${vertical.slug}/package.json`,
    json({
      dependencies: { zeta: '1.0.0' },
      exports: {
        './locales/cs': `./locales/cs/${vertical.namespace}.json`,
        './locales/en': `./locales/en/${vertical.namespace}.json`,
      },
      modernjs: {
        apiRuntime: 'effect',
        appId: vertical.appId,
        preset: 'presetUltramodern',
        role: 'module-federation-remote',
        topology: '../../topology/reference-topology.json',
      },
      name: `@app/${vertical.slug}`,
      private: true,
      scripts: {
        build: 'modern build && MODERNJS_DEPLOY=node modern deploy --skip-build',
        'cloudflare:build':
          'MODERNJS_DEPLOY=cloudflare modern build && MODERNJS_DEPLOY=cloudflare modern deploy --skip-build',
        existing: 'preserve-me',
      },
      version: '0.1.0',
    }),
  );
  await Promise.all(
    ['cs', 'en'].map((locale) =>
      writeFixtureFile(
        root,
        `verticals/${vertical.slug}/locales/${locale}/${vertical.namespace}.json`,
        json({
          [vertical.namespace]: {
            existing: `${locale}-preserved`,
          },
        }),
      ),
    ),
  );
  const resourcesName = `${vertical.slug
    .split('-')
    .map((segment, index) =>
      index === 0 ? segment : `${segment[0]?.toUpperCase() ?? ''}${segment.slice(1)}`,
    )
    .join('')}I18nResources`;
  await writeFixtureFile(
    root,
    `verticals/${vertical.slug}/src/i18n/resources.ts`,
    `import csResource from '../../locales/cs/${vertical.namespace}.json';
import enResource from '../../locales/en/${vertical.namespace}.json';

type LocaleResource = string | { readonly [key: string]: LocaleResource };

const flattenLocaleResource = (resource: LocaleResource, prefix = ''): Record<string, string> => {
  if (typeof resource === 'string') {
    return prefix.length > 0 ? { [prefix]: resource } : {};
  }

  return Object.fromEntries(
    Object.entries(resource).flatMap(([key, value]) => {
      const nextKey = prefix.length > 0 ? \`\${prefix}.\${key}\` : key;
      return typeof value === 'string'
        ? [[nextKey, value]]
        : Object.entries(flattenLocaleResource(value, nextKey));
    }),
  );
};

export const ${resourcesName} = {
  cs: { ${vertical.namespace}: flattenLocaleResource(csResource) },
  en: { ${vertical.namespace}: flattenLocaleResource(enResource) },
} as const;
`,
  );
  await writeFixtureFile(
    root,
    `verticals/${vertical.slug}/src/routes/ultramodern-route-head.tsx`,
    'export const UltramodernRouteHead = () => null;\n',
  );
};

const createFixture = async (): Promise<Fixture> => {
  const root = await mkdtemp(path.join(tmpdir(), 'ontos-scaffolding-'));
  await writeFixtureFile(root, 'package.json', json({ name: 'fixture', private: true }));
  await writeFixtureFile(
    root,
    'packages/core-runtime/src/index.ts',
    `export const existingCoreSurface = true;\n\n// <generated-core-action-exports>\n// </generated-core-action-exports>\n\n// <generated-global-policy-exports>\n// </generated-global-policy-exports>\n`,
  );
  await writeFixtureFile(
    root,
    'apps/shell-super-app/src/sentinel.ts',
    'export const shell = true;\n',
  );
  await writeFixtureFile(
    root,
    'apps/shell-super-app/src/api/vertical-clients.ts',
    `export const ultramodernVerticalClients = [
  // @ontos-codegen-start shell-page-clients
  // @ontos-codegen-end shell-page-clients
] as const;
`,
  );
  await createVertical(root, inventoryVertical);
  await createVertical(root, billingVertical);
  await createVertical(root, hrVertical);
  await createVertical(root, contactsVertical);
  await writeFixtureFile(
    root,
    'topology/reference-topology.json',
    json({
      schemaVersion: 1,
      verticals: [inventoryVertical, billingVertical, hrVertical, contactsVertical].map(
        (vertical) => ({
          domain: vertical.namespace,
          id: vertical.appId,
          kind: 'vertical',
          moduleFederation: {
            name: vertical.mfBoundaryId,
            role: 'remote',
          },
          package: `@app/${vertical.slug}`,
          path: `verticals/${vertical.slug}`,
        }),
      ),
    }),
  );
  await Promise.all(
    [inventoryVertical, billingVertical, hrVertical, contactsVertical].map((vertical) =>
      runScaffold('module-contract', ['--vertical', vertical.slug, '--module', vertical.moduleId], {
        workspaceRoot: root,
      }),
    ),
  );
  return { root };
};

const withFixture = async (run: (fixture: Fixture) => Promise<void>): Promise<void> => {
  const fixture = await createFixture();
  try {
    await run(fixture);
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
};

const snapshotTree = async (root: string): Promise<Readonly<Record<string, string>>> => {
  const snapshot: Record<string, string> = {};
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    await Promise.all(
      entries
        .toSorted((left, right) => left.name.localeCompare(right.name))
        .map(async (entry) => {
          const entryPath = path.join(directory, entry.name);
          if (entry.isDirectory()) {
            await visit(entryPath);
          } else if (entry.isFile()) {
            snapshot[path.relative(root, entryPath)] = await readFile(entryPath, 'utf-8');
          }
        }),
    );
  };
  await visit(root);
  return snapshot;
};

const readFixtureFile = (root: string, relativePath: string): Promise<string> =>
  readFile(path.join(root, relativePath), 'utf-8');

const run = (
  fixture: Fixture,
  command: ScaffoldCommand,
  arguments_: readonly string[],
  routeRefresh?: (appId: string) => void,
) =>
  runScaffold(
    command,
    command === 'action' &&
      arguments_.includes('--action') &&
      !arguments_.includes('--legal-entity-scope')
      ? [...arguments_, '--legal-entity-scope', 'optional']
      : arguments_,
    {
      routeRefresh: ({ appId }) => routeRefresh?.(appId),
      workspaceRoot: fixture.root,
    },
  );

const addInventoryItemResourceType = async (fixture: Fixture): Promise<void> => {
  const manifestPath = path.join(fixture.root, 'verticals/inventory-stock/vertical.manifest.ts');
  const manifest = await readFile(manifestPath, 'utf-8');
  await writeFile(
    manifestPath,
    manifest.replace(
      '    resourceTypes: [],',
      `    resourceTypes: [
      {
        capabilities: {
          graphVisible: false,
          linkable: true,
          mediaAttachable: false,
          searchable: true,
          timelineVisible: false,
        },
        description: 'Inventory item.',
        key: 'inventory.stock.item',
        label: 'Inventory item',
        owningModuleId: 'inventory.stock',
      },
    ],`,
    ),
    'utf-8',
  );
};

test('documents every command and treats --help as a write-free operation', async () => {
  await Promise.all(
    (
      [
        'action',
        'action-service',
        'external-http-adapter',
        'microvertical-action-boundary',
        'microvertical-page',
        'module-contract',
        'module-api',
        'outbox-message',
        'outbox-worker',
        'policy',
        'public-component',
        'report',
        'search-provider-access',
        'search-provider',
      ] as const
    ).map(async (command) => {
      const result = await runScaffold(command, ['--', '--help'], {
        workspaceRoot: path.join(tmpdir(), 'does-not-need-to-exist'),
      });
      assert.deepEqual(result, { help: getHelpText(command), kind: 'help' });
      assert.match(result.help, new RegExp(`scaffold:${command}`, 'u'));
    }),
  );
  assert.match(getHelpText('action'), /--vertical <vertical>/u);
  assert.match(getHelpText('action'), /--scope core --module <core\.module>/u);
  assert.match(getHelpText('microvertical-page'), /--url <url>/u);
  assert.match(getHelpText('microvertical-page'), /defaults to \/<vertical>\/<page>/u);
  assert.match(getHelpText('microvertical-page'), /:parameter/u);
  assert.match(getHelpText('microvertical-page'), /\/contacts\/customers\/:id\/edit/u);
  assert.match(
    getHelpText('external-http-adapter'),
    /scaffold:external-http-adapter -- --vertical <vertical> --provider <provider> --operation <operation>/u,
  );
  assert.match(
    getHelpText('external-http-adapter'),
    /--vertical contacts --provider ares --operation subject/u,
  );
  assert.match(getHelpText('search-provider-access'), /--tenant-permission read_party_identity/u);
});

test('search-provider access updates only generated access metadata and fails atomically on drift', async () => {
  await withFixture(async (fixture) => {
    await mkdir(path.join(fixture.root, 'verticals/retired/node_modules'), { recursive: true });
    await addInventoryItemResourceType(fixture);
    await run(fixture, 'search-provider', [
      '--vertical',
      'inventory-stock',
      '--name',
      'inventory-items',
      '--resource',
      'item',
    ]);
    await run(fixture, 'search-provider-access', [
      '--vertical',
      'inventory-stock',
      '--name',
      'inventory-items',
      '--legal-entity-scope',
      'optional',
      '--access-filtering',
      'tenant_scope',
      '--request-filters',
      'includeArchived',
      '--tenant-permission',
      'read_party_identity',
    ]);

    const [manifest, provider, contract] = await Promise.all([
      readFixtureFile(fixture.root, 'verticals/inventory-stock/vertical.manifest.ts'),
      readFixtureFile(
        fixture.root,
        'verticals/inventory-stock/src/search/inventory-items.provider.ts',
      ),
      readFixtureFile(
        fixture.root,
        'verticals/inventory-stock/shared/apis/inventory-items-search.ts',
      ),
    ]);
    assert.match(
      manifest,
      /accessFiltering: 'tenant_scope'.*requestFilters: \['includeArchived'\].*tenantPermission: 'read_party_identity'/u,
    );
    assert.match(provider, /legalEntityScope: 'optional'/u);
    assert.match(provider, /permissionTarget: 'tenant'/u);
    assert.match(provider, /kind: 'tenant', permission: 'read_party_identity'/u);
    assert.match(contract, /includeArchived: Schema\.optionalKey\(Schema\.Boolean\)/u);

    const providerPath = path.join(
      fixture.root,
      'verticals/inventory-stock/src/search/inventory-items.provider.ts',
    );
    await writeFile(
      providerPath,
      `${provider}\n// Owner-customized searchable semantics remain untouched.\n`,
    );
    const beforeIdempotentUpdate = await snapshotTree(fixture.root);
    await run(fixture, 'search-provider-access', [
      '--vertical',
      'inventory-stock',
      '--name',
      'inventory-items',
      '--legal-entity-scope',
      'optional',
      '--access-filtering',
      'tenant_scope',
      '--request-filters',
      'includeArchived',
      '--tenant-permission',
      'read_party_identity',
    ]);
    assert.deepEqual(await snapshotTree(fixture.root), beforeIdempotentUpdate);
    await writeFile(
      providerPath,
      provider.replace('// @generated by OntOS Codesmith ', '// custom '),
    );
    const beforeRejectedUpdate = await snapshotTree(fixture.root);
    await assert.rejects(
      run(fixture, 'search-provider-access', [
        '--vertical',
        'inventory-stock',
        '--name',
        'inventory-items',
        '--legal-entity-scope',
        'required',
        '--access-filtering',
        'resource_permission',
        '--request-filters',
        'includeArchived,role',
      ]),
      /Codesmith-owned provider/u,
    );
    assert.deepEqual(await snapshotTree(fixture.root), beforeRejectedUpdate);
  });
});

test('generated API owner slots sort property keys before suffix variants', async () => {
  await withFixture(async (fixture) => {
    await run(fixture, 'module-api', [
      '--vertical',
      'inventory-stock',
      '--name',
      'party-match-decision',
    ]);
    await run(fixture, 'module-api', ['--vertical', 'inventory-stock', '--name', 'party-match']);
    const sources = await Promise.all(
      ['vertical.manifest.ts', 'vertical.registration.ts'].map((owner) =>
        readFixtureFile(fixture.root, `verticals/inventory-stock/${owner}`),
      ),
    );
    for (const source of sources) {
      assert.ok(source.indexOf("'party-match':") < source.indexOf("'party-match-decision':"));
    }
  });
});

test('generated read clients fetch mounted owner URLs and support separately deployed hosts', async () => {
  await withFixture(async (fixture) => {
    await addInventoryItemResourceType(fixture);
    await run(fixture, 'module-api', [
      '--vertical',
      'inventory-stock',
      '--name',
      'resource-detail',
    ]);
    await run(fixture, 'search-provider', [
      '--vertical',
      'inventory-stock',
      '--name',
      'inventory-items',
      '--resource',
      'item',
    ]);
    await run(fixture, 'report', [
      '--vertical',
      'inventory-stock',
      '--name',
      'stock-levels',
      '--resource',
      'item',
    ]);
    await mkdir(path.join(fixture.root, 'node_modules/@app'), { recursive: true });
    await mkdir(path.join(fixture.root, 'node_modules/@modern-js'), { recursive: true });
    await symlink(
      path.join(appRoot, 'packages/shared-contracts'),
      path.join(fixture.root, 'node_modules/@app/shared-contracts'),
      'dir',
    );
    await symlink(
      path.join(appRoot, 'node_modules/effect'),
      path.join(fixture.root, 'node_modules/effect'),
      'dir',
    );
    await symlink(
      path.join(appRoot, 'node_modules/@modern-js/plugin-bff'),
      path.join(fixture.root, 'node_modules/@modern-js/plugin-bff'),
      'dir',
    );
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `
      import { Effect } from 'effect';
      import { FetchHttpClient } from 'effect/unstable/http';
      import { executeResourceDetail, executeResourceDetailWithAuthorization } from './verticals/inventory-stock/src/api/resource-detail-client.ts';
      import { loadInventoryItemsClient, loadInventoryItemsClientWithAuthorization } from './verticals/inventory-stock/src/api/inventory-items-search-client.ts';
      import { loadStockLevelsClient, loadStockLevelsClientWithAuthorization } from './verticals/inventory-stock/src/api/stock-levels-report-client.ts';
      const calls = [];
      const cases = [
        [executeResourceDetailWithAuthorization, {}, { ok: true }, executeResourceDetail],
        [loadInventoryItemsClientWithAuthorization, { query: 'chair' }, [], loadInventoryItemsClient],
        [loadStockLevelsClientWithAuthorization, { parameters: {} }, { rows: [] }, loadStockLevelsClient],
      ];
      for (const [invoke, payload, response] of cases) {
        const fetch = async (url, init) => {
          calls.push({ url: String(url), method: init.method, authorization: new Headers(init.headers).get('authorization'), correlationId: new Headers(init.headers).get('x-correlation-id') });
          return Response.json(response);
        };
        await Effect.runPromise(invoke(payload, 'Bearer proof', 'correlation-proof', { baseUrl: new URL('https://inventory.example.test/custom/inventory-stock-api') }).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch)));
      }
      globalThis.location = { origin: 'https://shell.example.test', pathname: '/cs/inventory' };
      for (const [invoke, payload, response] of cases) {
        await Effect.runPromise(invoke(payload, 'Bearer proof', 'correlation-proof').pipe(Effect.provideService(FetchHttpClient.Fetch, async (url, init) => {
          calls.push({ url: String(url), method: init.method, authorization: new Headers(init.headers).get('authorization'), correlationId: new Headers(init.headers).get('x-correlation-id') });
          return Response.json(response);
        })));
      }
      for (const [, payload, response, invoke] of cases) {
        await Effect.runPromise(invoke(payload, 'correlation-proof', { baseUrl: 'https://inventory.example.test/custom/inventory-stock-api' }).pipe(Effect.provideService(FetchHttpClient.Fetch, async (url, init) => {
          if (String(url) === 'https://shell.example.test/shell-super-app-api/auth/gateway-context') {
            return Response.json({ expiresAt: 2_000_000_000, token: 'proof' });
          }
          calls.push({ url: String(url), method: init.method, authorization: new Headers(init.headers).get('authorization'), correlationId: new Headers(init.headers).get('x-correlation-id') });
          return Response.json(response);
        })));
      }
      console.log(JSON.stringify(calls));
    `,
      ],
      { cwd: fixture.root, encoding: 'utf-8' },
    );
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.deepEqual(
      JSON.parse(result.stdout),
      [
        'https://inventory.example.test/custom/inventory-stock-api/reads/resource-detail',
        'https://inventory.example.test/custom/inventory-stock-api/inventory.stock/search/inventory-items',
        'https://inventory.example.test/custom/inventory-stock-api/inventory.stock/reports/stock-levels',
        'https://shell.example.test/inventory-stock-api/reads/resource-detail',
        'https://shell.example.test/inventory-stock-api/inventory.stock/search/inventory-items',
        'https://shell.example.test/inventory-stock-api/inventory.stock/reports/stock-levels',
        'https://inventory.example.test/custom/inventory-stock-api/reads/resource-detail',
        'https://inventory.example.test/custom/inventory-stock-api/inventory.stock/search/inventory-items',
        'https://inventory.example.test/custom/inventory-stock-api/inventory.stock/reports/stock-levels',
      ].map((url) => ({
        authorization: 'Bearer proof',
        correlationId: 'correlation-proof',
        method: 'POST',
        url,
      })),
    );
  });
});

test('governed contribution generators patch owner contracts and lazy adapters atomically', async () => {
  await withFixture(async (fixture) => {
    const manifestPath = path.join(fixture.root, 'verticals/inventory-stock/vertical.manifest.ts');
    await addInventoryItemResourceType(fixture);

    await run(fixture, 'module-api', [
      '--vertical',
      'inventory-stock',
      '--name',
      'resource-detail',
    ]);
    await run(fixture, 'module-api', [
      '--vertical',
      'inventory-stock',
      '--name',
      'resource-history',
    ]);
    await run(fixture, 'public-component', [
      '--vertical',
      'inventory-stock',
      '--name',
      'inventory-summary',
    ]);
    await run(fixture, 'public-component', [
      '--vertical',
      'inventory-stock',
      '--name',
      'inventory-alerts',
    ]);
    await run(fixture, 'search-provider', [
      '--vertical',
      'inventory-stock',
      '--name',
      'inventory-items',
      '--resource',
      'item',
    ]);
    await run(fixture, 'report', [
      '--vertical',
      'inventory-stock',
      '--name',
      'stock-levels',
      '--resource',
      'item',
    ]);

    const [nextManifest, registration, federation] = await Promise.all([
      readFile(manifestPath, 'utf-8'),
      readFixtureFile(fixture.root, 'verticals/inventory-stock/vertical.registration.ts'),
      readFixtureFile(fixture.root, 'verticals/inventory-stock/module-federation.config.ts'),
    ]);
    assert.match(nextManifest, /inventory\.stock\.component\.inventory-summary/u);
    assert.match(nextManifest, /inventory\.stock\.search\.inventory-items/u);
    assert.match(nextManifest, /inventory\.stock\.report\.stock-levels/u);
    assert.match(registration, /import\('\.\/src\/api\/resource-detail-client\.ts'\)/u);
    assert.match(registration, /import\('\.\/src\/api\/inventory-items-search-client\.ts'\)/u);
    assert.match(registration, /import\('\.\/src\/api\/stock-levels-report-client\.ts'\)/u);
    assert.match(federation, /\.\/InventoryAlerts/u);
    assert.match(federation, /\.\/InventorySummary/u);
    assert.doesNotMatch(nextManifest, /import\('/u);
    const searchClient = await readFixtureFile(
      fixture.root,
      'verticals/inventory-stock/src/api/inventory-items-search-client.ts',
    );
    const reportClient = await readFixtureFile(
      fixture.root,
      'verticals/inventory-stock/src/api/stock-levels-report-client.ts',
    );
    const moduleApiClient = await readFixtureFile(
      fixture.root,
      'verticals/inventory-stock/src/api/resource-detail-client.ts',
    );
    const moduleApiContract = await readFixtureFile(
      fixture.root,
      'verticals/inventory-stock/shared/apis/resource-detail.ts',
    );
    const secondModuleApiContract = await readFixtureFile(
      fixture.root,
      'verticals/inventory-stock/shared/apis/resource-history.ts',
    );
    const secondModuleApiClient = await readFixtureFile(
      fixture.root,
      'verticals/inventory-stock/src/api/resource-history-client.ts',
    );
    const searchProvider = await readFixtureFile(
      fixture.root,
      'verticals/inventory-stock/src/search/inventory-items.provider.ts',
    );
    const reportProvider = await readFixtureFile(
      fixture.root,
      'verticals/inventory-stock/src/reports/stock-levels.provider.ts',
    );
    const moduleApiRead = await readFixtureFile(
      fixture.root,
      'verticals/inventory-stock/src/api/resource-detail.read.ts',
    );
    const searchServer = await readFixtureFile(
      fixture.root,
      'verticals/inventory-stock/api/inventory-items-search-server.ts',
    );
    const reportServer = await readFixtureFile(
      fixture.root,
      'verticals/inventory-stock/api/stock-levels-report-server.ts',
    );
    const moduleApiServer = await readFixtureFile(
      fixture.root,
      'verticals/inventory-stock/api/resource-detail-read-server.ts',
    );
    const operationBoundary = await readFixtureFile(
      fixture.root,
      'verticals/inventory-stock/api/auth/action-principal.ts',
    );
    assert.match(searchClient, /makeEffectHttpApiClient\(InventoryItemsSearchApi,/u);
    assert.match(reportClient, /makeEffectHttpApiClient\(StockLevelsReportApi,/u);
    assert.match(
      moduleApiContract,
      /headers: \{\},\s+params: \{\},\s+payload: ResourceDetailRequestSchema,\s+query: \{\}/u,
    );
    assert.match(
      moduleApiClient,
      /client\.resourceDetail\.execute\(\{ headers: \{\}, params: \{\}, payload, query: \{\} \}\)/u,
    );
    assert.match(moduleApiContract, /HttpApiGroup\.make\('resourceDetail'\)/u);
    assert.match(secondModuleApiContract, /HttpApiGroup\.make\('resourceHistory'\)/u);
    assert.match(secondModuleApiClient, /client\.resourceHistory\.execute\(/u);
    for (const client of [moduleApiClient, searchClient, reportClient]) {
      assert.match(client, /operationGateway\.invoke\(\(authorization\) =>/u);
      assert.match(client, /WithAuthorization/u);
      assert.match(client, /setHeaders\(\{ authorization, 'x-correlation-id': correlationId \}\)/u);
    }
    assert.doesNotMatch(searchClient, /\.provider\.ts|import\(/u);
    assert.doesNotMatch(reportClient, /\.provider\.ts|import\(/u);
    for (const provider of [searchProvider, reportProvider]) {
      assert.match(provider, /defineRead\(/u);
      assert.match(provider, /legalEntityScope: 'required'/u);
      assert.match(provider, /permissionTarget: 'module'/u);
      assert.doesNotMatch(provider, /CoreDatabase|ScopedTransactionExecutor|from 'pg'/u);
    }
    assert.match(searchProvider, /result\.map\(\(\{ ref \}\) => ref\)/u);
    assert.match(moduleApiRead, /defineRead\(/u);
    assert.match(moduleApiRead, /legalEntityScope: 'required'/u);
    for (const server of [moduleApiServer, searchServer, reportServer]) {
      assert.match(server, /verifyOperationPrincipal\(request\.headers\.authorization,/u);
      assert.match(server, /yield\* ReadRuntime/u);
      assert.match(server, /\.runRead\(\{/u);
      assert.match(server, /HttpEffect\.appendPreResponseHandler/u);
      assert.match(server, /'www-authenticate', 'Bearer'/u);
      assert.match(server, /case 'ReadHandlerNotFound'/u);
      assert.match(server, /case 'ReadPolicyDenied'/u);
      assert.match(server, /policyProblem\(error\.httpStatus\)/u);
      assert.match(server, /problem\.status === 401 \? bearerChallenge/u);
      assert.doesNotMatch(server, /tenantId|legalEntityId|principalId|CoreDatabase|from 'pg'/u);
    }
    assert.match(
      operationBoundary,
      /export const verifyOperationPrincipal = verifyActionPrincipal/u,
    );
    const searchContract = await readFixtureFile(
      fixture.root,
      'verticals/inventory-stock/shared/apis/inventory-items-search.ts',
    );
    assert.match(
      searchContract,
      /HttpApiEndpoint\.post\('execute', '\/inventory\.stock\/search\/inventory-items'/u,
    );
    assert.doesNotMatch(searchContract, /tenantId|legalEntityId|principalId/u);
    assert.match(searchContract, /PolicyConflictProblem/u);
    assert.match(searchContract, /Schema\.Literal\(409\)/u);

    const beforeRepeat = await snapshotTree(fixture.root);
    await assert.rejects(
      run(fixture, 'public-component', [
        '--vertical',
        'inventory-stock',
        '--name',
        'inventory-summary',
      ]),
      /refusing to overwrite/u,
    );
    assert.deepEqual(await snapshotTree(fixture.root), beforeRepeat);
    await assert.rejects(
      run(fixture, 'module-api', ['--vertical', 'inventory-stock', '--name', '../unsafe']),
      /lower-kebab-case/u,
    );
    assert.deepEqual(await snapshotTree(fixture.root), beforeRepeat);

    const billingFederationPath = path.join(
      fixture.root,
      'verticals/billing/module-federation.config.ts',
    );
    await writeFile(
      billingFederationPath,
      `const ignored = /exposes: \\{\\}/u;
// exposes: {}
export default {
  exposes: {},
  manifest: {
    additionalData: ({ stats }) => ({ exposes: stats.exposes.map(String) }),
  },
};
void ignored;
`,
      'utf-8',
    );
    await run(fixture, 'public-component', ['--vertical', 'billing', '--name', 'billing-summary']);
    const commentSafeFederation = await readFile(billingFederationPath, 'utf-8');
    assert.match(commentSafeFederation, /\/exposes: \\\{\\\}\/u/u);
    assert.match(commentSafeFederation, /\.\/BillingSummary/u);
    await writeFile(billingFederationPath, 'export default {};\n', 'utf-8');
    const beforeUnpatchable = await snapshotTree(fixture.root);
    await assert.rejects(
      run(fixture, 'public-component', ['--vertical', 'billing', '--name', 'billing-details']),
      /exposes object is missing/u,
    );
    assert.deepEqual(await snapshotTree(fixture.root), beforeUnpatchable);
  });
});

test('recognizes only exact schema-only Outbox package subpaths as cross-vertical contracts', () => {
  const producerPackage = {
    exports: {
      '.': './src/index.ts',
      './outbox/orders-created': './shared/outbox/orders-created.ts',
      './workers': './src/workers/index.ts',
    },
  };
  assert.deepEqual(publishedOutboxContractExports(producerPackage), ['./outbox/orders-created']);
  assert.doesNotThrow(() =>
    assertPublishedOutboxDependencyUsage({
      dependencyPackageJson: producerPackage,
      dependencyPackageName: '@app/inventory-stock',
      moduleSpecifiers: ['@app/inventory-stock/outbox/orders-created'],
    }),
  );
  assert.throws(
    () =>
      assertPublishedOutboxDependencyUsage({
        dependencyPackageJson: producerPackage,
        dependencyPackageName: '@app/inventory-stock',
        moduleSpecifiers: ['@app/inventory-stock/workers'],
      }),
    /not a published schema-only Outbox contract subpath/u,
  );
  assert.throws(
    () =>
      assertPublishedOutboxDependencyUsage({
        dependencyPackageJson: { exports: { '.': './src/index.ts' } },
        dependencyPackageName: '@app/inventory-stock',
        moduleSpecifiers: ['@app/inventory-stock'],
      }),
    /not a published schema-only Outbox contract dependency/u,
  );
});

test('rejects malformed command contracts and leaves the fixture unchanged', async () => {
  await withFixture(async (fixture) => {
    const before = await snapshotTree(fixture.root);
    await assert.rejects(
      runScaffold('action', ['--vertical', 'inventory-stock', '--action', 'create-order'], {
        workspaceRoot: fixture.root,
      }),
      /missing required flag --legal-entity-scope/u,
    );
    assert.deepEqual(await snapshotTree(fixture.root), before);
    const invalidCalls: readonly [ScaffoldCommand, readonly string[], RegExp][] = [
      ['action', ['--vertical', 'inventory-stock'], /missing required flag --action/u],
      [
        'action',
        [
          '--vertical',
          'inventory-stock',
          '--action',
          'create-order',
          '--legal-entity-scope',
          'invalid',
        ],
        /must be required, optional, or forbidden/u,
      ],
      [
        'action',
        ['--vertical', 'inventory-stock', '--action', 'create-order', '--unknown', 'x'],
        /unknown flag --unknown/u,
      ],
      [
        'action',
        ['--vertical', 'inventory-stock', '--action', 'create-order', '--action', 'again'],
        /only once/u,
      ],
      ['action', ['--vertical', '', '--action', 'create-order'], /non-empty value/u],
      ['action', ['--vertical', '../billing', '--action', 'create-order'], /lower-kebab-case/u],
      ['action', ['--vertical', '/tmp/billing', '--action', 'create-order'], /lower-kebab-case/u],
      [
        'action',
        [
          '--vertical',
          'inventory-stock',
          '--scope',
          'core',
          '--module',
          'core.modules',
          '--action',
          'create-order',
        ],
        /mutually exclusive/u,
      ],
      ['action', ['--scope', 'core', '--action', 'create-order'], /--module is required/u],
      [
        'action',
        ['--scope', 'other', '--module', 'core.modules', '--action', 'create-order'],
        /--scope core is required/u,
      ],
      [
        'action',
        ['--scope', 'core', '--module', 'billing.modules', '--action', 'create-order'],
        /stable lowercase core/u,
      ],
      [
        'action',
        ['--scope', 'core', '--module', 'core.../modules', '--action', 'create-order'],
        /stable lowercase core/u,
      ],
      [
        'action',
        ['--vertical', 'missing', '--action', 'create-order'],
        /package metadata is missing/u,
      ],
      [
        'microvertical-action-boundary',
        ['--vertical', 'inventory-stock', '--unknown', 'x'],
        /unknown flag --unknown/u,
      ],
      ['microvertical-action-boundary', ['--vertical', '../billing'], /lower-kebab-case/u],
      [
        'policy',
        ['--scope', 'global', '--policy', 'tenant-active', '--vertical', 'inventory-stock'],
        /forbidden/u,
      ],
      ['policy', ['--scope', 'microvertical', '--policy', 'tenant-active'], /required/u],
      ['policy', ['--scope', 'other', '--policy', 'tenant-active'], /global or microvertical/u],
      [
        'outbox-message',
        ['--vertical', 'inventory-stock', '--action', 'create-order', '--topic', 'Not.Safe'],
        /dot-separated/u,
      ],
      [
        'outbox-worker',
        [
          '--vertical',
          'billing',
          '--worker',
          'orders-logger',
          '--producer',
          'inventory-stock',
          '--topic',
          '../orders.created',
        ],
        /dot-separated/u,
      ],
    ];
    await Promise.all(
      invalidCalls.map(async ([command, arguments_, expected]) => {
        await assert.rejects(run(fixture, command, arguments_), expected);
        assert.deepEqual(await snapshotTree(fixture.root), before);
      }),
    );
  });
});

test('generates one immutable Action identity boundary and exact direct dependencies', async () => {
  await withFixture(async (fixture) => {
    const shellBefore = await readFixtureFile(fixture.root, 'apps/shell-super-app/src/sentinel.ts');
    const topologyBefore = await readFixtureFile(fixture.root, 'topology/reference-topology.json');
    const result = await run(fixture, 'microvertical-action-boundary', [
      '--vertical',
      'inventory-stock',
    ]);
    assert.equal(result.kind, 'generated');
    const server = await readFixtureFile(
      fixture.root,
      'verticals/inventory-stock/api/auth/action-principal.ts',
    );
    const client = await readFixtureFile(
      fixture.root,
      'verticals/inventory-stock/src/api/action-gateway.ts',
    );
    for (const source of [server, client]) {
      assert.match(source, /@ontos-action-boundary-owner inventory-stock/u);
      assert.match(source, /@ontos-action-boundary-audience inventory-stock/u);
      assert.match(source, /ACTION_GATEWAY_AUDIENCE = 'inventory-stock'/u);
    }
    assert.match(server, /algorithms: \['EdDSA'\]/u);
    assert.match(server, /@app\/core-runtime\/actions\/principal-context/u);
    assert.match(server, /TrustedPrincipalContextSchema/u);
    assert.match(server, /\^Bearer /u);
    assert.match(server, /Clock\.currentTimeMillis/u);
    assert.doesNotMatch(server, /Date\.now|Effect\.runPromise|decodeUnknownSync/u);
    assert.match(client, /acquire\(\{ audience: ACTION_GATEWAY_AUDIENCE \}/u);
    assert.doesNotMatch(client, /localStorage|sessionStorage/u);
    const packageJson = decodeFixturePackage(
      await readFixtureFile(fixture.root, 'verticals/inventory-stock/package.json'),
    );
    assert.deepEqual(packageJson.dependencies, {
      '@app/core-runtime': 'workspace:*',
      '@app/shared-contracts': 'workspace:*',
      effect: '4.0.0-beta.107',
      jose: '6.2.5',
      zeta: '1.0.0',
    });
    assert.equal(packageJson.scripts['existing'], 'preserve-me');
    assert.equal(
      await readFixtureFile(fixture.root, 'apps/shell-super-app/src/sentinel.ts'),
      shellBefore,
    );
    assert.equal(
      await readFixtureFile(fixture.root, 'topology/reference-topology.json'),
      topologyBefore,
    );
  });
});

test('Action identity boundary preflight refuses unsafe writes', async () => {
  await withFixture(async (fixture) => {
    await run(fixture, 'microvertical-action-boundary', ['--vertical', 'inventory-stock']);
    const afterFirstRun = await snapshotTree(fixture.root);
    await assert.rejects(
      run(fixture, 'microvertical-action-boundary', ['--vertical', 'inventory-stock']),
      /refusing to overwrite existing business file/u,
    );
    assert.deepEqual(await snapshotTree(fixture.root), afterFirstRun);
  });
  await withFixture(async (fixture) => {
    const packagePath = path.join(fixture.root, 'verticals/inventory-stock/package.json');
    const packageJson = decodeFixturePackage(await readFile(packagePath, 'utf-8'));
    packageJson.dependencies['jose'] = '^5.0.0';
    await writeFile(packagePath, json(packageJson), 'utf-8');
    const before = await snapshotTree(fixture.root);
    await assert.rejects(
      run(fixture, 'microvertical-action-boundary', ['--vertical', 'inventory-stock']),
      /incompatible jose dependency/u,
    );
    assert.deepEqual(await snapshotTree(fixture.root), before);
  });
});

test('generated verifier executes real Shell assertions and overlapping Ed25519 rotation', async () => {
  await withFixture(async (fixture) => {
    await run(fixture, 'microvertical-action-boundary', ['--vertical', 'inventory-stock']);
    await mkdir(path.join(fixture.root, 'node_modules', '@app'), { recursive: true });
    await symlink(
      path.join(appRoot, 'packages/core-runtime'),
      path.join(fixture.root, 'node_modules/@app/core-runtime'),
      'dir',
    );
    await symlink(
      path.join(appRoot, 'packages/shared-contracts'),
      path.join(fixture.root, 'node_modules/@app/shared-contracts'),
      'dir',
    );
    await symlink(
      path.join(appRoot, 'packages/core-runtime/node_modules/effect'),
      path.join(fixture.root, 'node_modules/effect'),
      'dir',
    );
    await symlink(
      path.join(appRoot, 'apps/shell-super-app/node_modules/jose'),
      path.join(fixture.root, 'node_modules/jose'),
      'dir',
    );
    const edgeBundleDirectory = path.join(fixture.root, 'edge-bundle');
    await mkdir(edgeBundleDirectory, { recursive: true });
    const edgeMetafile = path.join(edgeBundleDirectory, 'meta.json');
    const edgeBundle = spawnSync(
      esbuildPath,
      [
        path.join(fixture.root, 'verticals/inventory-stock/api/auth/action-principal.ts'),
        '--bundle',
        '--format=esm',
        `--metafile=${edgeMetafile}`,
        `--outfile=${path.join(edgeBundleDirectory, 'action-principal.mjs')}`,
        '--platform=browser',
      ],
      { encoding: 'utf-8' },
    );
    assert.equal(
      edgeBundle.status,
      0,
      edgeBundle.stderr || edgeBundle.error?.message || 'edge bundle command did not start',
    );
    const edgeInputs = Object.keys(
      Schema.decodeUnknownSync(EsbuildMetafileSchema)(
        JSON.parse(await readFile(edgeMetafile, 'utf-8')),
      ).inputs,
    ).join('\n');
    assert.doesNotMatch(edgeInputs, /core-runtime\/src\/(?:auth|db)|node:(?:crypto|path)|\/pg\//u);
    // SAFETY: The fixture module was generated and successfully bundled above; TypeScript cannot infer exports from its runtime-only temporary path, and the calls below execute the declared verifier contract.
    const generated = (await import(
      pathToFileURL(
        path.join(fixture.root, 'verticals/inventory-stock/api/auth/action-principal.ts'),
      ).href
    )) as {
      verifyActionPrincipal: (
        authorization: string | undefined,
        options: {
          currentTimeSeconds: Effect.Effect<number>;
          environment: GeneratedPrincipalEnvironment;
        },
      ) => Effect.Effect<TrustedPrincipalContext, { readonly _tag: GeneratedPrincipalErrorTag }>;
    };
    // SAFETY: The fixture client module was generated from the tested template at this temporary path; TypeScript cannot statically resolve its exports, and the invocation below verifies the declared gateway contract.
    const generatedClient = (await import(
      pathToFileURL(path.join(fixture.root, 'verticals/inventory-stock/src/api/action-gateway.ts'))
        .href
    )) as {
      makeActionGateway: (
        acquire: (payload: { audience: string }) => Effect.Effect<{ token: string }>,
      ) => {
        invoke: <Success>(
          attempt: (authorization: string) => Effect.Effect<Success>,
        ) => Effect.Effect<Success>;
      };
    };
    const current = await makeGatewayKey('current');
    const retiring = await makeGatewayKey('retiring');
    const principal = {
      authBindingId: '30000000-0000-4000-8000-000000000001',
      authContextRef: 'better-auth-session:scaffold-test',
      authMethod: 'session' as const,
      principalId: '40000000-0000-4000-8000-000000000001',
      tenantId: '50000000-0000-4000-8000-000000000001',
    };
    const issue = (
      configuration: GatewayIssuerConfigValue,
      issuedAt: number,
      audience = 'inventory-stock',
    ) =>
      Effect.runPromise(
        issueGatewayContextAssertion(
          { audience, principal },
          {
            currentTimeSeconds: Effect.succeed(issuedAt),
            generateJti: Effect.succeed('60000000-0000-4000-8000-000000000001'),
            loadAudiences: Effect.succeed(new Set([audience])),
            loadConfig: Effect.succeed(configuration),
          },
        ),
      );
    const environment = {
      ONTOS_GATEWAY_ISSUER: 'https://shell.example.test',
      ONTOS_GATEWAY_PUBLIC_JWKS: JSON.stringify({
        keys: [current.publicJwk, retiring.publicJwk],
      }),
    };
    const currentAssertion = await issue(current.configuration, 1_700_000_000);
    const retiringAssertion = await issue(retiring.configuration, 1_700_000_000);
    const verify = (token: string, override = environment, now = 1_700_000_001) =>
      Effect.runPromise(
        generated.verifyActionPrincipal(`Bearer ${token}`, {
          currentTimeSeconds: Effect.succeed(now),
          environment: override,
        }),
      );

    assert.deepEqual(await verify(currentAssertion.token), principal);
    assert.deepEqual(await verify(retiringAssertion.token), principal);
    await assert.rejects(
      verify('not-a-jwt'),
      (error: { _tag?: string }) => error._tag === 'ActionPrincipalInvalidError',
    );
    await Promise.all(
      [
        { keys: [] },
        { keys: [current.publicJwk, current.publicJwk] },
        { keys: [{ ...current.publicJwk, d: 'private-material' }] },
        { keys: [{ ...current.publicJwk, key_ops: ['sign'] }] },
        { keys: [{ ...current.publicJwk, alg: 'HS256' }] },
        { keys: [{ ...current.publicJwk, x: '' }] },
      ].map((jwks) =>
        assert.rejects(
          verify(currentAssertion.token, {
            ...environment,
            ONTOS_GATEWAY_PUBLIC_JWKS: JSON.stringify(jwks),
          }),
          (error: { _tag?: string }) => error._tag === 'ActionPrincipalConfigurationError',
        ),
      ),
    );
    await assert.rejects(
      verify(currentAssertion.token, {
        ...environment,
        ONTOS_GATEWAY_ISSUER: 'file:///not-an-http-issuer',
      }),
      (error: { _tag?: string }) => error._tag === 'ActionPrincipalConfigurationError',
    );
    await assert.rejects(
      verify(
        retiringAssertion.token,
        {
          ...environment,
          ONTOS_GATEWAY_PUBLIC_JWKS: JSON.stringify({ keys: [current.publicJwk] }),
        },
        1_700_000_000 + GATEWAY_ASSERTION_TTL_SECONDS + GATEWAY_ASSERTION_CLOCK_SKEW_SECONDS + 1,
      ),
      (error: { _tag?: string }) => error._tag === 'ActionPrincipalInvalidError',
    );
    const wrongAudience = await issue(current.configuration, 1_700_000_000, 'billing');
    await assert.rejects(
      verify(wrongAudience.token),
      (error: { _tag?: string }) => error._tag === 'ActionPrincipalScopeError',
    );
    const wrongIssuer = await issue(
      { ...current.configuration, issuer: 'https://other.example.test' },
      1_700_000_000,
    );
    await assert.rejects(
      verify(wrongIssuer.token),
      (error: { _tag?: string }) => error._tag === 'ActionPrincipalScopeError',
    );
    const unknownKid = await issue(
      {
        ...current.configuration,
        privateJwk: { ...current.configuration.privateJwk, kid: 'unknown' },
      },
      1_700_000_000,
    );
    await assert.rejects(
      verify(unknownKid.token),
      (error: { _tag?: string }) => error._tag === 'ActionPrincipalInvalidError',
    );
    const expired = await issue(current.configuration, 1_699_999_000);
    await assert.rejects(
      verify(expired.token),
      (error: { _tag?: string }) => error._tag === 'ActionPrincipalExpiredError',
    );
    const future = await issue(current.configuration, 1_700_000_032);
    await assert.rejects(
      verify(future.token),
      (error: { _tag?: string }) => error._tag === 'ActionPrincipalInvalidError',
    );
    const signingKey = await importJWK(current.configuration.privateJwk, 'EdDSA');
    const mismatchedSubject = await new SignJWT({ principal, ver: 1 })
      .setProtectedHeader({ alg: 'EdDSA', kid: 'current', typ: 'JWT' })
      .setIssuer('https://shell.example.test')
      .setAudience('inventory-stock')
      .setSubject('70000000-0000-4000-8000-000000000001')
      .setIssuedAt(1_700_000_000)
      .setExpirationTime(1_700_000_300)
      .setJti('60000000-0000-4000-8000-000000000001')
      .sign(signingKey);
    await assert.rejects(
      verify(mismatchedSubject),
      (error: { _tag?: string }) => error._tag === 'ActionPrincipalInvalidError',
    );
    const invalidContext = await new SignJWT({
      principal: { ...principal, principalId: 'not-a-uuid' },
      ver: 1,
    })
      .setProtectedHeader({ alg: 'EdDSA', kid: 'current', typ: 'JWT' })
      .setIssuer('https://shell.example.test')
      .setAudience('inventory-stock')
      .setSubject('not-a-uuid')
      .setIssuedAt(1_700_000_000)
      .setExpirationTime(1_700_000_300)
      .setJti('60000000-0000-4000-8000-000000000001')
      .sign(signingKey);
    await assert.rejects(
      verify(invalidContext),
      (error: { _tag?: string }) => error._tag === 'ActionPrincipalInvalidError',
    );
    const hmacToken = await new SignJWT({ principal, ver: 1 })
      .setProtectedHeader({ alg: 'HS256', kid: 'current', typ: 'JWT' })
      .setIssuer('https://shell.example.test')
      .setAudience('inventory-stock')
      .setSubject(principal.principalId)
      .setIssuedAt(1_700_000_000)
      .setExpirationTime(1_700_000_300)
      .setJti('60000000-0000-4000-8000-000000000001')
      .sign(await generateSecret('HS256'));
    await assert.rejects(
      verify(hmacToken),
      (error: { _tag?: string }) => error._tag === 'ActionPrincipalInvalidError',
    );
    const tokenParts = currentAssertion.token.split('.');
    const encodedPayload = tokenParts[1] ?? '';
    const tampered = `${tokenParts[0]}.${encodedPayload.startsWith('a') ? 'b' : 'a'}${encodedPayload.slice(1)}.${tokenParts[2]}`;
    await assert.rejects(
      verify(tampered),
      (error: { _tag?: string }) => error._tag === 'ActionPrincipalInvalidError',
    );
    await assert.rejects(
      Effect.runPromise(
        generated.verifyActionPrincipal(undefined, {
          currentTimeSeconds: Effect.succeed(1_700_000_001),
          environment,
        }),
      ),
      (error: { _tag?: string }) => error._tag === 'ActionPrincipalMissingError',
    );
    await assert.rejects(
      Effect.runPromise(
        generated.verifyActionPrincipal('bearer malformed', {
          currentTimeSeconds: Effect.succeed(1_700_000_001),
          environment,
        }),
      ),
      (error: { _tag?: string }) => error._tag === 'ActionPrincipalInvalidError',
    );
    await assert.rejects(
      Effect.runPromise(
        generated.verifyActionPrincipal(`Bearer ${currentAssertion.token}`, {
          currentTimeSeconds: Effect.succeed(1_700_000_001),
          environment: {},
        }),
      ),
      (error: { _tag?: string }) => error._tag === 'ActionPrincipalConfigurationError',
    );
    let acquisitions = 0;
    const authorizations: string[] = [];
    const idempotencyKey = 'caller-owned-idempotency-key';
    const actionGateway = generatedClient.makeActionGateway(({ audience }) => {
      acquisitions += 1;
      assert.equal(audience, 'inventory-stock');
      return Effect.succeed({ token: `attempt-${acquisitions}` });
    });
    const attempt = (authorization: string) => {
      authorizations.push(authorization);
      return Effect.succeed(idempotencyKey);
    };
    assert.equal(await Effect.runPromise(actionGateway.invoke(attempt)), idempotencyKey);
    assert.equal(await Effect.runPromise(actionGateway.invoke(attempt)), idempotencyKey);
    assert.deepEqual(authorizations, ['Bearer attempt-1', 'Bearer attempt-2']);

    const problemFields = {
      detail: Schema.String,
      status: Schema.Finite,
      title: Schema.String,
      type: Schema.String,
    };
    const asProblemDetails = HttpApiSchema.asJson({ contentType: 'application/problem+json' });
    const ActionAuthenticationProblemSchema = Schema.TaggedStruct(
      'ActionAuthenticationProblem',
      problemFields,
    ).pipe(asProblemDetails, HttpApiSchema.status(401));
    const ActionVerificationUnavailableProblemSchema = Schema.TaggedStruct(
      'ActionVerificationUnavailableProblem',
      { ...problemFields, retryable: Schema.Literal(true) },
    ).pipe(asProblemDetails, HttpApiSchema.status(503));
    type EndpointProblem =
      | Schema.Schema.Type<typeof ActionAuthenticationProblemSchema>
      | Schema.Schema.Type<typeof ActionVerificationUnavailableProblemSchema>;
    const actionApi = HttpApi.make('generatedActionIdentityFixture').add(
      HttpApiGroup.make('action').add(
        HttpApiEndpoint.post('invoke', '/actions/invoke', {
          error: [ActionAuthenticationProblemSchema, ActionVerificationUnavailableProblemSchema],
          success: TrustedPrincipalContextSchema,
        }),
      ),
    );
    const bearerChallenge = HttpEffect.appendPreResponseHandler((_request, response) =>
      Effect.succeed(HttpServerResponse.setHeader(response, 'www-authenticate', 'Bearer')),
    );
    let actionReached = false;
    let endpointEnvironment: GeneratedPrincipalEnvironment = environment;
    const actionGroupLive = HttpApiBuilder.group(actionApi, 'action', (handlers) =>
      handlers.handle('invoke', ({ request }) =>
        generated
          .verifyActionPrincipal(request.headers['authorization'], {
            currentTimeSeconds: Effect.succeed(1_700_000_001),
            environment: endpointEnvironment,
          })
          .pipe(
            Effect.tap(() => Effect.sync(() => (actionReached = true))),
            Effect.catch((error) => {
              switch (error._tag) {
                case 'ActionPrincipalExpiredError':
                case 'ActionPrincipalInvalidError':
                case 'ActionPrincipalMissingError':
                case 'ActionPrincipalScopeError': {
                  return bearerChallenge.pipe(
                    Effect.andThen(
                      Effect.fail<EndpointProblem>({
                        _tag: 'ActionAuthenticationProblem' as const,
                        detail: 'A valid Bearer assertion is required.',
                        status: 401 as const,
                        title: 'Action authentication required',
                        type: 'https://ontos.dev/problems/action-authentication-required',
                      }),
                    ),
                  );
                }
                case 'ActionPrincipalConfigurationError':
                case 'ActionPrincipalUnavailableError': {
                  return Effect.fail<EndpointProblem>({
                    _tag: 'ActionVerificationUnavailableProblem' as const,
                    detail: 'Action identity verification is temporarily unavailable.',
                    retryable: true as const,
                    status: 503 as const,
                    title: 'Action verification unavailable',
                    type: 'https://ontos.dev/problems/action-verification-unavailable',
                  });
                }
                default: {
                  return Effect.die(new Error(`Unexpected generated error ${error._tag}`));
                }
              }
            }),
          ),
      ),
    );
    const actionRuntime = defineEffectBff({
      api: actionApi,
      layer: HttpApiBuilder.layer(actionApi).pipe(Layer.provide(actionGroupLive)),
    });
    const actionHandler = actionRuntime.createHandler();
    try {
      const missingResponse = await actionHandler.handler(
        new Request('https://inventory.example.test/actions/invoke', { method: 'POST' }),
      );
      assert.equal(missingResponse.status, 401);
      assert.equal(missingResponse.headers.get('www-authenticate'), 'Bearer');
      assert.match(
        missingResponse.headers.get('content-type') ?? '',
        /application\/problem\+json/u,
      );
      assert.equal(actionReached, false);

      endpointEnvironment = {};
      const unavailableResponse = await actionHandler.handler(
        new Request('https://inventory.example.test/actions/invoke', {
          headers: { authorization: `Bearer ${currentAssertion.token}` },
          method: 'POST',
        }),
      );
      assert.equal(unavailableResponse.status, 503);
      assert.equal(
        Schema.decodeUnknownSync(RetryableProblemSchema)(await unavailableResponse.json())
          .retryable,
        true,
      );
      assert.equal(actionReached, false);

      endpointEnvironment = environment;
      const successResponse = await actionHandler.handler(
        new Request('https://inventory.example.test/actions/invoke', {
          headers: { authorization: `Bearer ${currentAssertion.token}` },
          method: 'POST',
        }),
      );
      assert.equal(successResponse.status, 200);
      assert.deepEqual(await successResponse.json(), principal);
      assert.equal(actionReached, true);
    } finally {
      await actionHandler.dispose();
    }
  });
});

test('generates one self-contained typed fail-closed Action and preserves package metadata', async () => {
  await withFixture(async (fixture) => {
    await run(fixture, 'action', ['--vertical', 'inventory-stock', '--action', 'create-order2']);
    const action = await readFixtureFile(
      fixture.root,
      'verticals/inventory-stock/src/actions/create-order2.action.ts',
    );
    assert.equal(
      action,
      `// @generated by OntOS Codesmith Action v1
// @ontos-action-owner inventory.stock
// @ontos-action-slug create-order2
import { Effect, Schema } from 'effect';
import { defineAction, defineTenantModuleEntrypoint } from '@app/core-runtime';

export const CreateOrder2PayloadSchema = Schema.Struct({});
export type CreateOrder2Payload = Schema.Schema.Type<typeof CreateOrder2PayloadSchema>;

export const CreateOrder2ResultSchema = Schema.Struct({});
export type CreateOrder2Result = Schema.Schema.Type<typeof CreateOrder2ResultSchema>;

export class CreateOrder2NotImplemented extends Schema.TaggedError<CreateOrder2NotImplemented>()(
  'CreateOrder2NotImplemented',
  {
    code: Schema.Literal('action_not_implemented'),
    reason: Schema.String,
  },
) {}

const handleCreateOrder2 = () =>
  Effect.fail(
    new CreateOrder2NotImplemented({
      code: 'action_not_implemented',
      reason: 'The Create Order2 Action is not implemented',
    }),
  );

export const createOrder2Action = defineAction(
  {
    accessEvidencePolicy: {
      captureMode: 'metadata_only',
      policyKey: 'inventory.stock.create-order2.access.v1',
    },
    actionKey: 'inventory.stock.create-order2',
    auditProfile: 'standard',
    domainErrorSchema: CreateOrder2NotImplemented,
    domainEvents: {},
    entrypoint: defineTenantModuleEntrypoint({
      access: 'write',
      entrypointKey: 'inventory.stock.create-order2',
      moduleKey: 'inventory.stock',
      role: 'action',
    }),
    idempotency: 'required',
    legalEntityScope: 'optional',
    owningModuleKey: 'inventory.stock',
    payloadSchema: CreateOrder2PayloadSchema,
    policies: [],
    resultSchema: CreateOrder2ResultSchema,
    schemaVersion: '1',
  },
  handleCreateOrder2,
);

// <generated-outbox-message-exports>
// </generated-outbox-message-exports>
`,
    );
    const packageJson = decodeFixturePackage(
      await readFixtureFile(fixture.root, 'verticals/inventory-stock/package.json'),
    );
    assert.deepEqual(packageJson.dependencies, {
      '@app/core-runtime': 'workspace:*',
      zeta: '1.0.0',
    });
    assert.equal(packageJson.scripts['existing'], 'preserve-me');
    const beforeRerun = await snapshotTree(fixture.root);
    await assert.rejects(
      run(fixture, 'action', ['--vertical', 'inventory-stock', '--action', 'create-order2']),
      /refusing to overwrite/u,
    );
    assert.deepEqual(await snapshotTree(fixture.root), beforeRerun);
  });
});

test('generates an owner-local Action service without overwriting business logic', async () => {
  await withFixture(async (fixture) => {
    await run(fixture, 'action-service', [
      '--vertical',
      'inventory-stock',
      '--service',
      'inventory-persistence',
    ]);
    const service = await readFixtureFile(
      fixture.root,
      'verticals/inventory-stock/src/services/inventory-persistence.service.ts',
    );
    assert.equal(
      service,
      `// @generated by OntOS Codesmith Action Service v1
import { Effect } from 'effect';

export const inventoryPersistenceService = () => Effect.succeed({});
`,
    );
    const beforeRerun = await snapshotTree(fixture.root);
    await assert.rejects(
      run(fixture, 'action-service', [
        '--vertical',
        'inventory-stock',
        '--service',
        'inventory-persistence',
      ]),
      /refusing to overwrite/u,
    );
    assert.deepEqual(await snapshotTree(fixture.root), beforeRerun);
  });
});

test('generates exactly one private owner-local external HTTP adapter', async () => {
  await withFixture(async (fixture) => {
    const before = await snapshotTree(fixture.root);
    const result = await run(fixture, 'external-http-adapter', [
      '--vertical',
      'contacts',
      '--provider',
      'ares',
      '--operation',
      'subject',
    ]);
    const adapterPath = path.join(
      fixture.root,
      'verticals/contacts/src/integrations/ares/ares-subject.service.ts',
    );
    assert.deepEqual(result, {
      kind: 'generated',
      result: { adapterPath },
    });
    const after = await snapshotTree(fixture.root);
    const changedPaths = new Set([
      ...Object.keys(before).filter((file) => before[file] !== after[file]),
      ...Object.keys(after).filter((file) => before[file] !== after[file]),
    ]);
    assert.deepEqual(
      [...changedPaths],
      ['verticals/contacts/src/integrations/ares/ares-subject.service.ts'],
    );
    assert.equal(
      after['verticals/contacts/src/integrations/ares/ares-subject.service.ts'],
      `// @generated by OntOS Codesmith External HTTP Adapter v1
import { Context, Effect, Layer, Schema } from 'effect';
import { HttpClient } from 'effect/unstable/http';

export class AresSubjectNotImplemented extends Schema.TaggedError<AresSubjectNotImplemented>()(
  'AresSubjectNotImplemented',
  {
    code: Schema.Literal('external_http_adapter_not_implemented'),
    reason: Schema.String,
  },
) {}

export interface AresSubjectServiceContract {
  readonly subject: () => Effect.Effect<never, AresSubjectNotImplemented>;
}

export class AresSubjectService extends Context.Service<
  AresSubjectService,
  AresSubjectServiceContract
>()('@app/contacts/integrations/ares/ares-subject/AresSubjectService') {}

const makeAresSubjectService = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  return {
    subject: () => {
      void httpClient;
      return Effect.fail(
        new AresSubjectNotImplemented({
          code: 'external_http_adapter_not_implemented',
          reason: 'The Ares Subject external HTTP adapter is not implemented',
        }),
      );
    },
  } satisfies AresSubjectServiceContract;
});

export const AresSubjectServiceLive = Layer.effect(AresSubjectService, makeAresSubjectService);
`,
    );
    const source = after['verticals/contacts/src/integrations/ares/ares-subject.service.ts'] ?? '';
    assert.match(source, /HttpClient\.HttpClient/u);
    assert.match(source, /Layer\.effect/u);
    assert.doesNotMatch(
      source,
      /fetch\(|httpClient\.(?:execute|get|head|post|patch|put|del|options)\(|https?:\/\//u,
    );

    const beforeOverwrite = await snapshotTree(fixture.root);
    await assert.rejects(
      run(fixture, 'external-http-adapter', [
        '--vertical',
        'contacts',
        '--provider',
        'ares',
        '--operation',
        'subject',
      ]),
      /refusing to overwrite/u,
    );
    assert.deepEqual(await snapshotTree(fixture.root), beforeOverwrite);
  });
});

test('rejects unsafe external HTTP adapter command input without writing', async () => {
  await withFixture(async (fixture) => {
    const before = await snapshotTree(fixture.root);
    const invalidCalls: readonly [readonly string[], RegExp][] = [
      [['--vertical', 'contacts', '--operation', 'subject'], /missing required flag --provider/u],
      [['--vertical', 'contacts', '--provider', 'ares'], /missing required flag --operation/u],
      [['--provider', 'ares', '--operation', 'subject'], /missing required flag --vertical/u],
      [
        [
          '--vertical',
          'contacts',
          '--provider',
          'ares',
          '--operation',
          'subject',
          '--unknown',
          'x',
        ],
        /unknown flag --unknown/u,
      ],
      [
        [
          '--vertical',
          'contacts',
          '--provider',
          'ares',
          '--provider',
          'other',
          '--operation',
          'subject',
        ],
        /only once/u,
      ],
      [
        ['--vertical', 'contacts', '--provider', 'Ares', '--operation', 'subject'],
        /provider must be canonical lower-kebab-case/u,
      ],
      [
        ['--vertical', 'contacts', '--provider', 'ares', '--operation', 'Subject'],
        /operation must be canonical lower-kebab-case/u,
      ],
      [
        ['--vertical', 'contacts', '--provider', 'src', '--operation', 'subject'],
        /provider must be canonical lower-kebab-case/u,
      ],
      [
        ['--vertical', 'contacts', '--provider', 'ares', '--operation', 'node_modules'],
        /operation must be canonical lower-kebab-case/u,
      ],
      [
        ['--vertical', 'contacts', '--provider', '../ares', '--operation', 'subject'],
        /provider must be canonical lower-kebab-case/u,
      ],
      [
        ['--vertical', 'contacts', '--provider', 'ares', '--operation', '../subject'],
        /operation must be canonical lower-kebab-case/u,
      ],
      [
        ['--vertical', 'missing', '--provider', 'ares', '--operation', 'subject'],
        /package metadata is missing/u,
      ],
    ];
    const assertInvalidCall = async (index = 0): Promise<void> => {
      const invalidCall = invalidCalls[index];
      if (invalidCall === undefined) {
        return;
      }
      const [arguments_, expected] = invalidCall;
      await assert.rejects(run(fixture, 'external-http-adapter', arguments_), expected);
      assert.deepEqual(await snapshotTree(fixture.root), before);
      await assertInvalidCall(index + 1);
    };
    await assertInvalidCall();
  });
});

test('external HTTP adapter planner rejects malformed OntOS ownership atomically', async () => {
  await withFixture(async (fixture) => {
    const manifestPath = path.join(fixture.root, 'verticals/contacts/vertical.manifest.ts');
    const manifest = await readFile(manifestPath, 'utf-8');
    await writeFile(
      manifestPath,
      manifest.replace(
        '// @generated by OntOS Codesmith Module Contract v1',
        '// developer-owned manifest',
      ),
      'utf-8',
    );
    const before = await snapshotTree(fixture.root);
    await assert.rejects(
      run(fixture, 'external-http-adapter', [
        '--vertical',
        'contacts',
        '--provider',
        'ares',
        '--operation',
        'subject',
      ]),
      /is not a generated module owner/u,
    );
    assert.deepEqual(await snapshotTree(fixture.root), before);
  });

  await withFixture(async (fixture) => {
    await writeFixtureFile(
      fixture.root,
      'verticals/contacts/src/integrations',
      'planner fixture blocks the required directory\n',
    );
    const before = await snapshotTree(fixture.root);
    await assert.rejects(
      run(fixture, 'external-http-adapter', [
        '--vertical',
        'contacts',
        '--provider',
        'ares',
        '--operation',
        'subject',
      ]),
      /ENOTDIR|not a directory/u,
    );
    assert.deepEqual(await snapshotTree(fixture.root), before);
  });
});

test('Action generation rejects unrelated imports in its governed owner slots', async () => {
  await withFixture(async (fixture) => {
    const manifestPath = path.join(fixture.root, 'verticals/inventory-stock/vertical.manifest.ts');
    const manifest = await readFile(manifestPath, 'utf-8');
    await writeFile(
      manifestPath,
      manifest.replace(
        '// <generated-module-manifest-imports>',
        `// <generated-module-manifest-imports>
import { fakeRead } from './src/api/fake.read.ts';`,
      ),
      'utf-8',
    );
    const before = await snapshotTree(fixture.root);
    await assert.rejects(
      run(fixture, 'action', ['--vertical', 'inventory-stock', '--action', 'create-order3']),
      /generated owner slot contains unsupported developer content/u,
    );
    assert.deepEqual(await snapshotTree(fixture.root), before);
  });
});

test('generates Core-owned Actions only through the Core owner slot with atomic preflight', async () => {
  await withFixture(async (fixture) => {
    await run(fixture, 'action', [
      '--scope',
      'core',
      '--module',
      'core.modules',
      '--action',
      'z-last-change',
    ]);
    await run(fixture, 'action', [
      '--scope',
      'core',
      '--module',
      'core.modules',
      '--action',
      'account-change',
    ]);

    const action = await readFixtureFile(
      fixture.root,
      'packages/core-runtime/src/modules/actions/account-change.action.ts',
    );
    assert.match(action, /@ontos-action-owner core\.modules/u);
    assert.match(action, /actionKey: 'core\.modules\.account-change'/u);
    assert.match(action, /entrypoint: defineSystemModuleEntrypoint\(\{/u);
    assert.match(action, /access: 'write'/u);
    assert.match(action, /role: 'action'/u);
    assert.match(action, /from '\.\.\/\.\.\/actions\/definition\.ts'/u);
    assert.doesNotMatch(action, /verticals|fetch\(/u);

    const coreIndex = await readFixtureFile(fixture.root, 'packages/core-runtime/src/index.ts');
    const accountExport =
      "export { accountChangeAction } from './modules/actions/account-change.action.ts';";
    const zExport =
      "export { zLastChangeAction } from './modules/actions/z-last-change.action.ts';";
    assert.ok(coreIndex.indexOf(accountExport) < coreIndex.indexOf(zExport));
    assert.match(coreIndex, /export const existingCoreSurface = true/u);

    const beforeOverwrite = await snapshotTree(fixture.root);
    await assert.rejects(
      run(fixture, 'action', [
        '--scope',
        'core',
        '--module',
        'core.modules',
        '--action',
        'account-change',
      ]),
      /refusing to overwrite/u,
    );
    assert.deepEqual(await snapshotTree(fixture.root), beforeOverwrite);
  });

  await withFixture(async (fixture) => {
    const indexPath = path.join(fixture.root, 'packages/core-runtime/src/index.ts');
    await writeFile(
      indexPath,
      `export const existingCoreSurface = true;\n\n// <generated-global-policy-exports>\n// </generated-global-policy-exports>\n`,
      'utf-8',
    );
    const before = await snapshotTree(fixture.root);
    await assert.rejects(
      run(fixture, 'action', [
        '--scope',
        'core',
        '--module',
        'core.modules',
        '--action',
        'create-order',
      ]),
      /generated owner file does not contain one valid/u,
    );
    assert.deepEqual(await snapshotTree(fixture.root), before);
  });

  await withFixture(async (fixture) => {
    const indexPath = path.join(fixture.root, 'packages/core-runtime/src/index.ts');
    const index = await readFile(indexPath, 'utf-8');
    await writeFile(
      indexPath,
      index.replace(
        '// <generated-core-action-exports>\n',
        '// <generated-core-action-exports>\nexport const developerOwned = true;\n',
      ),
      'utf-8',
    );
    const before = await snapshotTree(fixture.root);
    await assert.rejects(
      run(fixture, 'action', [
        '--scope',
        'core',
        '--module',
        'core.modules',
        '--action',
        'create-order',
      ]),
      /unsupported developer content/u,
    );
    assert.deepEqual(await snapshotTree(fixture.root), before);
  });
});

test('preflights the Action dependency patch before creating a file', async () => {
  await withFixture(async (fixture) => {
    const packagePath = path.join(fixture.root, 'verticals/inventory-stock/package.json');
    const packageJson = decodeFixturePackage(await readFile(packagePath, 'utf-8'));
    packageJson['dependencies'] = { '@app/core-runtime': '^1.0.0', zeta: '1.0.0' };
    await writeFile(packagePath, json(packageJson), 'utf-8');
    const before = await snapshotTree(fixture.root);
    await assert.rejects(
      run(fixture, 'action', ['--vertical', 'inventory-stock', '--action', 'create-order']),
      /incompatible/u,
    );
    assert.deepEqual(await snapshotTree(fixture.root), before);
  });
});

test('rejects Action generation when a vertical app identity is duplicated', async () => {
  await withFixture(async (fixture) => {
    const billingPackagePath = path.join(fixture.root, 'verticals/billing/package.json');
    const billingPackage = decodeFixturePackage(await readFile(billingPackagePath, 'utf-8'));
    billingPackage.modernjs['appId'] = inventoryVertical.appId;
    await writeFile(billingPackagePath, json(billingPackage), 'utf-8');
    const before = await snapshotTree(fixture.root);

    await assert.rejects(
      run(fixture, 'action', ['--vertical', 'inventory-stock', '--action', 'create-order']),
      /duplicate generated appId inventory-stock/u,
    );
    assert.deepEqual(await snapshotTree(fixture.root), before);
  });
});

test('rejects Action generation when the target identity is absent from topology', async () => {
  await withFixture(async (fixture) => {
    const packagePath = path.join(fixture.root, 'verticals/inventory-stock/package.json');
    const packageJson = decodeFixturePackage(await readFile(packagePath, 'utf-8'));
    packageJson.modernjs['appId'] = 'inventory-shadow';
    await writeFile(packagePath, json(packageJson), 'utf-8');
    const before = await snapshotTree(fixture.root);

    await assert.rejects(
      run(fixture, 'action', ['--vertical', 'inventory-stock', '--action', 'create-order']),
      /must have exactly one matching generated topology entry/u,
    );
    assert.deepEqual(await snapshotTree(fixture.root), before);
  });
});

test('preserves owner JSON document style while patching the Core dependency', async () => {
  await withFixture(async (fixture) => {
    const packagePath = path.join(fixture.root, 'verticals/inventory-stock/package.json');
    const packageJson = decodeFixturePackage(await readFile(packagePath, 'utf-8'));
    const styledPackage = JSON.stringify(packageJson, null, 4).replaceAll('\n', '\r\n');
    await writeFile(packagePath, styledPackage, 'utf-8');

    await run(fixture, 'action', ['--vertical', 'inventory-stock', '--action', 'create-order']);

    const patched = await readFile(packagePath, 'utf-8');
    assert.match(patched, /\r\n {4}"dependencies": \{\r\n/u);
    assert.match(patched, /\r\n {8}"existing": "preserve-me"/u);
    assert.doesNotMatch(patched, /(?<!\r)\n/u);
    assert.equal(patched.endsWith('\r\n'), false);
  });
});

test('generates Action-owned Outbox Messages and sorts only the owned export slot', async () => {
  await withFixture(async (fixture) => {
    await run(fixture, 'action', ['--vertical', 'inventory-stock', '--action', 'create-order']);
    const actionPath = path.join(
      fixture.root,
      'verticals/inventory-stock/src/actions/create-order.action.ts',
    );
    const generatedAction = await readFile(actionPath, 'utf-8');
    await writeFile(
      actionPath,
      `${generatedAction}\nexport const developerOwned = true;\n`,
      'utf-8',
    );
    await run(fixture, 'outbox-message', [
      '--vertical',
      'inventory-stock',
      '--action',
      'create-order',
      '--topic',
      'orders.shipped',
    ]);
    await run(fixture, 'outbox-message', [
      '--vertical',
      'inventory-stock',
      '--action',
      'create-order',
      '--topic',
      'orders.created',
    ]);
    const message = await readFixtureFile(
      fixture.root,
      'verticals/inventory-stock/src/actions/create-order.orders-created.outbox-message.ts',
    );
    assert.equal(
      message,
      `import type { OutboxMessage } from '@app/core-runtime';
import {
  OutboxPayloadSchema,
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/inventory-stock/outbox/orders-created';
import type { OutboxPayload } from '@app/inventory-stock/outbox/orders-created';

export const CreateOrderOrdersCreatedOutboxPayloadSchema = OutboxPayloadSchema;
export type CreateOrderOrdersCreatedOutboxPayload = OutboxPayload;
export const CreateOrderOrdersCreatedOutboxProducerModuleKey = outboxProducerModuleKey;
export const CreateOrderOrdersCreatedOutboxTopic = outboxTopic;

export const createCreateOrderOrdersCreatedOutboxMessage = (
  payload: OutboxPayload,
): OutboxMessage => ({
  payloadJson: payload,
  producerModuleKey: CreateOrderOrdersCreatedOutboxProducerModuleKey,
  topic: CreateOrderOrdersCreatedOutboxTopic,
});
`,
    );
    assert.equal(
      await readFixtureFile(
        fixture.root,
        'verticals/inventory-stock/shared/outbox/orders-created.ts',
      ),
      `// @generated by OntOS Codesmith Outbox Message Contract v1
// @ontos-outbox-producer inventory.stock
// @ontos-outbox-topic orders.created
import { Schema } from 'effect';

export const OutboxPayloadSchema = Schema.Struct({
  data: Schema.Json,
});
export type OutboxPayload = Schema.Schema.Type<typeof OutboxPayloadSchema>;

export const outboxTopic = 'orders.created' as const;
export const outboxProducerModuleKey = 'inventory.stock' as const;
`,
    );
    const producerPackage = decodeFixturePackage(
      await readFixtureFile(fixture.root, 'verticals/inventory-stock/package.json'),
    );
    assert.equal(
      producerPackage.exports['./outbox/orders-created'],
      './shared/outbox/orders-created.ts',
    );
    const action = await readFile(actionPath, 'utf-8');
    const createdExport =
      "export { CreateOrderOrdersCreatedOutboxPayloadSchema } from './create-order.orders-created.outbox-message.ts';";
    const shippedExport =
      "export { CreateOrderOrdersShippedOutboxPayloadSchema } from './create-order.orders-shipped.outbox-message.ts';";
    assert.ok(action.indexOf(createdExport) < action.indexOf(shippedExport));
    assert.match(action, /export const developerOwned = true;/u);
    assert.doesNotMatch(
      message,
      /addDomainEvent|addOutboxMessage|subjectResource|transport|worker/u,
    );

    await run(fixture, 'outbox-message', [
      '--vertical',
      'inventory-stock',
      '--action',
      'create-order',
      '--topic',
      'events.foo-1-bar',
    ]);
    const beforeIdentifierCollision = await snapshotTree(fixture.root);
    await assert.rejects(
      run(fixture, 'outbox-message', [
        '--vertical',
        'inventory-stock',
        '--action',
        'create-order',
        '--topic',
        'events.foo1-bar',
      ]),
      /Outbox identifier CreateOrderEventsFoo1BarOutbox already exists/u,
    );
    assert.deepEqual(await snapshotTree(fixture.root), beforeIdentifierCollision);
  });
});

test('rejects missing, handwritten, duplicate, and normalized-collision Outbox targets without partial writes', async () => {
  await withFixture(async (fixture) => {
    const beforeMissing = await snapshotTree(fixture.root);
    await assert.rejects(
      run(fixture, 'outbox-message', [
        '--vertical',
        'inventory-stock',
        '--action',
        'missing-action',
        '--topic',
        'orders.created',
      ]),
      /requires the generated Action/u,
    );
    assert.deepEqual(await snapshotTree(fixture.root), beforeMissing);

    await writeFixtureFile(
      fixture.root,
      'verticals/inventory-stock/src/actions/handwritten.action.ts',
      `// <generated-outbox-message-exports>\n// </generated-outbox-message-exports>\n`,
    );
    const beforeHandwritten = await snapshotTree(fixture.root);
    await assert.rejects(
      run(fixture, 'outbox-message', [
        '--vertical',
        'inventory-stock',
        '--action',
        'handwritten',
        '--topic',
        'orders.created',
      ]),
      /only the matching generated Action/u,
    );
    assert.deepEqual(await snapshotTree(fixture.root), beforeHandwritten);

    await run(fixture, 'action', ['--vertical', 'inventory-stock', '--action', 'create-order']);
    const governedActionPath = 'verticals/inventory-stock/src/actions/create-order.action.ts';
    const governedAction = await readFixtureFile(fixture.root, governedActionPath);
    await writeFixtureFile(
      fixture.root,
      governedActionPath,
      governedAction.replace("      access: 'write',", "      access: 'read',"),
    );
    const beforeMismatchedEntrypoint = await snapshotTree(fixture.root);
    await assert.rejects(
      run(fixture, 'outbox-message', [
        '--vertical',
        'inventory-stock',
        '--action',
        'create-order',
        '--topic',
        'orders.created',
      ]),
      /matching generated Action with its governed write entrypoint/u,
    );
    assert.deepEqual(await snapshotTree(fixture.root), beforeMismatchedEntrypoint);
    await writeFixtureFile(fixture.root, governedActionPath, governedAction);
    await run(fixture, 'outbox-message', [
      '--vertical',
      'inventory-stock',
      '--action',
      'create-order',
      '--topic',
      'orders.created-v2',
    ]);
    const beforeCollision = await snapshotTree(fixture.root);
    await Promise.all(
      ['orders.created-v2', 'orders-created.v2'].map(async (topic) => {
        await assert.rejects(
          run(fixture, 'outbox-message', [
            '--vertical',
            'inventory-stock',
            '--action',
            'create-order',
            '--topic',
            topic,
          ]),
          /already exists/u,
        );
        assert.deepEqual(await snapshotTree(fixture.root), beforeCollision);
      }),
    );
  });
});

test('generates isolated Outbox Workers from published contracts and composes a stable registry', async () => {
  await withFixture(async (fixture) => {
    await run(fixture, 'action', ['--vertical', 'inventory-stock', '--action', 'create-order']);
    await run(fixture, 'outbox-message', [
      '--vertical',
      'inventory-stock',
      '--action',
      'create-order',
      '--topic',
      'orders.created',
    ]);
    const producerBefore = Object.fromEntries(
      Object.entries(await snapshotTree(fixture.root)).filter(([file]) =>
        file.startsWith('verticals/inventory-stock/'),
      ),
    );

    await run(fixture, 'outbox-worker', [
      '--vertical',
      'billing',
      '--worker',
      'orders-created-logger',
      '--producer',
      'inventory-stock',
      '--topic',
      'orders.created',
    ]);
    const worker = await readFixtureFile(
      fixture.root,
      'verticals/billing/src/workers/orders-created-logger.worker.ts',
    );
    assert.equal(
      worker,
      `// @generated by OntOS Codesmith Outbox Worker v1
// @ontos-outbox-worker-key billing.core.orders-created-logger
// @ontos-outbox-worker-owner billing.core
// @ontos-outbox-worker-producer inventory.stock
// @ontos-outbox-worker-topic orders.created
import { Effect, Schema } from 'effect';
import { defineOutboxWorker, defineTenantModuleEntrypoint } from '@app/core-runtime';
import {
  OutboxPayloadSchema,
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/inventory-stock/outbox/orders-created';

export class OrdersCreatedLoggerNotImplemented extends Schema.TaggedError<OrdersCreatedLoggerNotImplemented>()(
  'OrdersCreatedLoggerNotImplemented',
  {
    code: Schema.Literal('outbox_worker_not_implemented'),
    reason: Schema.String,
  },
) {}

const handleOrdersCreatedLogger = () =>
  Effect.fail(
    new OrdersCreatedLoggerNotImplemented({
      code: 'outbox_worker_not_implemented',
      reason: 'The OrdersCreatedLogger Outbox Worker is not implemented',
    }),
  );

export const ordersCreatedLoggerWorker = defineOutboxWorker(
  {
    consumerModuleKey: 'billing.core',
    entrypoint: defineTenantModuleEntrypoint({
      access: 'background',
      entrypointKey: 'billing.core.orders-created-logger',
      moduleKey: 'billing.core',
      role: 'worker',
    }),
    leaseDurationMs: 30_000,
    payloadSchema: OutboxPayloadSchema,
    producerModuleKey: outboxProducerModuleKey,
    retryPolicy: {
      initialBackoffMs: 1000,
      maxAttempts: 5,
      maxBackoffMs: 60_000,
      multiplier: 2,
    },
    topic: outboxTopic,
    workerKey: 'billing.core.orders-created-logger',
  },
  handleOrdersCreatedLogger,
);
`,
    );
    assert.equal(
      await readFixtureFile(fixture.root, 'verticals/billing/src/workers/index.ts'),
      `import type { AnyOutboxWorkerRegistration } from '@app/core-runtime';

// <generated-outbox-worker-imports>
import { ordersCreatedLoggerWorker } from './orders-created-logger.worker.ts';
// </generated-outbox-worker-imports>

export const outboxWorkers = Object.freeze([
  // <generated-outbox-worker-registrations>
  ordersCreatedLoggerWorker,
  // </generated-outbox-worker-registrations>
]) satisfies readonly AnyOutboxWorkerRegistration[];
`,
    );
    assert.equal(
      await readFixtureFile(fixture.root, 'verticals/billing/src/worker-host/layer.ts'),
      `// @generated by scaffold:outbox-worker worker-host
// @ontos-outbox-worker-host-owner billing.core
import { Layer } from 'effect';
import { OutboxWorkerInfrastructureLive } from '@app/core-runtime';

/** Add owner-local repositories and services required by worker handlers here. */
const outboxWorkerHandlerLayer = Layer.empty;

export const outboxWorkerLayer = Layer.merge(
  OutboxWorkerInfrastructureLive,
  outboxWorkerHandlerLayer,
);
`,
    );
    assert.equal(
      await readFixtureFile(fixture.root, 'verticals/billing/src/worker-host/main.ts'),
      `// @generated by scaffold:outbox-worker worker-host
// @ontos-outbox-worker-host-owner billing.core
import { extractOutboxWorkerSubscriptions, startOutboxWorkerProcess } from '@app/core-runtime';
import { outboxWorkerLayer } from './layer.ts';
import { outboxWorkers } from '../workers/index.ts';

const outboxSubscriptions = extractOutboxWorkerSubscriptions(outboxWorkers);

startOutboxWorkerProcess({
  claimOwnerPrefix: 'billing.core-outbox-worker',
  health: true,
  layer: outboxWorkerLayer,
  registrations: outboxWorkers,
  subscriptions: outboxSubscriptions,
});
`,
    );
    const consumerPackage = decodeFixturePackage(
      await readFixtureFile(fixture.root, 'verticals/billing/package.json'),
    );
    assert.equal(consumerPackage.dependencies['@app/core-runtime'], 'workspace:*');
    assert.equal(consumerPackage.dependencies['@app/inventory-stock'], 'workspace:*');
    assert.equal(consumerPackage.exports['./workers'], undefined);
    assert.equal(
      consumerPackage.scripts['dev:worker'],
      'node --experimental-strip-types ./src/worker-host/main.ts',
    );
    assert.equal(
      consumerPackage.scripts['worker:start'],
      'node --experimental-strip-types ./src/worker-host/main.ts',
    );
    const consumerTsconfig = Schema.decodeUnknownSync(FixtureTsconfigSchema)(
      JSON.parse(await readFixtureFile(fixture.root, 'verticals/billing/tsconfig.json')),
    );
    assert.deepEqual(consumerTsconfig.references, [{ path: '../inventory-stock' }]);
    const producerAfter = Object.fromEntries(
      Object.entries(await snapshotTree(fixture.root)).filter(([file]) =>
        file.startsWith('verticals/inventory-stock/'),
      ),
    );
    assert.deepEqual(producerAfter, producerBefore);

    await run(fixture, 'outbox-message', [
      '--vertical',
      'inventory-stock',
      '--action',
      'create-order',
      '--topic',
      'orders.shipped',
    ]);
    await run(fixture, 'outbox-worker', [
      '--vertical',
      'billing',
      '--worker',
      'orders-shipped-projector',
      '--producer',
      'inventory-stock',
      '--topic',
      'orders.shipped',
    ]);
    const registry = await readFixtureFile(fixture.root, 'verticals/billing/src/workers/index.ts');
    assert.ok(
      registry.indexOf('ordersCreatedLoggerWorker') <
        registry.indexOf('ordersShippedProjectorWorker'),
    );
    const beforeRerun = await snapshotTree(fixture.root);
    await assert.rejects(
      run(fixture, 'outbox-worker', [
        '--vertical',
        'billing',
        '--worker',
        'orders-created-logger',
        '--producer',
        'inventory-stock',
        '--topic',
        'orders.created',
      ]),
      /refusing to overwrite/u,
    );
    assert.deepEqual(await snapshotTree(fixture.root), beforeRerun);
  });
});

test('generates self-consuming Outbox Workers without circular project or package dependencies', async () => {
  await withFixture(async (fixture) => {
    await run(fixture, 'action', ['--vertical', 'inventory-stock', '--action', 'create-order']);
    await run(fixture, 'outbox-message', [
      '--vertical',
      'inventory-stock',
      '--action',
      'create-order',
      '--topic',
      'orders.created',
    ]);
    const manifestBefore = await readFixtureFile(
      fixture.root,
      'verticals/inventory-stock/vertical.manifest.ts',
    );
    const tsconfigBefore = await readFixtureFile(
      fixture.root,
      'verticals/inventory-stock/tsconfig.json',
    );
    const args = [
      '--vertical',
      'inventory-stock',
      '--worker',
      'orders-created-projector',
      '--producer',
      'inventory-stock',
      '--topic',
      'orders.created',
    ];
    await run(fixture, 'outbox-worker', args);
    const worker = await readFixtureFile(
      fixture.root,
      'verticals/inventory-stock/src/workers/orders-created-projector.worker.ts',
    );
    assert.ok(worker.includes('// @ontos-outbox-worker-owner inventory.stock'));
    assert.ok(worker.includes('// @ontos-outbox-worker-producer inventory.stock'));
    assert.ok(worker.includes("from '@app/inventory-stock/outbox/orders-created'"));
    const registry = await readFixtureFile(
      fixture.root,
      'verticals/inventory-stock/src/workers/index.ts',
    );
    const hostLayer = await readFixtureFile(
      fixture.root,
      'verticals/inventory-stock/src/worker-host/layer.ts',
    );
    const hostMain = await readFixtureFile(
      fixture.root,
      'verticals/inventory-stock/src/worker-host/main.ts',
    );
    assert.ok(registry.includes('ordersCreatedProjectorWorker,'));
    assert.ok(hostLayer.includes('OutboxWorkerInfrastructureLive'));
    assert.ok(hostMain.includes('startOutboxWorkerProcess({'));
    const registration = await readFixtureFile(
      fixture.root,
      'verticals/inventory-stock/vertical.registration.ts',
    );
    assert.ok(registration.includes('createOrderAction,'));
    assert.ok(registration.includes('ordersCreatedProjectorWorker,'));
    assert.equal(
      await readFixtureFile(fixture.root, 'verticals/inventory-stock/vertical.manifest.ts'),
      manifestBefore,
    );
    assert.equal(
      await readFixtureFile(fixture.root, 'verticals/inventory-stock/tsconfig.json'),
      tsconfigBefore,
    );
    const ownerPackage = decodeFixturePackage(
      await readFixtureFile(fixture.root, 'verticals/inventory-stock/package.json'),
    );
    assert.equal(ownerPackage.dependencies['@app/core-runtime'], 'workspace:*');
    assert.equal(ownerPackage.dependencies['@app/inventory-stock'], undefined);
    assert.equal(
      ownerPackage.exports['./outbox/orders-created'],
      './shared/outbox/orders-created.ts',
    );
    for (const script of ['dev:worker', 'worker:start']) {
      assert.equal(
        ownerPackage.scripts[script],
        'node --experimental-strip-types ./src/worker-host/main.ts',
      );
    }
    const beforeRerun = await snapshotTree(fixture.root);
    await assert.rejects(run(fixture, 'outbox-worker', args), /refusing to overwrite/u);
    assert.deepEqual(await snapshotTree(fixture.root), beforeRerun);
    await run(fixture, 'action', ['--vertical', 'inventory-stock', '--action', 'request-rebuild']);
    const registrationAfterAction = await readFixtureFile(
      fixture.root,
      'verticals/inventory-stock/vertical.registration.ts',
    );
    assert.ok(registrationAfterAction.includes('requestRebuildAction,'));
    assert.ok(registrationAfterAction.includes('ordersCreatedProjectorWorker,'));
    await writeFixtureFile(
      fixture.root,
      'verticals/inventory-stock/tsconfig.json',
      JSON.stringify({ references: [{ path: '../inventory-stock' }] }),
    );
    const beforeCircularReference = await snapshotTree(fixture.root);
    await assert.rejects(
      run(fixture, 'outbox-worker', [
        '--vertical',
        'inventory-stock',
        '--worker',
        'orders-created-audit',
        '--producer',
        'inventory-stock',
        '--topic',
        'orders.created',
      ]),
      /circular self project reference/u,
    );
    assert.deepEqual(await snapshotTree(fixture.root), beforeCircularReference);
  });
});

test('refuses unpublished or malformed Outbox contracts without partial consumer writes', async () => {
  await withFixture(async (fixture) => {
    const beforeUnpublished = await snapshotTree(fixture.root);
    await assert.rejects(
      run(fixture, 'outbox-worker', [
        '--vertical',
        'billing',
        '--worker',
        'orders-logger',
        '--producer',
        'inventory-stock',
        '--topic',
        'orders.missing',
      ]),
      /published producer Outbox contract is missing/u,
    );
    assert.deepEqual(await snapshotTree(fixture.root), beforeUnpublished);

    await run(fixture, 'action', ['--vertical', 'inventory-stock', '--action', 'create-order']);
    await run(fixture, 'outbox-message', [
      '--vertical',
      'inventory-stock',
      '--action',
      'create-order',
      '--topic',
      'orders.created',
    ]);
    const contractPath = path.join(
      fixture.root,
      'verticals/inventory-stock/shared/outbox/orders-created.ts',
    );
    const validContract = await readFile(contractPath, 'utf-8');
    await writeFile(
      contractPath,
      validContract.replace(
        '// @ontos-outbox-producer inventory.stock',
        '// @ontos-outbox-producer billing',
      ),
      'utf-8',
    );
    const beforeMalformed = await snapshotTree(fixture.root);
    await assert.rejects(
      run(fixture, 'outbox-worker', [
        '--vertical',
        'billing',
        '--worker',
        'orders-logger',
        '--producer',
        'inventory-stock',
        '--topic',
        'orders.created',
      ]),
      /owner\/topic\/schema mismatch/u,
    );
    assert.deepEqual(await snapshotTree(fixture.root), beforeMalformed);
  });
});

test('generates fail-closed global and owner-local Policies with narrow exports', async () => {
  await withFixture(async (fixture) => {
    await run(fixture, 'policy', ['--scope', 'global', '--policy', 'tenant-active']);
    await run(fixture, 'policy', ['--scope', 'global', '--policy', 'account-open']);
    await run(fixture, 'policy', [
      '--scope',
      'microvertical',
      '--policy',
      'stock-available',
      '--vertical',
      'inventory-stock',
    ]);

    assert.equal(
      await readFixtureFile(
        fixture.root,
        'packages/core-runtime/src/policies/tenant-active.policy.ts',
      ),
      `import { Effect } from 'effect';
import { defineGlobalPolicy, denyPolicy } from '../actions/policy.ts';

export const tenantActivePolicy = defineGlobalPolicy<unknown>({
  evaluate: () =>
    Effect.fail(
      denyPolicy('policy_not_implemented', 'The Tenant Active Policy is not implemented'),
    ),
  policyKey: 'global.tenant-active.v1',
});
`,
    );
    assert.equal(
      await readFixtureFile(
        fixture.root,
        'verticals/inventory-stock/src/policies/stock-available.policy.ts',
      ),
      `import { Effect } from 'effect';
import { defineMicroverticalPolicy, denyPolicy } from '@app/core-runtime';

export const stockAvailablePolicy = defineMicroverticalPolicy<unknown, 'inventory.stock'>({
  evaluate: () =>
    Effect.fail(
      denyPolicy('policy_not_implemented', 'The Stock Available Policy is not implemented'),
    ),
  owningModuleKey: 'inventory.stock',
  policyKey: 'inventory.stock.stock-available.v1',
});
`,
    );
    const coreIndex = await readFixtureFile(fixture.root, 'packages/core-runtime/src/index.ts');
    assert.equal(
      coreIndex,
      `export const existingCoreSurface = true;

// <generated-core-action-exports>
// </generated-core-action-exports>

// <generated-global-policy-exports>
export { accountOpenPolicy } from './policies/account-open.policy.ts';
export { tenantActivePolicy } from './policies/tenant-active.policy.ts';
// </generated-global-policy-exports>
`,
    );
    assert.doesNotMatch(coreIndex, /stockAvailablePolicy/u);
    assert.equal(
      decodeFixturePackage(
        await readFixtureFile(fixture.root, 'verticals/inventory-stock/package.json'),
      ).dependencies['@app/core-runtime'],
      'workspace:*',
    );
    const beforeDuplicate = await snapshotTree(fixture.root);
    await assert.rejects(
      run(fixture, 'policy', ['--scope', 'global', '--policy', 'tenant-active']),
      /refusing to overwrite/u,
    );
    assert.deepEqual(await snapshotTree(fixture.root), beforeDuplicate);

    await run(fixture, 'policy', ['--scope', 'global', '--policy', 'foo-1-bar']);
    const beforeIdentifierCollision = await snapshotTree(fixture.root);
    await assert.rejects(
      run(fixture, 'policy', ['--scope', 'global', '--policy', 'foo1-bar']),
      /Policy identifier foo1BarPolicy already exists/u,
    );
    assert.deepEqual(await snapshotTree(fixture.root), beforeIdentifierCollision);
  });
});

test('generates a title-only authenticated page at the default MicroVertical URL', async () => {
  await withFixture(async (fixture) => {
    const shellBefore = await readFixtureFile(fixture.root, 'apps/shell-super-app/src/sentinel.ts');
    const englishLocalePath = path.join(
      fixture.root,
      'verticals/inventory-stock/locales/en/inventory.json',
    );
    await writeFile(
      englishLocalePath,
      '{\r\n    "inventory": {"existing":"en-preserved"}\r\n}',
      'utf-8',
    );
    const refreshes: string[] = [];
    await run(
      fixture,
      'microvertical-page',
      ['--vertical', 'inventory-stock', '--page', 'purchase-orders'],
      (appId) => refreshes.push(appId),
    );
    assert.deepEqual(refreshes, ['inventory-stock', 'shell-super-app']);
    const page = await readFixtureFile(
      fixture.root,
      'verticals/inventory-stock/src/routes/[lang]/inventory-stock/purchase-orders/page.tsx',
    );
    assert.equal(
      page,
      `import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { UltramodernRouteHead } from '../../../ultramodern-route-head';

export const PurchaseOrdersPage = () => {
  const { t } = useModernI18n();
  const headingId = 'purchase-orders-heading';

  return (
    <>
      <UltramodernRouteHead />
      <section
        aria-labelledby={headingId}
        className="inventory:mx-auto inventory:w-full inventory:max-w-5xl inventory:px-4 inventory:py-8 inventory:sm:px-8 inventory:lg:px-12"
      >
        <h1
          className="inventory:text-3xl inventory:font-bold inventory:text-(--color-page-fg) inventory:sm:text-4xl"
          id={headingId}
        >
          {t('inventory.pages.purchaseOrders.title')}
        </h1>
      </section>
    </>
  );
};

export default PurchaseOrdersPage;
`,
    );
    const manifest = await readFixtureFile(
      fixture.root,
      'verticals/inventory-stock/vertical.manifest.ts',
    );
    const registration = await readFixtureFile(
      fixture.root,
      'verticals/inventory-stock/vertical.registration.ts',
    );
    const federation = await readFixtureFile(
      fixture.root,
      'verticals/inventory-stock/module-federation.config.ts',
    );
    const federatedPage = await readFixtureFile(
      fixture.root,
      'verticals/inventory-stock/src/federation/page-purchase-orders.tsx',
    );
    const shellClients = await readFixtureFile(
      fixture.root,
      'apps/shell-super-app/src/api/vertical-clients.ts',
    );
    assert.match(manifest, /inventory\.stock\.navigation\.purchase-orders/u);
    assert.match(manifest, /inventory\.stock\.page\.purchase-orders/u);
    assert.match(manifest, /routePath: '\/inventory-stock\/purchase-orders'/u);
    assert.match(registration, /page-purchase-orders/u);
    assert.match(
      federation,
      /'\.\/PagePurchaseOrders': '\.\/src\/federation\/page-purchase-orders\.tsx'/u,
    );
    assert.match(federatedPage, /<FederatedI18nBoundary/u);
    assert.match(federatedPage, /resources=\{inventoryStockI18nResources\}/u);
    assert.match(
      shellClients,
      /appId: 'inventory-stock', componentKey: 'inventory\.stock\.page-purchase-orders', load: \(\) => import\('inventoryStock\/PagePurchaseOrders'\)/u,
    );
    assert.equal(
      await readFixtureFile(
        fixture.root,
        'apps/shell-super-app/src/routes/[lang]/inventory-stock/purchase-orders/page.tsx',
      ),
      `export { default } from '../../modules/[moduleId]/page.tsx';
`,
    );
    assert.match(
      await readFixtureFile(
        fixture.root,
        'apps/shell-super-app/src/routes/[lang]/inventory-stock/purchase-orders/page.data.ts',
      ),
      /entrypointKey: 'inventory\.stock\.page\.purchase-orders'/u,
    );
    assert.match(
      await readFixtureFile(
        fixture.root,
        'apps/shell-super-app/src/routes/[lang]/inventory-stock/purchase-orders/route.meta.ts',
      ),
      /canonicalPath: '\/inventory-stock\/purchase-orders'/u,
    );
    assert.equal(
      await readFixtureFile(
        fixture.root,
        'verticals/inventory-stock/src/routes/[lang]/inventory-stock/purchase-orders/route.meta.ts',
      ),
      `import { defineTenantModuleEntrypoint } from '@app/core-runtime';

const routeMeta = {
  canonicalPath: '/inventory-stock/purchase-orders',
  descriptionKey: 'inventory.pages.purchaseOrders.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    entrypointKey: 'inventory.stock.page.purchase-orders',
    moduleKey: 'inventory.stock',
    role: 'page',
  }),
  id: 'inventory-stock-purchase-orders',
  indexable: false,
  localisedPaths: {
    cs: '/inventory-stock/purchase-orders',
    en: '/inventory-stock/purchase-orders',
  },
  mfBoundaryId: 'verticalInventoryStock',
  moduleId: 'inventory.stock',
  namespace: 'inventory',
  ownerAppId: 'inventory-stock',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'inventory.pages.purchaseOrders.title',
} as const;

export default routeMeta;
export { routeMeta };
`,
    );
    const englishContent = await readFile(englishLocalePath, 'utf-8');
    const english = decodeInventoryLocale(englishContent);
    const czech = decodeInventoryLocale(
      await readFixtureFile(fixture.root, 'verticals/inventory-stock/locales/cs/inventory.json'),
    );
    assert.equal(english.inventory.existing, 'en-preserved');
    assert.match(englishContent, /"inventory": \{"existing":"en-preserved", "pages":/u);
    assert.doesNotMatch(englishContent, /(?<!\r)\n/u);
    assert.equal(englishContent.endsWith('\r\n'), false);
    assert.deepEqual(english.inventory.pages['purchaseOrders'], {
      description: 'This page is ready for implementation.',
      title: 'New Page',
    });
    assert.deepEqual(czech.inventory.pages['purchaseOrders'], {
      description: 'Tato stránka je připravena k implementaci.',
      title: 'Nová stránka',
    });
    assert.equal(
      await readFixtureFile(fixture.root, 'apps/shell-super-app/src/sentinel.ts'),
      shellBefore,
    );
    assert.doesNotMatch(page, /fetch\(|useState|useEffect|<style|\.css'|\.description|\.empty/u);
  });
});

test('allows a two-letter MicroVertical slug in a derived default page URL', async () => {
  await withFixture(async (fixture) => {
    await run(fixture, 'microvertical-page', ['--vertical', 'hr', '--page', 'people']);
    await stat(path.join(fixture.root, 'verticals/hr/src/routes/[lang]/hr/people/page.tsx'));
    assert.match(
      await readFixtureFile(fixture.root, 'verticals/hr/vertical.manifest.ts'),
      /routePath: '\/hr\/people'/u,
    );
  });
});

test('renders a newly generated federated page with English and Czech owner resources', async () => {
  await withFixture(async (fixture) => {
    await run(fixture, 'microvertical-page', [
      '--vertical',
      'inventory-stock',
      '--page',
      'customers',
    ]);
    await mkdir(path.join(fixture.root, 'node_modules', '@modern-js'), { recursive: true });
    await Promise.all(
      ['react', 'react-dom'].map((packageName) =>
        symlink(
          path.join(appRoot, 'apps', 'shell-super-app', 'node_modules', packageName),
          path.join(fixture.root, 'node_modules', packageName),
          'dir',
        ),
      ),
    );
    await writeFixtureFile(
      fixture.root,
      'node_modules/@modern-js/plugin-i18n/package.json',
      json({
        exports: { './runtime': './runtime.tsx' },
        name: '@modern-js/plugin-i18n',
        type: 'module',
      }),
    );
    await writeFixtureFile(
      fixture.root,
      'node_modules/@modern-js/plugin-i18n/runtime.tsx',
      `import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';

interface BoundaryValue {
  readonly defaultNamespace: string;
  readonly resources: Readonly<Record<string, Readonly<Record<string, Readonly<Record<string, string>>>>>>;
}

const BoundaryContext = createContext<BoundaryValue>({ defaultNamespace: '', resources: {} });

export const FederatedI18nBoundary = ({
  children,
  defaultNamespace,
  resources,
}: BoundaryValue & { readonly children: ReactNode }) => (
  <BoundaryContext.Provider value={{ defaultNamespace, resources }}>
    {children}
  </BoundaryContext.Provider>
);

export const useModernI18n = () => {
  const boundary = useContext(BoundaryContext);
  return {
    t: (key: string) =>
      boundary.resources[process.env['PAGE_LANGUAGE'] ?? 'en']?.[boundary.defaultNamespace]?.[key] ??
      key,
  };
};
`,
    );
    const runnerPath = path.join(fixture.root, 'render-generated-page.tsx');
    await writeFile(
      runnerPath,
      `import { renderToStaticMarkup } from 'react-dom/server';
import Page from './verticals/inventory-stock/src/federation/page-customers.tsx';

process.stdout.write(renderToStaticMarkup(<Page />));
`,
      'utf-8',
    );
    const bundlePath = path.join(fixture.root, 'render-generated-page.cjs');
    const bundle = spawnSync(
      esbuildPath,
      [
        runnerPath,
        '--bundle',
        '--format=cjs',
        '--jsx=automatic',
        '--platform=node',
        `--outfile=${bundlePath}`,
      ],
      { cwd: fixture.root, encoding: 'utf-8' },
    );
    assert.equal(bundle.status, 0, bundle.stderr || bundle.error?.message);
    const renderLanguage = (language: 'cs' | 'en') =>
      spawnSync(process.execPath, [bundlePath], {
        cwd: fixture.root,
        encoding: 'utf-8',
        env: { ...process.env, PAGE_LANGUAGE: language },
      });
    const english = renderLanguage('en');
    const czech = renderLanguage('cs');
    assert.equal(english.status, 0, english.stderr);
    assert.equal(czech.status, 0, czech.stderr);
    assert.match(english.stdout, />New Page<\/h1>/u);
    assert.match(czech.stdout, />Nová stránka<\/h1>/u);
  });
});

test('adds further pages after generated owner files have been formatted', async () => {
  await withFixture(async (fixture) => {
    const formattedOwnerPaths = [
      'verticals/inventory-stock/vertical.manifest.ts',
      'verticals/inventory-stock/vertical.registration.ts',
      'apps/shell-super-app/src/api/vertical-clients.ts',
    ] as const;
    const formatOwners = async (): Promise<void> => {
      await Promise.all(
        formattedOwnerPaths.map(async (relativePath) => {
          const filePath = path.join(fixture.root, relativePath);
          const formatted = spawnSync(oxfmtPath, [`--stdin-filepath=${relativePath}`], {
            cwd: appRoot,
            encoding: 'utf-8',
            input: await readFile(filePath, 'utf-8'),
          });
          assert.equal(formatted.status, 0, formatted.stderr);
          await writeFile(filePath, formatted.stdout, 'utf-8');
        }),
      );
    };

    await run(fixture, 'microvertical-page', [
      '--vertical',
      'inventory-stock',
      '--page',
      'purchase-orders',
    ]);
    await formatOwners();

    await run(fixture, 'microvertical-page', [
      '--vertical',
      'inventory-stock',
      '--page',
      'customers',
    ]);
    await formatOwners();

    await run(fixture, 'microvertical-page', [
      '--vertical',
      'inventory-stock',
      '--page',
      'customer-notes',
    ]);

    const manifest = await readFixtureFile(
      fixture.root,
      'verticals/inventory-stock/vertical.manifest.ts',
    );
    const registration = await readFixtureFile(
      fixture.root,
      'verticals/inventory-stock/vertical.registration.ts',
    );
    const shellClients = await readFixtureFile(
      fixture.root,
      'apps/shell-super-app/src/api/vertical-clients.ts',
    );
    await Promise.all(
      ['customer-notes', 'customers', 'purchase-orders'].map(async (page) => {
        assert.match(manifest, new RegExp(`inventory\\.stock\\.page\\.${page}`, 'u'));
        assert.match(registration, new RegExp(`'page-${page}'`, 'u'));
        assert.match(shellClients, new RegExp(`inventory\\.stock\\.page-${page}`, 'u'));
        await stat(
          path.join(
            fixture.root,
            `verticals/inventory-stock/src/routes/[lang]/inventory-stock/${page}/page.tsx`,
          ),
        );
      }),
    );
  });
});

test('supports an explicit nested page URL and rejects unsafe URL inputs atomically', async () => {
  await withFixture(async (fixture) => {
    await run(fixture, 'microvertical-page', [
      '--vertical',
      'inventory-stock',
      '--page',
      'purchase-orders',
      '--url',
      '/purchasing/orders',
    ]);
    const page = await readFixtureFile(
      fixture.root,
      'verticals/inventory-stock/src/routes/[lang]/purchasing/orders/page.tsx',
    );
    assert.match(page, /from '\.\.\/\.\.\/\.\.\/ultramodern-route-head'/u);
    const manifest = await readFixtureFile(
      fixture.root,
      'verticals/inventory-stock/vertical.manifest.ts',
    );
    assert.match(manifest, /routePath: '\/purchasing\/orders'/u);
    assert.match(
      await readFixtureFile(
        fixture.root,
        'apps/shell-super-app/src/routes/[lang]/purchasing/orders/page.data.ts',
      ),
      /entrypointKey: 'inventory\.stock\.page\.purchase-orders'/u,
    );
    const beforeRerun = await snapshotTree(fixture.root);
    await run(fixture, 'microvertical-page', [
      '--vertical',
      'inventory-stock',
      '--page',
      'purchase-orders',
      '--url',
      '/purchasing/orders',
    ]);
    assert.deepEqual(await snapshotTree(fixture.root), beforeRerun);
    await assert.rejects(
      run(fixture, 'microvertical-page', [
        '--vertical',
        'inventory-stock',
        '--page',
        'purchase-orders',
        '--url',
        '/different/orders',
      ]),
      /already exists at another URL/u,
    );
    await assert.rejects(
      run(fixture, 'microvertical-page', [
        '--vertical',
        'inventory-stock',
        '--page',
        'different-page',
        '--url',
        '/purchasing/orders',
      ]),
      /already exists|collides/u,
    );
    assert.deepEqual(await snapshotTree(fixture.root), beforeRerun);
  });

  await withFixture(async (fixture) => {
    await run(fixture, 'microvertical-page', [
      '--vertical',
      'inventory-stock',
      '--page',
      'orders',
      '--url',
      '/orders',
    ]);
    await stat(
      path.join(fixture.root, 'verticals/inventory-stock/src/routes/[lang]/orders/page.tsx'),
    );
    assert.match(
      await readFixtureFile(fixture.root, 'verticals/inventory-stock/vertical.manifest.ts'),
      /routePath: '\/orders'/u,
    );
  });

  await Promise.all(
    [
      '/cs/orders',
      '/de/orders',
      '/en-us/orders',
      '/orders/',
      '/Orders',
      '/orders?state=open',
      '/orders#open',
      '/%2e%2e/orders',
      'https://example.test/orders',
    ].map((url) =>
      withFixture(async (fixture) => {
        const before = await snapshotTree(fixture.root);
        await assert.rejects(
          run(fixture, 'microvertical-page', [
            '--vertical',
            'inventory-stock',
            '--page',
            'orders',
            '--url',
            url,
          ]),
          /--url/u,
        );
        assert.deepEqual(await snapshotTree(fixture.root), before);
      }),
    ),
  );
});

test('generates a non-navigational dynamic page with canonical parameters and router directories', async () => {
  await withFixture(async (fixture) => {
    await writeFixtureFile(
      fixture.root,
      'verticals/inventory-stock/module-federation.config.ts',
      `export default {
  exposes: {
    './PageInventoryStock': './src/federation-entry.tsx',
  },
  manifest: {
    additionalData: ({ stats }) => ({ exposes: stats.exposes }),
  },
};
`,
    );
    const arguments_ = [
      '--vertical',
      'inventory-stock',
      '--page',
      'customer-edit',
      '--url',
      '/contacts/customers/:id/edit',
    ];
    await run(fixture, 'microvertical-page', arguments_);

    const ownerRoute = 'verticals/inventory-stock/src/routes/[lang]/contacts/customers/[id]/edit';
    const shellRoute = 'apps/shell-super-app/src/routes/[lang]/contacts/customers/[id]/edit';
    const page = await readFixtureFile(fixture.root, `${ownerRoute}/page.tsx`);
    const ownerMetadata = await readFixtureFile(fixture.root, `${ownerRoute}/route.meta.ts`);
    const shellLoader = await readFixtureFile(fixture.root, `${shellRoute}/page.data.ts`);
    const shellMetadata = await readFixtureFile(fixture.root, `${shellRoute}/route.meta.ts`);
    const manifest = await readFixtureFile(
      fixture.root,
      'verticals/inventory-stock/vertical.manifest.ts',
    );
    const registration = await readFixtureFile(
      fixture.root,
      'verticals/inventory-stock/vertical.registration.ts',
    );
    const federation = await readFixtureFile(
      fixture.root,
      'verticals/inventory-stock/module-federation.config.ts',
    );
    const federatedPage = await readFixtureFile(
      fixture.root,
      'verticals/inventory-stock/src/federation/page-customer-edit.tsx',
    );
    const shellClients = await readFixtureFile(
      fixture.root,
      'apps/shell-super-app/src/api/vertical-clients.ts',
    );

    assert.match(page, /Readonly<Partial<Record<'id', string>>>/u);
    assert.match(page, /CustomerEditPage = \(\{ routeParams \}/u);
    assert.match(page, /void routeParams;/u);
    assert.match(ownerMetadata, /canonicalPath: '\/contacts\/customers\/:id\/edit'/u);
    assert.match(ownerMetadata, /en: '\/contacts\/customers\/:id\/edit'/u);
    assert.match(shellMetadata, /canonicalPath: '\/contacts\/customers\/:id\/edit'/u);
    assert.match(manifest, /routePath: '\/contacts\/customers\/:id\/edit'/u);
    assert.match(manifest, /inventory\.stock\.page\.customer-edit/u);
    assert.doesNotMatch(manifest, /inventory\.stock\.navigation\.customer-edit/u);
    assert.match(registration, /'page-customer-edit'/u);
    assert.match(federation, /'\.\/PageCustomerEdit'/u);
    assert.match(federatedPage, /Readonly<Partial<Record<'id', string>>>/u);
    assert.match(federatedPage, /<CustomerEditPage routeParams=\{routeParams\} \/>/u);
    assert.match(shellClients, /inventory\.stock\.page-customer-edit/u);
    assert.match(shellLoader, /selectRouteParams/u);
    assert.match(shellLoader, /const routeParameterNames = \['id'\] as const;/u);
    assert.match(shellLoader, /routeParams: selectRouteParams\(params, routeParameterNames\)/u);
    assert.match(
      await readFixtureFile(fixture.root, 'verticals/inventory-stock/locales/en/inventory.json'),
      /"customerEdit"/u,
    );
    assert.match(
      await readFixtureFile(fixture.root, 'verticals/inventory-stock/locales/cs/inventory.json'),
      /"customerEdit"/u,
    );

    const afterFirstRun = await snapshotTree(fixture.root);
    await run(fixture, 'microvertical-page', arguments_);
    assert.deepEqual(await snapshotTree(fixture.root), afterFirstRun);
  });
});

test('generates the Contacts Contact-detail two-parameter page atomically and safely reruns it', async () => {
  const arguments_ = [
    '--vertical',
    'inventory-stock',
    '--page',
    'contact-detail',
    '--url',
    '/contacts/customers/:id/contacts/:contactId',
  ];

  await withFixture(async (fixture) => {
    const ownerRoute =
      'verticals/inventory-stock/src/routes/[lang]/contacts/customers/[id]/contacts/[contactId]';
    const shellRoute =
      'apps/shell-super-app/src/routes/[lang]/contacts/customers/[id]/contacts/[contactId]';

    await run(fixture, 'microvertical-page', arguments_);

    const page = await readFixtureFile(fixture.root, `${ownerRoute}/page.tsx`);
    const ownerMetadata = await readFixtureFile(fixture.root, `${ownerRoute}/route.meta.ts`);
    const shellLoader = await readFixtureFile(fixture.root, `${shellRoute}/page.data.ts`);
    const shellMetadata = await readFixtureFile(fixture.root, `${shellRoute}/route.meta.ts`);
    const manifest = await readFixtureFile(
      fixture.root,
      'verticals/inventory-stock/vertical.manifest.ts',
    );

    assert.match(page, /Readonly<Partial<Record<'id' \| 'contactId', string>>>/u);
    assert.match(
      ownerMetadata,
      /canonicalPath: '\/contacts\/customers\/:id\/contacts\/:contactId'/u,
    );
    assert.match(
      shellMetadata,
      /canonicalPath: '\/contacts\/customers\/:id\/contacts\/:contactId'/u,
    );
    assert.match(manifest, /routePath: '\/contacts\/customers\/:id\/contacts\/:contactId'/u);
    assert.match(manifest, /inventory\.stock\.page\.contact-detail/u);
    assert.doesNotMatch(manifest, /inventory\.stock\.navigation\.contact-detail/u);
    assert.match(shellLoader, /const routeParameterNames = \['id', 'contactId'\] as const;/u);
    assert.match(shellLoader, /routeParams: selectRouteParams\(params, routeParameterNames\)/u);
    await stat(path.join(fixture.root, ownerRoute));
    await stat(path.join(fixture.root, shellRoute));

    const afterFirstRun = await snapshotTree(fixture.root);
    await run(fixture, 'microvertical-page', arguments_);
    assert.deepEqual(await snapshotTree(fixture.root), afterFirstRun);
  });

  await withFixture(async (fixture) => {
    await writeFixtureFile(
      fixture.root,
      'apps/shell-super-app/src/routes/[lang]/contacts/customers/[id]/contacts/[contactId]/page.tsx',
      'export default function DeveloperOwnedPage() { return null; }\n',
    );
    const before = await snapshotTree(fixture.root);

    await assert.rejects(
      run(fixture, 'microvertical-page', arguments_),
      /refusing to overwrite|already exists/u,
    );
    assert.deepEqual(await snapshotTree(fixture.root), before);
  });
});

test('rejects unsafe dynamic parameters and dynamic route collisions without writing', async () => {
  await Promise.all(
    [
      '/inventory/customers/:1id/edit',
      '/inventory/customers/:customer-id/edit',
      '/inventory/customers/:id?/edit',
      '/inventory/customers/:id*/edit',
      '/inventory/customers/*id/edit',
      '/inventory/customers/[id]/edit',
      '/inventory/customers/:id/edit/:id',
      '/inventory/customers/%2e%2e/:id',
      '/cs/inventory/customers/:id',
    ].map((url) =>
      withFixture(async (fixture) => {
        const before = await snapshotTree(fixture.root);
        await assert.rejects(
          run(fixture, 'microvertical-page', [
            '--vertical',
            'inventory-stock',
            '--page',
            'customer-edit',
            '--url',
            url,
          ]),
          /--url/u,
        );
        assert.deepEqual(await snapshotTree(fixture.root), before);
      }),
    ),
  );

  await Promise.all([
    withFixture(async (fixture) => {
      await run(fixture, 'microvertical-page', [
        '--vertical',
        'inventory-stock',
        '--page',
        'customer-detail',
        '--url',
        '/inventory/customers/:id',
      ]);
      const before = await snapshotTree(fixture.root);
      await assert.rejects(
        run(fixture, 'microvertical-page', [
          '--vertical',
          'inventory-stock',
          '--page',
          'customer-edit',
          '--url',
          '/inventory/customers/:customerId',
        ]),
        /routing collision|already registered|collides/u,
      );
      assert.deepEqual(await snapshotTree(fixture.root), before);
    }),
    withFixture(async (fixture) => {
      const arguments_ = [
        '--vertical',
        'inventory-stock',
        '--page',
        'customer-edit',
        '--url',
        '/inventory/customers/:id/edit',
      ];
      await run(fixture, 'microvertical-page', arguments_);
      const pagePath = path.join(
        fixture.root,
        'verticals/inventory-stock/src/routes/[lang]/inventory/customers/[id]/edit/page.tsx',
      );
      await writeFile(
        pagePath,
        `${await readFile(pagePath, 'utf-8')}\n// developer edit\n`,
        'utf-8',
      );
      const before = await snapshotTree(fixture.root);
      await assert.rejects(run(fixture, 'microvertical-page', arguments_), /collides/u);
      assert.deepEqual(await snapshotTree(fixture.root), before);
    }),
    withFixture(async (fixture) => {
      await writeFixtureFile(
        fixture.root,
        'verticals/inventory-stock/src/routes/[lang]/inventory/customers/[id]/edit/page.tsx',
        'export default function PartialPage() { return null; }\n',
      );
      const before = await snapshotTree(fixture.root);
      await assert.rejects(
        run(fixture, 'microvertical-page', [
          '--vertical',
          'inventory-stock',
          '--page',
          'customer-edit',
          '--url',
          '/inventory/customers/:id/edit',
        ]),
        /collides with nested content/u,
      );
      assert.deepEqual(await snapshotTree(fixture.root), before);
    }),
    withFixture(async (fixture) => {
      await run(fixture, 'microvertical-page', [
        '--vertical',
        'inventory-stock',
        '--page',
        'customer-new',
        '--url',
        '/inventory/customers/new',
      ]);
      const before = await snapshotTree(fixture.root);
      await assert.rejects(
        run(fixture, 'microvertical-page', [
          '--vertical',
          'inventory-stock',
          '--page',
          'customer-edit',
          '--url',
          '/inventory/customers/:id',
        ]),
        /static route segment|collides/u,
      );
      assert.deepEqual(await snapshotTree(fixture.root), before);
    }),
    withFixture(async (fixture) => {
      await run(fixture, 'microvertical-page', [
        '--vertical',
        'billing',
        '--page',
        'customer-edit',
        '--url',
        '/shared/customers/:id/edit',
      ]);
      await rm(
        path.join(
          fixture.root,
          'apps/shell-super-app/src/routes/[lang]/shared/customers/[id]/edit',
        ),
        { recursive: true },
      );
      const before = await snapshotTree(fixture.root);
      await assert.rejects(
        run(fixture, 'microvertical-page', [
          '--vertical',
          'inventory-stock',
          '--page',
          'customer-edit',
          '--url',
          '/shared/customers/:id/edit',
        ]),
        /already registered by billing/u,
      );
      assert.deepEqual(await snapshotTree(fixture.root), before);
    }),
  ]);
});

test('extends an existing dynamic route branch without reclassifying an existing static sibling', async () => {
  await withFixture(async (fixture) => {
    await run(fixture, 'microvertical-page', [
      '--vertical',
      'inventory-stock',
      '--page',
      'customer-detail',
      '--url',
      '/inventory/customers/:id',
    ]);
    await writeFixtureFile(
      fixture.root,
      'apps/shell-super-app/src/routes/[lang]/inventory/customers/new/page.tsx',
      'export default function ExistingStaticSibling() { return null; }\n',
    );

    await run(fixture, 'microvertical-page', [
      '--vertical',
      'inventory-stock',
      '--page',
      'customer-edit',
      '--url',
      '/inventory/customers/:id/edit',
    ]);

    await stat(
      path.join(
        fixture.root,
        'apps/shell-super-app/src/routes/[lang]/inventory/customers/[id]/edit/page.tsx',
      ),
    );
  });
});

test('rejects reserved, dynamic, and cross-owner page URLs before writing', async () => {
  await Promise.all([
    withFixture(async (fixture) => {
      await writeFixtureFile(
        fixture.root,
        'apps/shell-super-app/src/routes/[lang]/modules/[moduleId]/page.tsx',
        'export default function ModulePage() { return null; }\n',
      );
      const before = await snapshotTree(fixture.root);
      await assert.rejects(
        run(fixture, 'microvertical-page', [
          '--vertical',
          'inventory-stock',
          '--page',
          'customers',
          '--url',
          '/modules/customers',
        ]),
        /collides with dynamic route segment \[moduleId\]/u,
      );
      assert.deepEqual(await snapshotTree(fixture.root), before);
    }),
    withFixture(async (fixture) => {
      await writeFixtureFile(
        fixture.root,
        'apps/shell-super-app/src/routes/[lang]/login/page.tsx',
        'export default function LoginPage() { return null; }\n',
      );
      const before = await snapshotTree(fixture.root);
      await assert.rejects(
        run(fixture, 'microvertical-page', [
          '--vertical',
          'inventory-stock',
          '--page',
          'customers',
          '--url',
          '/login/customers',
        ]),
        /reserved route prefix \/login/u,
      );
      assert.deepEqual(await snapshotTree(fixture.root), before);
    }),
    withFixture(async (fixture) => {
      await run(fixture, 'microvertical-page', [
        '--vertical',
        'billing',
        '--page',
        'customers',
        '--url',
        '/shared/customers',
      ]);
      await rm(path.join(fixture.root, 'apps/shell-super-app/src/routes/[lang]/shared/customers'), {
        recursive: true,
      });
      const before = await snapshotTree(fixture.root);
      await assert.rejects(
        run(fixture, 'microvertical-page', [
          '--vertical',
          'inventory-stock',
          '--page',
          'customer-list',
          '--url',
          '/shared/customers',
        ]),
        /already registered by billing/u,
      );
      assert.deepEqual(await snapshotTree(fixture.root), before);
    }),
  ]);
});

test('uses exact page identities and rejects edited generated wiring', async () => {
  await withFixture(async (fixture) => {
    await run(fixture, 'microvertical-page', [
      '--vertical',
      'inventory-stock',
      '--page',
      'order-lines',
    ]);
    await run(fixture, 'microvertical-page', ['--vertical', 'inventory-stock', '--page', 'order']);
    await stat(
      path.join(
        fixture.root,
        'verticals/inventory-stock/src/routes/[lang]/inventory-stock/order/page.tsx',
      ),
    );
  });

  await Promise.all([
    withFixture(async (fixture) => {
      await run(fixture, 'microvertical-page', [
        '--vertical',
        'inventory-stock',
        '--page',
        'orders',
        '--url',
        '/first/orders',
      ]);
      const manifestPath = path.join(
        fixture.root,
        'verticals/inventory-stock/vertical.manifest.ts',
      );
      const manifest = await readFile(manifestPath, 'utf-8');
      await writeFile(
        manifestPath,
        manifest
          .replaceAll("'page-orders'", '"page-orders"')
          .replaceAll("'inventory.stock.page.orders'", '"inventory.stock.page.orders"'),
        'utf-8',
      );
      const before = await snapshotTree(fixture.root);
      await assert.rejects(
        run(fixture, 'microvertical-page', [
          '--vertical',
          'inventory-stock',
          '--page',
          'orders',
          '--url',
          '/second/orders',
        ]),
        /page identity inventory\.stock\.page\.orders already exists/u,
      );
      assert.deepEqual(await snapshotTree(fixture.root), before);
    }),
    withFixture(async (fixture) => {
      const arguments_ = ['--vertical', 'inventory-stock', '--page', 'orders'];
      await run(fixture, 'microvertical-page', arguments_);
      const manifestPath = path.join(
        fixture.root,
        'verticals/inventory-stock/vertical.manifest.ts',
      );
      const manifest = await readFile(manifestPath, 'utf-8');
      await writeFile(manifestPath, manifest.replace('order: 100', 'order: 101'), 'utf-8');
      const before = await snapshotTree(fixture.root);
      await assert.rejects(
        run(fixture, 'microvertical-page', arguments_),
        /already exists|collides/u,
      );
      assert.deepEqual(await snapshotTree(fixture.root), before);
    }),
    withFixture(async (fixture) => {
      const arguments_ = ['--vertical', 'inventory-stock', '--page', 'orders'];
      await run(fixture, 'microvertical-page', arguments_);
      const manifestPath = path.join(
        fixture.root,
        'verticals/inventory-stock/vertical.manifest.ts',
      );
      const manifest = await readFile(manifestPath, 'utf-8');
      await writeFile(
        manifestPath,
        manifest.replace(
          '// </generated-module-shell-navigation>',
          `{ contributionKey : "inventory.stock.navigation.orders", entrypoint: { access: 'read', entrypointKey: 'inventory.stock.page.orders', moduleKey: 'inventory.stock', role: 'page', scope: 'tenant' }, groupKey: 'shell.navigation.modules', order: 101, pageKey: 'inventory.stock.page.orders' },
        // </generated-module-shell-navigation>`,
        ),
        'utf-8',
      );
      const before = await snapshotTree(fixture.root);
      await assert.rejects(
        run(fixture, 'microvertical-page', arguments_),
        /already exists|collides/u,
      );
      assert.deepEqual(await snapshotTree(fixture.root), before);
    }),
    withFixture(async (fixture) => {
      const arguments_ = ['--vertical', 'inventory-stock', '--page', 'orders'];
      await run(fixture, 'microvertical-page', arguments_);
      const federationPath = path.join(
        fixture.root,
        'verticals/inventory-stock/module-federation.config.ts',
      );
      const federation = await readFile(federationPath, 'utf-8');
      await writeFile(
        federationPath,
        federation.replace(
          "'./src/federation/page-orders.tsx'",
          "'./src/federation/page-other.tsx'",
        ),
        'utf-8',
      );
      const before = await snapshotTree(fixture.root);
      await assert.rejects(
        run(fixture, 'microvertical-page', arguments_),
        /already exists|collides/u,
      );
      assert.deepEqual(await snapshotTree(fixture.root), before);
    }),
    withFixture(async (fixture) => {
      const arguments_ = ['--vertical', 'inventory-stock', '--page', 'orders'];
      await run(fixture, 'microvertical-page', arguments_);
      await writeFixtureFile(
        fixture.root,
        'apps/shell-super-app/src/routes/[lang]/inventory-stock/orders/developer-note.ts',
        'export const developerNote = true;\n',
      );
      const before = await snapshotTree(fixture.root);
      await assert.rejects(
        run(fixture, 'microvertical-page', arguments_),
        /already exists|collides/u,
      );
      assert.deepEqual(await snapshotTree(fixture.root), before);
    }),
  ]);
});

test('migrates only exact legacy generated page output and then reruns as a no-op', async () => {
  await withFixture(async (fixture) => {
    const arguments_ = ['--vertical', 'inventory-stock', '--page', 'orders', '--url', '/orders'];
    await run(fixture, 'microvertical-page', arguments_);
    await writeFixtureFile(
      fixture.root,
      'verticals/inventory-stock/src/routes/[lang]/orders/page.tsx',
      `import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { UltramodernRouteHead } from '../../ultramodern-route-head';

export const OrdersPage = () => {
  const { t } = useModernI18n();
  const headingId = 'orders-heading';

  return (
    <>
      <UltramodernRouteHead />
      <main className="inventory:min-h-screen inventory:bg-(--color-page-bg) inventory:px-4 inventory:py-8 inventory:text-(--color-page-fg) inventory:sm:px-8 inventory:lg:px-12">
        <div className="inventory:mx-auto inventory:flex inventory:max-w-5xl inventory:flex-col inventory:gap-8">
          <header className="inventory:space-y-3">
            <h1
              className="inventory:text-3xl inventory:font-bold inventory:sm:text-4xl"
              id={headingId}
            >
              {t('inventory.pages.orders.title')}
            </h1>
            <p className="inventory:max-w-2xl inventory:text-base inventory:sm:text-lg">
              {t('inventory.pages.orders.description')}
            </p>
          </header>
          <section
            aria-labelledby={headingId}
            className="inventory:bg-(--color-surface) inventory:p-6 inventory:sm:p-8"
          >
            <p>{t('inventory.pages.orders.empty')}</p>
          </section>
        </div>
      </main>
    </>
  );
};

export default OrdersPage;
`,
    );
    await writeFixtureFile(
      fixture.root,
      'apps/shell-super-app/src/routes/[lang]/orders/page.data.ts',
      `import { loader as loadModuleTarget } from '../modules/[moduleId]/page.data.ts';

interface ShellPageLoaderArguments {
  readonly request: Request;
}

export const loader = ({ request }: ShellPageLoaderArguments) =>
  loadModuleTarget({ params: { moduleId: 'inventory.stock' }, request });
`,
    );
    await Promise.all(
      ['cs', 'en'].map(async (locale) => {
        const localePath = path.join(
          fixture.root,
          `verticals/inventory-stock/locales/${locale}/inventory.json`,
        );
        const catalog = decodeInventoryLocale(await readFile(localePath, 'utf-8'));
        catalog.inventory.pages['orders'] =
          locale === 'cs'
            ? {
                description: 'Tato stránka je připravena k implementaci.',
                empty: 'Zatím zde není žádný obsah.',
                title: 'Nová stránka',
              }
            : {
                description: 'This page is ready for implementation.',
                empty: 'No content has been added yet.',
                title: 'New Page',
              };
        await writeFile(localePath, json(catalog), 'utf-8');
      }),
    );

    await run(fixture, 'microvertical-page', arguments_);
    const migratedPage = await readFixtureFile(
      fixture.root,
      'verticals/inventory-stock/src/routes/[lang]/orders/page.tsx',
    );
    assert.doesNotMatch(migratedPage, /\.description|\.empty|<main/u);
    assert.match(
      await readFixtureFile(
        fixture.root,
        'apps/shell-super-app/src/routes/[lang]/orders/page.data.ts',
      ),
      /entrypointKey: 'inventory\.stock\.page\.orders'/u,
    );
    const migratedEnglish = decodeInventoryLocale(
      await readFixtureFile(fixture.root, 'verticals/inventory-stock/locales/en/inventory.json'),
    );
    assert.deepEqual(migratedEnglish.inventory.pages['orders'], {
      description: 'This page is ready for implementation.',
      title: 'New Page',
    });
    const afterMigration = await snapshotTree(fixture.root);
    await run(fixture, 'microvertical-page', arguments_);
    assert.deepEqual(await snapshotTree(fixture.root), afterMigration);
  });
});

test('rejects page generation when an owning locale has no truthful starter translation', async () => {
  await withFixture(async (fixture) => {
    const packagePath = path.join(fixture.root, 'verticals/inventory-stock/package.json');
    const packageJson = decodeFixturePackage(await readFile(packagePath, 'utf-8'));
    packageJson.exports['./locales/de'] = './locales/de/inventory.json';
    await writeFile(packagePath, json(packageJson), 'utf-8');
    await writeFixtureFile(
      fixture.root,
      'verticals/inventory-stock/locales/de/inventory.json',
      json({ inventory: { existing: 'de-preserved' } }),
    );
    const before = await snapshotTree(fixture.root);

    await assert.rejects(
      run(fixture, 'microvertical-page', [
        '--vertical',
        'inventory-stock',
        '--page',
        'purchase-orders',
      ]),
      /no starter translation for locale de/u,
    );
    assert.deepEqual(await snapshotTree(fixture.root), before);
  });
});

test('page prerequisite and nested-route failures are preflighted, while refresh failure is safely rerunnable', async () => {
  await withFixture(async (fixture) => {
    await rm(
      path.join(fixture.root, 'verticals/inventory-stock/src/routes/ultramodern-route-head.tsx'),
    );
    const beforeMissingHead = await snapshotTree(fixture.root);
    await assert.rejects(
      run(fixture, 'microvertical-page', ['--vertical', 'inventory-stock', '--page', 'orders']),
      /UltramodernRouteHead is missing/u,
    );
    assert.deepEqual(await snapshotTree(fixture.root), beforeMissingHead);
  });

  await withFixture(async (fixture) => {
    await writeFixtureFile(
      fixture.root,
      'verticals/inventory-stock/src/routes/[lang]/inventory-stock/orders/nested.ts',
      'export {};\n',
    );
    const beforeCollision = await snapshotTree(fixture.root);
    await assert.rejects(
      run(fixture, 'microvertical-page', ['--vertical', 'inventory-stock', '--page', 'orders']),
      /collides with nested content/u,
    );
    assert.deepEqual(await snapshotTree(fixture.root), beforeCollision);
  });

  await withFixture(async (fixture) => {
    await assert.rejects(
      runScaffold('microvertical-page', ['--vertical', 'inventory-stock', '--page', 'orders'], {
        routeRefresh: () => {
          throw new Error('route refresh fixture failure');
        },
        workspaceRoot: fixture.root,
      }),
      /route refresh fixture failure/u,
    );
    await stat(
      path.join(
        fixture.root,
        'verticals/inventory-stock/src/routes/[lang]/inventory-stock/orders/page.tsx',
      ),
    );
    const afterRefreshFailure = await snapshotTree(fixture.root);
    const refreshes: string[] = [];
    await run(
      fixture,
      'microvertical-page',
      ['--vertical', 'inventory-stock', '--page', 'orders'],
      (appId) => refreshes.push(appId),
    );
    assert.deepEqual(refreshes, ['inventory-stock', 'shell-super-app']);
    assert.deepEqual(await snapshotTree(fixture.root), afterRefreshFailure);
  });
});

const runCombinedScenario = async (fixture: Fixture): Promise<Readonly<Record<string, string>>> => {
  await addInventoryItemResourceType(fixture);
  await run(fixture, 'microvertical-action-boundary', ['--vertical', 'inventory-stock']);
  await run(fixture, 'external-http-adapter', [
    '--vertical',
    'inventory-stock',
    '--provider',
    'warehouse-api',
    '--operation',
    'stock-level',
  ]);
  await run(fixture, 'action', [
    '--scope',
    'core',
    '--module',
    'core.modules',
    '--action',
    'change-tenant-state',
  ]);
  await run(fixture, 'action', ['--vertical', 'inventory-stock', '--action', 'create-order']);
  await run(fixture, 'outbox-message', [
    '--vertical',
    'inventory-stock',
    '--action',
    'create-order',
    '--topic',
    'orders.created',
  ]);
  await run(fixture, 'policy', ['--scope', 'global', '--policy', 'tenant-active']);
  await run(fixture, 'policy', [
    '--scope',
    'microvertical',
    '--policy',
    'stock-available',
    '--vertical',
    'inventory-stock',
  ]);
  await run(fixture, 'module-api', ['--vertical', 'inventory-stock', '--name', 'resource-detail']);
  await run(fixture, 'search-provider', [
    '--vertical',
    'inventory-stock',
    '--name',
    'inventory-items',
    '--resource',
    'item',
  ]);
  await run(fixture, 'report', [
    '--vertical',
    'inventory-stock',
    '--name',
    'stock-levels',
    '--resource',
    'item',
  ]);
  await run(
    fixture,
    'microvertical-page',
    ['--vertical', 'inventory-stock', '--page', 'orders'],
    (appId) => assert.ok(['inventory-stock', 'shell-super-app'].includes(appId)),
  );
  await run(fixture, 'microvertical-page', [
    '--vertical',
    'inventory-stock',
    '--page',
    'customer-edit',
    '--url',
    '/contacts/customers/:id/edit',
  ]);
  return snapshotTree(fixture.root);
};

test('all generators compose deterministically without crossing owner boundaries', async () => {
  const first = await createFixture();
  const second = await createFixture();
  try {
    const billingBefore = Object.fromEntries(
      Object.entries(await snapshotTree(first.root)).filter(([file]) =>
        file.startsWith('verticals/billing/'),
      ),
    );
    const shellBefore = await readFixtureFile(first.root, 'apps/shell-super-app/src/sentinel.ts');
    const topologyBefore = await readFixtureFile(first.root, 'topology/reference-topology.json');
    const firstTree = await runCombinedScenario(first);
    const secondTree = await runCombinedScenario(second);
    assert.deepEqual(firstTree, secondTree);
    const billingAfter = Object.fromEntries(
      Object.entries(firstTree).filter(([file]) => file.startsWith('verticals/billing/')),
    );
    assert.deepEqual(billingAfter, billingBefore);
    assert.equal(
      await readFixtureFile(first.root, 'apps/shell-super-app/src/sentinel.ts'),
      shellBefore,
    );
    assert.equal(
      await readFixtureFile(first.root, 'topology/reference-topology.json'),
      topologyBefore,
    );
    const combinedSource = Object.values(firstTree).join('\n');
    assert.doesNotMatch(combinedSource, /from ['"]\.\.\/\.\.\/billing|fetch\(/u);
  } finally {
    await rm(first.root, { force: true, recursive: true });
    await rm(second.root, { force: true, recursive: true });
  }
});

test('every generated TypeScript file is already formatter-stable', async () => {
  await withFixture(async (fixture) => {
    await runCombinedScenario(fixture);
    await run(fixture, 'outbox-worker', [
      '--vertical',
      'billing',
      '--worker',
      'orders-created-logger',
      '--producer',
      'inventory-stock',
      '--topic',
      'orders.created',
    ]);
    const generatedFiles = [
      'packages/core-runtime/src/modules/actions/change-tenant-state.action.ts',
      'packages/core-runtime/src/policies/tenant-active.policy.ts',
      'verticals/inventory-stock/src/actions/create-order.action.ts',
      'verticals/inventory-stock/src/integrations/warehouse-api/warehouse-api-stock-level.service.ts',
      'verticals/inventory-stock/src/actions/create-order.orders-created.outbox-message.ts',
      'verticals/inventory-stock/shared/outbox/orders-created.ts',
      'verticals/billing/src/workers/index.ts',
      'verticals/billing/src/workers/orders-created-logger.worker.ts',
      'verticals/billing/src/worker-host/layer.ts',
      'verticals/billing/src/worker-host/main.ts',
      'verticals/inventory-stock/src/policies/stock-available.policy.ts',
      'verticals/inventory-stock/src/routes/[lang]/inventory-stock/orders/page.tsx',
      'verticals/inventory-stock/src/routes/[lang]/inventory-stock/orders/route.meta.ts',
      'verticals/inventory-stock/src/federation/page-orders.tsx',
      'verticals/inventory-stock/api/auth/action-principal.ts',
      'verticals/inventory-stock/src/api/action-gateway.ts',
      'verticals/inventory-stock/shared/apis/resource-detail.ts',
      'verticals/inventory-stock/src/api/resource-detail.read.ts',
      'verticals/inventory-stock/src/api/resource-detail-client.ts',
      'verticals/inventory-stock/api/resource-detail-read-server.ts',
      'verticals/inventory-stock/shared/apis/inventory-items-search.ts',
      'verticals/inventory-stock/src/search/inventory-items.provider.ts',
      'verticals/inventory-stock/src/api/inventory-items-search-client.ts',
      'verticals/inventory-stock/api/inventory-items-search-server.ts',
      'verticals/inventory-stock/shared/apis/stock-levels-report.ts',
      'verticals/inventory-stock/src/reports/stock-levels.provider.ts',
      'verticals/inventory-stock/src/api/stock-levels-report-client.ts',
      'verticals/inventory-stock/api/stock-levels-report-server.ts',
    ];

    await Promise.all(
      generatedFiles.map(async (relativePath) => {
        const source = await readFixtureFile(fixture.root, relativePath);
        const formatted = spawnSync(oxfmtPath, [`--stdin-filepath=${relativePath}`], {
          cwd: appRoot,
          encoding: 'utf-8',
          input: source,
        });
        assert.equal(formatted.status, 0, formatted.stderr);
        assert.equal(formatted.stdout, source, `${relativePath} must be formatter-stable`);
      }),
    );
  });
});

test('all generated files typecheck against the real workspace contracts', async () => {
  await withFixture(async (fixture) => {
    await runCombinedScenario(fixture);
    await run(fixture, 'outbox-worker', [
      '--vertical',
      'billing',
      '--worker',
      'orders-created-logger',
      '--producer',
      'inventory-stock',
      '--topic',
      'orders.created',
    ]);
    await mkdir(path.join(fixture.root, 'node_modules', '@authzed'), { recursive: true });
    await mkdir(path.join(fixture.root, 'node_modules', '@effect'), { recursive: true });
    await mkdir(path.join(fixture.root, 'node_modules', '@modern-js'), { recursive: true });
    await mkdir(path.join(fixture.root, 'node_modules', '@types'), { recursive: true });
    await symlink(
      path.join(appRoot, 'packages/core-runtime/node_modules/effect'),
      path.join(fixture.root, 'node_modules/effect'),
      'dir',
    );
    await symlink(
      path.join(appRoot, 'packages/core-runtime/node_modules/@effect/platform-node'),
      path.join(fixture.root, 'node_modules/@effect/platform-node'),
      'dir',
    );
    await symlink(
      path.join(appRoot, 'apps/shell-super-app/node_modules/jose'),
      path.join(fixture.root, 'node_modules/jose'),
      'dir',
    );
    await symlink(
      path.join(appRoot, 'packages/core-runtime/node_modules/drizzle-orm'),
      path.join(fixture.root, 'node_modules/drizzle-orm'),
      'dir',
    );
    await symlink(
      path.join(appRoot, 'packages/core-runtime/node_modules/dotenv'),
      path.join(fixture.root, 'node_modules/dotenv'),
      'dir',
    );
    await symlink(
      path.join(appRoot, 'packages/core-runtime/node_modules/pg'),
      path.join(fixture.root, 'node_modules/pg'),
      'dir',
    );
    await symlink(
      path.join(appRoot, 'packages/core-runtime/node_modules/@authzed/authzed-node'),
      path.join(fixture.root, 'node_modules/@authzed/authzed-node'),
      'dir',
    );
    await symlink(
      path.join(appRoot, 'apps/shell-super-app/node_modules/@modern-js/plugin-i18n'),
      path.join(fixture.root, 'node_modules/@modern-js/plugin-i18n'),
      'dir',
    );
    await symlink(
      path.join(appRoot, 'apps/shell-super-app/node_modules/@modern-js/plugin-bff'),
      path.join(fixture.root, 'node_modules/@modern-js/plugin-bff'),
      'dir',
    );
    await symlink(
      path.join(appRoot, 'apps/shell-super-app/node_modules/@types/react'),
      path.join(fixture.root, 'node_modules/@types/react'),
      'dir',
    );
    await symlink(
      path.join(appRoot, 'packages/core-runtime/node_modules/@types/pg'),
      path.join(fixture.root, 'node_modules/@types/pg'),
      'dir',
    );
    await symlink(
      path.join(appRoot, 'node_modules/@types/node'),
      path.join(fixture.root, 'node_modules/@types/node'),
      'dir',
    );
    await symlink(
      path.join(appRoot, 'packages/core-runtime/src/actions'),
      path.join(fixture.root, 'packages/core-runtime/src/actions'),
      'dir',
    );
    await symlink(
      path.join(appRoot, 'packages/core-runtime/src/db'),
      path.join(fixture.root, 'packages/core-runtime/src/db'),
      'dir',
    );
    await symlink(
      path.join(appRoot, 'packages/core-runtime/src/operations'),
      path.join(fixture.root, 'packages/core-runtime/src/operations'),
      'dir',
    );
    await symlink(
      path.join(appRoot, 'packages/core-runtime/src/environment'),
      path.join(fixture.root, 'packages/core-runtime/src/environment'),
      'dir',
    );
    await symlink(
      path.join(appRoot, 'packages/core-runtime/src/permissions'),
      path.join(fixture.root, 'packages/core-runtime/src/permissions'),
      'dir',
    );
    await symlink(
      path.join(appRoot, 'packages/core-runtime/src/auth'),
      path.join(fixture.root, 'packages/core-runtime/src/auth'),
      'dir',
    );
    await symlink(
      path.join(appRoot, 'packages/core-runtime/src/modules/module-entrypoint.ts'),
      path.join(fixture.root, 'packages/core-runtime/src/modules/module-entrypoint.ts'),
      'file',
    );
    await Promise.all(
      [
        'module-entrypoint-gateway.ts',
        'module-state-gate-errors.ts',
        'module-state-gate.ts',
        'tenant-module-state-errors.ts',
        'tenant-module-state-service.ts',
      ].map((moduleFile) =>
        symlink(
          path.join(appRoot, 'packages/core-runtime/src/modules', moduleFile),
          path.join(fixture.root, 'packages/core-runtime/src/modules', moduleFile),
          'file',
        ),
      ),
    );
    const fixtureTsconfig = path.join(fixture.root, 'tsconfig.generated.json');
    await writeFile(
      fixtureTsconfig,
      json({
        compilerOptions: {
          allowImportingTsExtensions: true,
          jsx: 'preserve',
          module: 'preserve',
          moduleResolution: 'Bundler',
          noEmit: true,
          paths: {
            '@app/core-runtime': [path.join(appRoot, 'packages/core-runtime/src/index.ts')],
            '@app/core-runtime/actions/principal-context': [
              path.join(appRoot, 'packages/core-runtime/src/actions/principal-context.ts'),
            ],
            '@app/inventory-stock/outbox/*': ['./verticals/inventory-stock/shared/outbox/*.ts'],
            '@app/shared-contracts': [path.join(appRoot, 'packages/shared-contracts/src/index.ts')],
          },
          resolveJsonModule: true,
          skipLibCheck: true,
          strict: true,
          target: 'ESNext',
          types: ['node', 'react'],
        },
        include: [
          'packages/core-runtime/src/modules/actions/**/*.ts',
          'packages/core-runtime/src/policies/**/*.ts',
          'verticals/inventory-stock/vertical.manifest.ts',
          'verticals/inventory-stock/src/actions/**/*.ts',
          'verticals/inventory-stock/src/integrations/**/*.ts',
          'verticals/inventory-stock/shared/outbox/**/*.ts',
          'verticals/billing/src/workers/**/*.ts',
          'verticals/billing/src/worker-host/**/*.ts',
          'verticals/inventory-stock/src/policies/**/*.ts',
          'verticals/inventory-stock/src/routes/**/*.ts',
          'verticals/inventory-stock/src/routes/**/*.tsx',
          'verticals/inventory-stock/src/federation/**/*.tsx',
          'verticals/inventory-stock/src/i18n/**/*.ts',
          'verticals/inventory-stock/api/**/*.ts',
          'verticals/inventory-stock/src/api/**/*.ts',
          'verticals/inventory-stock/shared/apis/**/*.ts',
          'verticals/inventory-stock/src/search/**/*.ts',
          'verticals/inventory-stock/src/reports/**/*.ts',
        ],
      }),
      'utf-8',
    );

    const result = spawnSync(tscPath, ['-p', fixtureTsconfig], {
      cwd: fixture.root,
      encoding: 'utf-8',
    });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  });
});
