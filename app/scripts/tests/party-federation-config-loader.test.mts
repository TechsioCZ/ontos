import { fileURLToPath, pathToFileURL } from 'node:url';

import { NodeServices } from '@effect/platform-node';
import { presetUltramodernWorkspace } from '@modern-js/ultramodern-app-tools';
import { Effect, FileSystem, Schema } from 'effect';
import { expect, it, rstest } from 'effect-rstest';
import { ChildProcess } from 'effect/process';

import { createWorkspaceModernConfig } from '../../packages/shared-contracts/tooling/modern-config.ts';
import { PARTY_REGISTRY_REQUEST_IDENTITY } from '../../packages/party-registry-identity-contracts/src/database-identity-data.ts';
import { collectToolingProcess } from './tooling-process-fixture.mts';

rstest.mock('@modern-js/app-tools-extensions/config', () => ({
  getBuildConfigEnvironment: rstest.fn<(name: string) => string | undefined>(),
  resolveDeployTarget: () => ({ explicit: true, target: 'node' }),
}));

const workspaceRoot = fileURLToPath(new URL('../..', import.meta.url));
const partyDirectory = 'verticals/party-registry';
const configFiles = ['module-federation.config.ts', 'backend-federation.config.ts'];
const LoadedConfigSchema = Schema.Struct({
  exposes: Schema.Record(Schema.String, Schema.String),
  filename: Schema.String,
  name: Schema.String,
  shared: Schema.Record(Schema.String, Schema.Struct({ requiredVersion: Schema.String, singleton: Schema.Boolean })),
});

// Use Party's installed MF package, whose getMFConfig owns the synchronous Jiti loader.
// A native import or Modern's generic config loader would miss this build-time boundary.
const probe = `
import { createRequire } from 'node:module';
import path from 'node:path';
const party = path.resolve('${partyDirectory}');
const require = createRequire(path.join(party, 'package.json'));
const { getMFConfig } = require('@module-federation/modern-js-v3/config-plugin');
const configs = [];
for (const file of process.argv.slice(1)) {
  const config = await getMFConfig({ configPath: path.join(party, file) });
  configs.push({
    name: config.name,
    filename: config.filename,
    exposes: config.exposes,
    shared: config.shared,
  });
}
process.stdout.write(JSON.stringify(configs));
`;

it.live(
  'Party federation configs keep package-version decoding behind the Schema-only import',
  Effect.fn(function* schemaImportBoundary() {
    const fs = yield* FileSystem.FileSystem;
    for (const file of configFiles) {
      const source = yield* fs.readFileString(`${workspaceRoot}/${partyDirectory}/${file}`);
      expect(source, file).toMatch(/import \* as Schema from ['"]effect\/Schema['"]/u);
      expect(source, file).not.toMatch(/from\s*['"]effect['"]/u);
    }
  }, Effect.provide(NodeServices.layer)),
);

it.live(
  'the published Module Federation Jiti loader imports both actual Party configs',
  Effect.fn(
    function* publishedFederationConfigLoader() {
      const result = yield* collectToolingProcess(
        ChildProcess.make(process.execPath, ['--input-type=module', '--eval', probe, ...configFiles], {
          cwd: workspaceRoot,
          extendEnv: true,
          stderr: 'pipe',
          stdin: 'ignore',
          stdout: 'pipe',
        }),
      );
      expect(result.status, result.stderr).toBe(0);
      const configs = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(LoadedConfigSchema)))(result.stdout);
      expect(configs).toMatchObject([
        {
          exposes: {
            './PageContacts': './src/routes/[lang]/contacts/page.tsx',
            './PageCustomers': './src/routes/[lang]/prodej/zakaznici/page.tsx',
          },
          filename: 'remoteEntry.js',
          name: 'verticalPartyRegistry',
          shared: { react: { singleton: true } },
        },
        {
          exposes: { './effect-api': './api/effect-api.ts' },
          filename: 'backendRemoteEntry.cjs',
          name: 'verticalPartyRegistryBackend',
          shared: { effect: { singleton: true } },
        },
      ]);
    },
    Effect.scoped,
    Effect.provide(NodeServices.layer),
  ),
);

it.layer(NodeServices.layer)('Party development discovery', (suite) => {
  // Compose the actual development fragment with the native preset; i18n stands behind its middleware.
  suite.effect('serves the generated OntOS module contract before i18n redirects in development', () =>
    Effect.gen(function* developmentContractRouting() {
      const fs = yield* FileSystem.FileSystem;
      const modernConfigUrl = new URL('../../verticals/party-registry/modern.config.ts', import.meta.url);
      const modernConfigSource = yield* fs.readFileString(fileURLToPath(modernConfigUrl));
      expect(modernConfigSource).toMatch(
        /createWorkspaceModernConfig\(\{\s*appId,\s*cloudflareHyperdrives: \[[^\]]+\],\s*moduleUrl: import\.meta\.url,/u,
      );
      expect(modernConfigSource).toContain('presetUltramodernWorkspace(');
      expect(modernConfigSource).toMatch(/ignoreRedirectRoutes: \[\s*'\/\.well-known'/u);

      const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'party-contract-routing-' });
      yield* fs.makeDirectory(`${directory}/.dev-public/.well-known`, { recursive: true });
      const artifacts = [
        { body: '{"moduleKey":"party.registry"}', path: '/.well-known/ontos-module-manifest.json' },
        { body: '{"tools":[]}', path: '/.well-known/ontos-module-mcp-tools.json' },
      ];
      for (const artifact of artifacts) {
        yield* fs.writeFileString(`${directory}/.dev-public${artifact.path}`, artifact.body);
      }
      const authored = createWorkspaceModernConfig({
        appId: 'party-registry',
        cloudflareHyperdrives: [PARTY_REGISTRY_REQUEST_IDENTITY.cloudflareHyperdrive],
        moduleUrl: pathToFileURL(`${directory}/modern.config.ts`).href,
      });
      const native = presetUltramodernWorkspace(
        { dev: authored.dev, server: authored.server },
        {
          appId: 'party-registry',
          deployTarget: 'node',
          environment: {},
          from: modernConfigUrl,
        },
      );
      expect(authored.dev.setupMiddlewares).toHaveLength(1);
      expect(native.dev?.setupMiddlewares).toEqual(authored.dev.setupMiddlewares);
      expect(native.server?.publicDir).toEqual(expect.arrayContaining(['./locales', './assets', './.dev-public']));

      const localeRedirect = rstest.fn(
        (
          _request: { url?: string | undefined },
          _response: { end: (body: Buffer) => void; setHeader: (name: string, value: string) => void },
          next: () => void,
        ) => {
          next();
        },
      );
      const middlewares: ((...args: Parameters<typeof localeRedirect>) => void)[] = [localeRedirect];
      for (const setup of authored.dev.setupMiddlewares) {
        setup({
          unshift: (middleware) => {
            middlewares.unshift(middleware);
          },
        });
      }
      expect(middlewares.at(-1)).toBe(localeRedirect);
      for (const artifact of artifacts) {
        for (const suffix of ['', '?cache=refresh']) {
          const headers = new Map<string, string>();
          let body = '';
          const response = {
            end: (value: Buffer) => {
              body = value.toString('utf-8');
            },
            setHeader: (name: string, value: string) => {
              headers.set(name, value);
            },
          };
          const next = rstest.fn<() => void>();
          middlewares[0]?.({ url: `${artifact.path}${suffix}` }, response, next);
          expect(body).toBe(artifact.body);
          expect(headers.get('Content-Type')).toBe('application/json');
          expect(headers.get('Cache-Control')).toBe('no-cache');
          expect(headers.get('Content-Length')).toBe(String(Buffer.byteLength(artifact.body)));
          expect(next).not.toHaveBeenCalled();
          expect(localeRedirect).not.toHaveBeenCalled();
        }
      }
      for (const url of [
        undefined,
        '/cs/prodej/zakaznici',
        '/.well-known/other.json',
        '/.well-known/ontos-module-manifest.json/extra',
      ]) {
        const response = {
          end: rstest.fn<(body: Buffer) => void>(),
          setHeader: rstest.fn<(name: string, value: string) => void>(),
        };
        const next = rstest.fn<() => void>();
        middlewares[0]?.({ url }, response, next);
        expect(next).toHaveBeenCalledOnce();
        expect(response.end).not.toHaveBeenCalled();
        expect(response.setHeader).not.toHaveBeenCalled();
      }
    }).pipe(Effect.scoped),
  );
});
