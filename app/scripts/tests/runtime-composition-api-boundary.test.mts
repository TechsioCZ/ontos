import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Effect, Predicate, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

const workspaceRoot = fileURLToPath(new URL('../..', import.meta.url));
const checker = path.join(workspaceRoot, 'scripts/check-ultramodern-api-boundaries.mts');
const shellRoot = 'apps/shell-super-app';
const ownerRoot = 'verticals/inventory-stock';
const clientPath = `${ownerRoot}/src/api/inventory-stock-client.ts`;
const contractPath = `${ownerRoot}/shared/api.ts`;
const generatorRoot = await realpath(path.join(workspaceRoot, 'node_modules/@modern-js/ultramodern-create'));

interface OwnerFixture {
  readonly api: { readonly prefix: string; readonly stem: string };
  readonly exposes: Readonly<Record<string, string>>;
  readonly id: string;
}

type CreateSharedApi = (owner: OwnerFixture, options: { readonly scope: string }) => string;
type CreateApiService = (owner: OwnerFixture, contract: string, options: { readonly scope: string }) => string;
type CreateApiClient = (owner: OwnerFixture, contract: string, options: { readonly scope: string }) => string;

const callable = <Callable extends (...argumentsList: never[]) => void>() =>
  Schema.Opaque<Callable>()(Schema.Unknown.pipe(Schema.refine(Predicate.isFunction)));

const loadGenerator = (name: string) =>
  Effect.promise(
    () => import(pathToFileURL(path.join(generatorRoot, `dist/esm-node/ultramodern-workspace/api/${name}.js`)).href),
  );

const writeText = (root: string, logicalPath: string, source: string) =>
  Effect.promise(async () => {
    const filename = path.join(root, logicalPath);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, source);
  });

const makeFixture = Effect.fn(function* makeRuntimeCompositionBoundaryFixture() {
  const root = yield* Effect.acquireRelease(
    Effect.promise(() => mkdtemp(path.join(os.tmpdir(), 'ontos-runtime-api-boundary-'))),
    (directory) => Effect.promise(() => rm(directory, { force: true, recursive: true })),
  );
  const shared = yield* loadGenerator('shared').pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ createSharedApi: callable<CreateSharedApi>() }))),
  );
  const service = yield* loadGenerator('service').pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ createApiServiceEntry: callable<CreateApiService>() }))),
  );
  const client = yield* loadGenerator('client').pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ createApiClient: callable<CreateApiClient>() }))),
  );
  const owner = {
    api: { prefix: '/inventory-stock-api', stem: 'inventory-stock' },
    exposes: {},
    id: 'inventory-stock',
  };
  const contract = shared
    .createSharedApi(owner, { scope: 'app' })
    .replace(
      /(?<foundation>\.addHttpApi\(inventoryStockFoundationApi\))[\s\S]*?(?=export const inventoryStockOperationContexts)/u,
      '$<foundation>;\n\n',
    )
    .replace(
      /(?<declaration>export const inventoryStockOperationContexts = \{)[\s\S]*?(?= {2}readiness:)/u,
      '$<declaration>\n',
    );
  yield* writeText(root, contractPath, contract);
  yield* writeText(
    root,
    `${ownerRoot}/api/index.ts`,
    service.createApiServiceEntry(owner, '../shared/api.ts', { scope: 'app' }),
  );
  yield* writeText(root, clientPath, client.createApiClient(owner, '../../shared/api.ts', { scope: 'app' }));
  yield* writeText(
    root,
    `${ownerRoot}/package.json`,
    JSON.stringify({ exports: { './api': './shared/api.ts', './api/client': './src/api/inventory-stock-client.ts' } }),
  );
  yield* writeText(root, `${shellRoot}/package.json`, JSON.stringify({ exports: {} }));
  yield* writeText(
    root,
    'topology/reference-topology.json',
    JSON.stringify({
      verticals: [
        {
          api: {
            basePath: '/inventory-stock-api/inventory-stock',
            bff: { prefix: '/inventory-stock-api', strictEffectApproach: true },
            readiness: { endpoint: '/inventory-stock/readiness' },
            runtime: 'effect',
            serverEntry: `${ownerRoot}/api/index.ts`,
          },
          id: owner.id,
          path: ownerRoot,
        },
      ],
    }),
  );
  const check = () =>
    spawnSync(process.execPath, [checker], {
      encoding: 'utf-8',
      env: { ULTRAMODERN_WORKSPACE_ROOT: root },
    });
  return { check, contract, root };
});

describe('runtime composition API boundaries', () => {
  it.live(
    'accepts foundation schema and client exports without business endpoints or a compiled Shell client registry',
    Effect.fn(function* acceptsNativeOwnerClients() {
      const fixture = yield* makeFixture();
      const result = fixture.check();
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain('UltraModern API boundary check passed');
    }),
  );

  it.live(
    'requires generated aggregate exports even when only foundation readiness is published',
    Effect.fn(function* rejectsMissingFoundationExports() {
      const fixture = yield* makeFixture();
      yield* writeText(fixture.root, `${ownerRoot}/package.json`, JSON.stringify({ exports: {} }));
      const result = fixture.check();
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/package must export \.\/api from shared\/api\.ts/u);
      expect(result.stderr).toMatch(/package must export \.\/api\/client from src\/api/u);
    }),
  );

  it.live(
    'rejects restoration of the compiled Shell client registry',
    Effect.fn(function* rejectsLiteralRegistry() {
      const fixture = yield* makeFixture();
      yield* writeText(fixture.root, `${shellRoot}/src/api/vertical-clients.ts`, 'export const clients = {};\n');
      const result = fixture.check();
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/vertical-clients\.ts/u);
    }),
  );

  it.live(
    'rejects restoration of the Shell aggregate client export',
    Effect.fn(function* rejectsAggregateExport() {
      const fixture = yield* makeFixture();
      yield* writeText(
        fixture.root,
        `${shellRoot}/package.json`,
        JSON.stringify({
          exports: { './api/clients': './src/api/vertical-clients.ts' },
        }),
      );
      const result = fixture.check();
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/package\.json must not export a compiled vertical API client registry/u);
    }),
  );

  it.live(
    'still requires each owner API client',
    Effect.fn(function* rejectsMissingOwnerClient() {
      const fixture = yield* makeFixture();
      yield* Effect.promise(() => rm(path.join(fixture.root, clientPath)));
      const result = fixture.check();
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/src\/api must contain a generated API client/u);
    }),
  );

  it.live(
    'rejects a Shell client importing an unknown owner implementation',
    Effect.fn(function* rejectsUnknownOwnerClient() {
      const fixture = yield* makeFixture();
      yield* writeText(
        fixture.root,
        `${shellRoot}/src/api/unknown-client.ts`,
        "import { registration } from '@app/unknown-owner/vertical.registration';\nexport const client = registration;\n",
      );
      const result = fixture.check();
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/Shell\/Core and consumers may not import a deployment owner file/u);
    }),
  );

  it.live(
    'does not admit business endpoints with a counterfeit generated seam',
    Effect.fn(function* rejectsFakeBusinessSeam() {
      const fixture = yield* makeFixture();
      yield* writeText(
        fixture.root,
        contractPath,
        `${fixture.contract}\nconst fake = HttpApiEndpoint.get('business', '/business');\n`,
      );
      yield* writeText(
        fixture.root,
        `${ownerRoot}/package.json`,
        JSON.stringify({
          exports: { './api': './shared/api.ts', './api/client': './src/api/inventory-stock-client.ts' },
        }),
      );
      yield* writeText(
        fixture.root,
        clientPath,
        '// @generated by OntOS Codesmith module-api v1\nexport const fake = true;\n',
      );
      const result = fixture.check();
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/verified trusted tenant context.*server ModuleEntrypointGateway/u);
    }),
  );
});
