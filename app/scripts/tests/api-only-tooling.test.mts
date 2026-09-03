import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { Schema } from 'effect';
import { format } from 'oxfmt';
import { transform } from 'esbuild';

const workspaceRoot = fileURLToPath(new URL('../..', import.meta.url));
const generatorRoot = await realpath(
  process.env.ONTOS_CREATE_PATCH_ROOT ?? path.join(workspaceRoot, 'node_modules/@modern-js/create'),
);
const require = createRequire(import.meta.url);

const evaluatePartyBuildGlobalVars = async (shellOrigin: string) => {
  const source = await readFile(
    path.join(workspaceRoot, 'verticals/party-registry/modern.config.ts'),
    'utf-8',
  );
  const { code } = await transform(source, { format: 'cjs', loader: 'ts' });
  const framework = {
    appTools: () => ({}),
    bffPlugin: () => ({}),
    createRequire: () => () => ({}),
    defineConfig: (configuration) => configuration,
    getBuildConfigEnvironment: (name) =>
      name === 'ULTRAMODERN_MF_DEV_ORIGIN' ? shellOrigin : undefined,
    i18nPlugin: () => ({}),
    moduleFederationPlugin: () => ({}),
    pluginTailwindcss: () => ({}),
    presetUltramodern: (configuration) => configuration,
    tanstackRouterPlugin: () => ({}),
    ultramodernLocalisedUrls: {},
  };
  const module = { exports: {} };
  runInNewContext(code, { exports: module.exports, module, require: () => framework });
  return module.exports.default.source.globalVars;
};

test('Party build configuration injects the exact nonlocal Shell origin into the API runtime', async () => {
  const shellOrigin = 'https://operations.example.test';
  const globalVars = await evaluatePartyBuildGlobalVars(shellOrigin);
  assert.equal(globalVars.ULTRAMODERN_SHELL_ORIGIN, shellOrigin);
});

test('compiled Party CORS reader uses the nonlocal DefinePlugin origin without a runtime global', async () => {
  const shellOrigin = 'https://operations.example.test';
  const globalVars = await evaluatePartyBuildGlobalVars(shellOrigin);
  const partyRoot = path.join(workspaceRoot, 'verticals/party-registry');
  const source = await readFile(path.join(partyRoot, 'api/index.ts'), 'utf-8');
  const reader =
    /(?<reader>(?:interface PartyRegistryRuntimeGlobal|declare const ULTRAMODERN_SHELL_ORIGIN)[\s\S]+?)\nexport const makePartyRegistryApiRuntime/u.exec(
      source,
    )?.groups?.reader;
  assert.ok(reader, 'compile the actual API origin-reader boundary');
  const appToolsPath = require.resolve('@modern-js/app-tools/config', { paths: [partyRoot] });
  const { rspack, DefinePlugin } = require(
    require.resolve('@rspack/core', { paths: [appToolsPath] }),
  );
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'ontos-compiled-cors-'));
  try {
    const entry = path.join(temporaryRoot, 'reader.ts');
    await writeFile(
      entry,
      `import { Schema } from 'effect';\nimport { resolvePartyRegistryShellOrigin, partyRegistryCorsAllowedOrigins } from ${JSON.stringify(path.join(partyRoot, 'api/read-server-support.ts'))};\n${reader}\nexport const allowedOrigins = partyRegistryCorsAllowedOrigins(shellOrigin);\n`,
    );
    const compiler = rspack({
      entry,
      externals: { effect: 'commonjs effect' },
      mode: 'none',
      module: {
        rules: [
          {
            test: /\.ts$/u,
            use: {
              loader: 'builtin:swc-loader',
              options: { jsc: { parser: { syntax: 'typescript' } } },
            },
          },
        ],
      },
      output: { filename: 'reader.cjs', library: { type: 'commonjs2' }, path: temporaryRoot },
      plugins: [
        new DefinePlugin(
          Object.fromEntries(
            Object.entries(globalVars).map(([key, value]) => [key, JSON.stringify(value)]),
          ),
        ),
      ],
      target: 'node',
    });
    try {
      const stats = await promisify(compiler.run.bind(compiler))();
      assert.equal(stats.hasErrors(), false, stats.toString({ all: false, errors: true }));
    } finally {
      await promisify(compiler.close.bind(compiler))();
    }
    const output = await readFile(path.join(temporaryRoot, 'reader.cjs'), 'utf-8');
    const module = { exports: {} };
    runInNewContext(output, { URL, exports: module.exports, module, require: () => ({ Schema }) });
    assert.deepEqual([...module.exports.allowedOrigins], [shellOrigin]);
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});

const normalizedGeneratedSource = async (fileName: string, source: string) => {
  const result = await format(fileName, source, { singleQuote: true, sortImports: true });
  assert.deepEqual(result.errors, []);
  return result.code.replaceAll(/^\s*\n/gmu, '');
};

test('all published scaffold formats retain lint-safe Party infrastructure parity', async () => {
  await Promise.all(
    ['esm', 'esm-node', 'cjs'].map(async (moduleFormat) => {
      const extension = moduleFormat === 'cjs' ? 'cjs' : 'js';
      const loadGenerator = (name: string) => {
        const filePath = path.join(
          generatorRoot,
          `dist/${moduleFormat}/ultramodern-workspace/${name}.${extension}`,
        );
        return moduleFormat === 'cjs' ? require(filePath) : import(pathToFileURL(filePath).href);
      };
      const { createVerticalDescriptor } = await loadGenerator('descriptors');
      const { createLayout } = await loadGenerator('demo-components');
      const { createBackendModuleFederationConfig, createAppModernConfig } = await loadGenerator(
        'module-federation/config',
      );
      const { createUltramodernBuildModule } = await loadGenerator(
        'module-federation/reexport-module',
      );
      const app = { ...createVerticalDescriptor('party-registry', 4102), exposes: {} };
      const generated = {
        'backend-federation.config.ts': createBackendModuleFederationConfig(app),
        'modern.config.ts': createAppModernConfig('app', app),
        'shared/ultramodern-build.ts': createUltramodernBuildModule('app', app),
        'src/routes/layout.tsx': createLayout(app.id),
      };
      await Promise.all(
        Object.entries(generated).map(async ([fileName, source]) => {
          const actual = await readFile(
            path.join(workspaceRoot, 'verticals/party-registry', fileName),
            'utf-8',
          );
          assert.equal(
            await normalizedGeneratedSource(fileName, source),
            await normalizedGeneratedSource(fileName, actual),
            `${moduleFormat}: ${fileName} must match the controlled scaffold`,
          );
        }),
      );
    }),
  );
});

test('API-only Party keeps executable backend tests without an obsolete component-test command', async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(workspaceRoot, 'verticals/party-registry/package.json'), 'utf-8'),
  );
  assert.equal(packageJson.scripts['test:component'], undefined);
  assert.equal(packageJson.scripts['test:unit'], 'node --test tests/unit/*.test.ts');
  assert.equal(packageJson.scripts['test:integration'], 'node --test tests/integration/*.test.ts');
  await assert.rejects(
    readFile(path.join(workspaceRoot, 'verticals/party-registry/rstest.config.ts')),
    { code: 'ENOENT' },
  );
});
const { validateApp } = await import(
  pathToFileURL(
    path.join(generatorRoot, 'templates/workspace-scripts/ultramodern-cloudflare-proof.mjs'),
  ).href
);
const { validateModuleFederationTypes } = await import(
  pathToFileURL(
    path.join(generatorRoot, 'dist/esm-node/ultramodern-workspace/mf-validation/validate.js'),
  ).href
);

const publicUrl = 'https://party.example.test';
const buildMarker = 'party-build';
const apiOnlyApp = () => ({
  deliveryUnit: { buildMarker, unitId: 'app/party-registry' },
  deploy: {
    cloudflare: {
      jsonSmokeChecks: [{ expect: { status: 'ready' }, id: 'api', route: '/api-smoke' }],
      routes: {
        apiReadiness: '/party-registry-api/party-registry/readiness',
        mfManifest: '/mf-manifest.json',
      },
      serviceBindings: [
        {
          appId: 'party-registry',
          binding: 'PARTY_WORKER',
          expectedMarker: buildMarker,
          route: '/binding',
        },
      ],
    },
  },
  i18n: { namespace: 'party-registry' },
  id: 'party-registry',
  marker: { build: buildMarker },
});

const mockPublicResponses = (context: TestContext, failedPath?: string) => {
  const requested: string[] = [];
  context.mock.method(globalThis, 'fetch', (input: string | URL) => {
    const route = new URL(String(input)).pathname;
    requested.push(route);
    if (route === failedPath) {
      return Promise.resolve(new Response('unavailable', { status: 503 }));
    }
    const body =
      route === '/mf-manifest.json'
        ? { metaData: { publicPath: `${publicUrl}/` } }
        : { marker: { build: buildMarker }, status: 'ready' };
    return Promise.resolve(
      Response.json(body, { headers: { 'access-control-allow-origin': '*' } }),
    );
  });
  return requested;
};

test('API-only proof keeps manifest, readiness, service-binding and JSON proofs without invented pages/locales', async (context) => {
  const requested = mockPublicResponses(context);
  const evidence = await validateApp(apiOnlyApp(), publicUrl);
  assert.deepEqual(requested, [
    '/mf-manifest.json',
    '/party-registry-api/party-registry/readiness',
    '/binding',
    '/api-smoke',
  ]);
  for (const proof of [
    'mf-manifest',
    'api-marker',
    'delivery-unit-api-marker',
    'service-binding-api-marker',
    'json-smoke-value',
  ]) {
    assert.ok(evidence.assertions.some((entry) => entry.type === proof && entry.status === 'pass'));
  }
  assert.equal(
    evidence.assertions.some((entry) => entry.type === 'ssr' || entry.type === 'i18n-marker'),
    false,
  );
});

for (const [route, error] of [
  ['/mf-manifest.json', /MF manifest returned HTTP 503/u],
  ['/party-registry-api/party-registry/readiness', /Effect readiness returned HTTP 503/u],
  ['/binding', /service binding PARTY_WORKER returned HTTP 503/u],
  ['/api-smoke', /JSON smoke api returned HTTP 503/u],
] as const) {
  test(`API-only proof still fails closed for ${route}`, async (context) => {
    mockPublicResponses(context, route);
    await assert.rejects(validateApp(apiOnlyApp(), publicUrl), error);
  });
}

test('full-stack declared SSR remains mandatory', async (context) => {
  const requested = mockPublicResponses(context, '/en');
  const app = apiOnlyApp();
  Object.assign(app.deploy.cloudflare.routes, {
    locale: '/locales/en/party-registry.json',
    ssr: '/en',
  });
  await assert.rejects(validateApp(app, publicUrl), /SSR route returned HTTP 503/u);
  assert.deepEqual(requested, ['/en']);
});

test('declared namespace locale remains mandatory independently of SSR', async (context) => {
  const requested = mockPublicResponses(context, '/locales/en/party-registry.json');
  const app = apiOnlyApp();
  Object.assign(app.deploy.cloudflare.routes, { locale: '/locales/en/party-registry.json' });
  await assert.rejects(validateApp(app, publicUrl), /locale JSON returned HTTP 503/u);
  assert.deepEqual(requested, ['/mf-manifest.json', '/locales/en/party-registry.json']);
});

for (const field of ['ssr', 'locale']) {
  test(`an invalid declared ${field} route cannot disable its proof`, async (context) => {
    mockPublicResponses(context);
    const app = apiOnlyApp();
    Object.assign(app.deploy.cloudflare.routes, { [field]: '' });
    await assert.rejects(
      validateApp(app, publicUrl),
      /declared .* route must be a root-relative path/u,
    );
  });
}

for (const variant of ['cjs', 'esm', 'esm-node']) {
  test(`${variant} inspector permits dts:false only with zero frontend exposes`, async () => {
    const extension = variant === 'cjs' ? 'cjs' : 'js';
    const { inspectModuleFederationConfigSource } = await import(
      pathToFileURL(
        path.join(
          generatorRoot,
          `dist/${variant}/ultramodern-workspace/mf-validation/inspect.${extension}`,
        ),
      ).href
    );
    const inspect = (source: string) =>
      inspectModuleFederationConfigSource(source, 'verticals/api', 'module-federation.config.ts');
    assert.deepEqual(
      inspect('// @ultramodern-mf no-exposes\nexport default { dts: false, exposes: {} };').dts,
      {},
    );
    assert.throws(
      () => inspect('export default { dts: false, exposes: { "./Page": "./page.tsx" } };'),
      /DTS cannot be disabled for exposed app/u,
    );
  });
}

test('MF proof accepts explicit API-only intent but keeps exposed-app archives mandatory', async (context) => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'ontos-api-only-mf-'));
  context.after(() => rm(fixture, { force: true, recursive: true }));
  const appDir = 'verticals/api';
  await mkdir(path.join(fixture, appDir), { recursive: true });
  const configPath = path.join(fixture, appDir, 'module-federation.config.ts');
  const validate = () =>
    validateModuleFederationTypes({ appDirs: [appDir], workspaceRoot: fixture });
  await writeFile(
    configPath,
    '// @ultramodern-mf no-exposes\nexport default { dts: false, exposes: {} };',
  );
  assert.equal(validate().hostOnlyAppCount, 1);
  await writeFile(configPath, 'export default { dts: false, exposes: {} };');
  assert.throws(validate, /without an explicit host-only\/no-exposes declaration/u);
  await writeFile(
    configPath,
    'export default { dts: { tsConfigPath: "./tsconfig.mf-types.json", generateTypes: { compilerInstance: "effect-tsgo" } }, exposes: { "./Page": "./page.tsx" } };',
  );
  assert.throws(validate, /Missing Module Federation DTS archive/u);
});

test('Party deployment declares no fake SSR/locale URL while retaining backend contracts', async () => {
  const topology = JSON.parse(
    await readFile(path.join(workspaceRoot, 'topology/reference-topology.json'), 'utf-8'),
  );
  const party = topology.verticals.find((entry) => entry.id === 'party-registry');
  assert.equal(party.cloudflare.routes.ssr, undefined);
  assert.equal(party.cloudflare.routes.locale, undefined);
  assert.equal(party.cloudflare.routes.mfManifest, '/mf-manifest.json');
  assert.equal(
    party.cloudflare.routes.apiReadiness,
    '/party-registry-api/party-registry/readiness',
  );
  assert.equal(
    party.backendFederation.exposes['./effect-api'].contract,
    'verticals/party-registry/shared/api.ts',
  );
  assert.equal(
    party.backendFederation.exposes['./effect-api'].openapi,
    '/party-registry-api/openapi.json',
  );
});

test('Contacts deployment public-client URLs follow internal service identity and topology ports', async () => {
  const topology = JSON.parse(
    await readFile(path.join(workspaceRoot, 'topology/reference-topology.json'), 'utf-8'),
  );
  const overlay = JSON.parse(
    await readFile(path.join(workspaceRoot, 'topology/local-overlays/development.json'), 'utf-8'),
  );
  const zerops = await readFile(path.join(workspaceRoot, 'zerops.yaml'), 'utf-8');
  const contactsSetup = zerops.split("  - setup: 'contacts'")[1]?.split('  - setup:')[0];
  assert.ok(contactsSetup);
  const shellId = topology.shell.id;
  const party = topology.verticals.find((entry) => entry.id === 'party-registry');
  const shellUrl = `http://${shellId.replaceAll('-', '')}:${overlay.ports[shellId]}/${shellId}-api`;
  const partyUrl = new URL(overlay.apis[party.id]);
  partyUrl.hostname = party.id;
  assert.ok(contactsSetup.includes(`ONTOS_SHELL_GATEWAY_BASE_URL: '${shellUrl}'`));
  assert.ok(contactsSetup.includes(`ONTOS_PARTY_REGISTRY_API_BASE_URL: '${partyUrl.href}'`));
});

test('installed Cloudflare CLI preserves API-only routes when synthesizing the real Party contract', async (context) => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'ontos-api-only-proof-'));
  context.after(() => rm(fixture, { force: true, recursive: true }));
  await mkdir(path.join(fixture, '.modernjs'));
  await writeFile(
    path.join(fixture, '.modernjs/ultramodern.json'),
    await readFile(path.join(workspaceRoot, '.modernjs/ultramodern.json')),
  );
  const build = JSON.parse(
    await readFile(
      path.join(workspaceRoot, 'verticals/party-registry/shared/ultramodern-build.json'),
      'utf-8',
    ),
  );
  const requested: string[] = [];
  const server = createServer((request, response) => {
    const route = request.url ?? '/';
    requested.push(route);
    response.setHeader('content-type', 'application/json');
    response.setHeader('access-control-allow-origin', '*');
    response.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader(
      'permissions-policy',
      'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
    );
    response.setHeader('x-robots-tag', 'noindex, nofollow');
    if (route === '/mf-manifest.json') {
      response.end(JSON.stringify({ metaData: { publicPath: `http://${request.headers.host}/` } }));
    } else if (route === '/party-registry-api/party-registry/readiness') {
      response.end(
        JSON.stringify({
          checks: { api: 'ready', moduleFederation: 'ready', ssr: 'ready' },
          marker: { build: build.deliveryUnit.buildMarker },
          status: 'ready',
        }),
      );
    } else {
      response.statusCode = 404;
      response.end(JSON.stringify({ error: 'No owner route or locale exists' }));
    }
  });
  context.after(() => promisify(server.close.bind(server))());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Number }))(
    server.address(),
  );
  const reportPath = path.join(fixture, 'proof.json');
  await promisify(execFile)(
    process.execPath,
    [
      path.join(generatorRoot, 'templates/workspace-scripts/proof-cloudflare-version.mjs'),
      '--app',
      'party-registry',
      '--require-public-urls',
      '--out',
      reportPath,
    ],
    {
      env: {
        ...process.env,
        ULTRAMODERN_PUBLIC_URL_PARTY_REGISTRY: `http://127.0.0.1:${address.port}`,
        ULTRAMODERN_WORKSPACE_ROOT: fixture,
      },
    },
  );
  assert.deepEqual(requested, [
    '/mf-manifest.json',
    '/party-registry-api/party-registry/readiness',
    '/party-registry-api/party-registry/readiness',
  ]);
  const report = JSON.parse(await readFile(reportPath, 'utf-8'));
  assert.equal(report.status, 'pass');
  assert.equal(report.results[0].appId, 'party-registry');
  assert.ok(report.results[0].assertions.every((entry) => entry.status === 'pass'));
});
