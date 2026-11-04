import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { buildKnipModel, KnipConfigSchema } from '../../quality-audit/knip-model.mts';
import { runQualityAudit } from '../quality-audit.mts';
import { runPinnedKnip } from './quality-audit-test-support.mts';

const rspackPackageName = '@rspack/core';
const fixtureModuleSource = 'module.exports = {};';
const packageFile = 'package.json';
const requirePrelude = [
  "import { createRequire } from 'node:module';",
  'const require = createRequire(import.meta.url);',
];
const resolverFile = 'src/resolver.ts';
const directFile = 'src/direct.ts';
const configurationFiles = '*.config.ts';
const toolsPattern = 'tools/**/*.{ts,mts}';
const sourcePattern = 'src/**/*.{ts,mts}';
const allTypedSourcePattern = '**/*.{ts,mts}';
const knipManifestFile = 'node_modules/knip/package.json';
const indexFile = 'src/index.ts';
const rstestConfigFile = 'rstest.config.ts';
const auditConsumersFile = '.audit/consumers.mts';
const rstestEnvironmentReason = 'Rstest testEnvironment consumer';
const appRoot = path.resolve(import.meta.dirname, '../..');
const nativeRoutesWorkspace = 'apps/native-routes';
const nativeRoutesRoot = `${nativeRoutesWorkspace}/src/routes/[lang]`;
const nodeExecutableExpression = 'process.execPath';
const unknownCwdCase = 'unknown-cwd';
const shadowDriverCase = 'shadow-driver';
const mutableCwdCase = 'mutable-cwd';
const nativeChildNamespaceImport = "import * as child from 'node:child_process';";
const loaderLateCase = 'loader-late';
const nativePathImport = "import paths from 'node:path';";
const nativeEffectProcessImport = "import { ChildProcess as Process } from 'effect/process';";
const sourceScriptsPattern = 'scripts/**/*.mts';
const esbuildRootDeclaration = "const rootDirectory = paths.resolve(import.meta.dirname, '..', '..', '..', '..');";
const esbuildCwdOptions = '{ cwd: rootDirectory }';
const nativeSubprocessReason = 'Native Node subprocess';
const nativePlaywrightReason = 'Native Playwright webServer.command';
const playwrightPackageName = '@playwright/test';
const playwrightConfigFile = 'playwright.config.ts';
const playwrightImportSource = `import { defineConfig } from '${playwrightPackageName}';`;
const playwrightConfigSource = (server: string) =>
  `${playwrightImportSource}\nexport default defineConfig({ webServer: ${server} });`;
const scriptArgument = (name: string) => `paths.resolve('../../scripts/${name}.fixture.mts')`;
const nativeInvocation = (name: string, executable = nodeExecutableExpression, options = '{}') =>
  `execute(${executable}, ['--experimental-strip-types', ${scriptArgument(name)}], ${options});`;
const esbuildInvocation = (
  file: string,
  options = esbuildCwdOptions,
  executable = "'mise'",
  prefix = "'exec', '--', 'pnpm', 'exec', 'esbuild'",
) =>
  `Process.make(${executable}, [${prefix}, '${file}', '--bundle', '--platform=node', '--format=esm', '--packages=external', '--outfile=/tmp/generated.mjs'], ${options});`;
const Names = Schema.Array(Schema.Struct({ name: Schema.String }));
const ReportSchema = Schema.Struct({
  issues: Schema.Array(
    Schema.Struct({
      dependencies: Names,
      devDependencies: Names,
      exports: Names,
      file: Schema.String,
      files: Names,
      types: Names,
      unlisted: Names,
    }),
  ),
});
const unusedDevDependencies = (report: typeof ReportSchema.Type, file: string): readonly string[] =>
  report.issues.find((issue) => issue.file === file)?.devDependencies.map((finding) => finding.name) ?? [];
const stringify = (value: Schema.Json) =>
  Effect.gen(function* testEffect1() {
    return yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(value);
  });
const write = (root: string, file: string, source: string) => {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), source);
};

const fixture = () =>
  Effect.gen(function* testEffect2() {
    const root = yield* Effect.acquireRelease(
      Effect.sync(() => mkdtempSync(path.join(tmpdir(), 'ontos-knip-model-'))),
      (directory) => Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
    ).pipe(Effect.map((directory) => realpathSync(directory)));
    symlinkSync(path.join(appRoot, 'node_modules'), path.join(root, 'node_modules'), 'dir');
    write(
      root,
      packageFile,
      yield* stringify({
        dependencies: {
          'drizzle-orm': '1.0.0-rc.4',
          effect: '4.0.0-beta.107',
          jose: '6.2.5',
        },
        name: 'knip-consumer-controls',
        private: true,
        type: 'module',
        workspaces: ['verticals/*', 'packages/*'],
      }),
    );
    write(
      root,
      indexFile,
      [
        "import { used } from './helper.ts';",
        "console.log(used, new URL('./worker.mts', import.meta.url));",
        "void import('declaredRemote/Public');",
        "void import('misspelledRemote/Public');",
        "void import('shadowedRemote/Public');",
        "void import('./resolver.ts'); void import('./direct.ts'); void import('./own-resolver.ts');",
      ].join('\n'),
    );
    const resolverOwner = '.resolver-fixture/node_modules/owner';
    const resolverTarget = `${resolverOwner}/node_modules/@rspack/core`;
    write(
      root,
      `${resolverOwner}/package.json`,
      yield* stringify({
        dependencies: { [rspackPackageName]: '1.0.0' },
        main: 'index.js',
        name: 'fixture-owner',
      }),
    );
    write(root, `${resolverOwner}/index.js`, fixtureModuleSource);
    write(root, `${resolverTarget}/package.json`, yield* stringify({ main: 'index.js', name: rspackPackageName }));
    write(root, `${resolverTarget}/index.js`, fixtureModuleSource);
    const resolverAnchor = path.join(root, resolverOwner, 'index.js');
    write(
      root,
      resolverFile,
      [...requirePrelude, `require.resolve('@rspack/core', { paths: [${JSON.stringify(resolverAnchor)}] });`].join(
        '\n',
      ),
    );
    write(
      root,
      'src/own-resolver.ts',
      [...requirePrelude, `require.resolve('oxc-parser', { paths: [${JSON.stringify(root)}] });`].join('\n'),
    );
    write(
      root,
      'verticals/remote/package.json',
      yield* stringify({
        dependencies: { 'drizzle-orm': '1.0.0-rc.4', effect: '4.0.0-beta.107' },
        exports: {
          './outbox/commerce-remote-published-v1': './shared/outbox/commerce-remote-published-v1.ts',
        },
        name: '@app/remote',
        private: true,
        type: 'module',
        'zephyr:dependencies': { composed: 'drizzle-orm@workspace:*' },
      }),
    );
    write(
      root,
      'verticals/remote/src/index.ts',
      [
        "import { publishAction } from './actions/publish.action.ts';",
        "import { remoteApi } from '../shared/api.ts';",
        'void publishAction; void remoteApi;',
        "void import('childRemote/Public'); void import('misspelledChild/Public'); void import('declaredRemote/Public');",
      ].join('\n'),
    );
    write(
      root,
      'verticals/remote/shared/actions/publish.ts',
      'export const PublishPayloadSchema = 1; export type PublishPayload = string;',
    );
    write(
      root,
      'verticals/remote/shared/outbox/commerce-remote-published-v1.ts',
      [
        '// @generated by OntOS Codesmith Outbox Message Contract v1',
        'export const OutboxPayloadSchema = 1;',
        'export type OutboxPayload = string;',
        "export const outboxProducerModuleKey = 'remote';",
        "export const outboxTopic = 'commerce.remote.published.v1';",
      ].join('\n'),
    );
    write(
      root,
      'verticals/remote/src/actions/publish-commerce-remote-published-v1.outbox-message.ts',
      [
        '// @generated by OntOS Codesmith Outbox Message v2',
        '// @ontos-outbox-action remote.publish',
        '// @ontos-outbox-topic commerce.remote.published.v1',
        "import { outboxProducerModuleKey, outboxTopic } from '@app/remote/outbox/commerce-remote-published-v1';",
        "import type { OutboxPayload } from '@app/remote/outbox/commerce-remote-published-v1';",
        "export { OutboxPayloadSchema as PublishCommerceRemotePublishedV1OutboxPayloadSchema, outboxProducerModuleKey as PublishCommerceRemotePublishedV1OutboxProducerModuleKey, outboxTopic as PublishCommerceRemotePublishedV1OutboxTopic } from '@app/remote/outbox/commerce-remote-published-v1';",
        "export type { OutboxPayload as PublishCommerceRemotePublishedV1OutboxPayload } from '@app/remote/outbox/commerce-remote-published-v1';",
        'export const createPublishCommerceRemotePublishedV1OutboxMessage = (payload: OutboxPayload) => ({ payload, outboxProducerModuleKey, outboxTopic });',
      ].join('\n'),
    );
    write(
      root,
      'verticals/remote/src/actions/publish.action.ts',
      [
        '// @generated by OntOS Codesmith Action v1',
        '// @ontos-action-owner remote',
        '// @ontos-action-slug publish',
        "import { createPublishCommerceRemotePublishedV1OutboxMessage } from './publish-commerce-remote-published-v1.outbox-message.ts';",
        "export { PublishPayloadSchema } from '../../shared/actions/publish.ts';",
        "export type { PublishPayload } from '../../shared/actions/publish.ts';",
        'export const publishAction = createPublishCommerceRemotePublishedV1OutboxMessage;',
        'export const unusedActionNeighbor = 1;',
        '// <generated-outbox-message-exports>',
        "export { createPublishCommerceRemotePublishedV1OutboxMessage } from './publish-commerce-remote-published-v1.outbox-message.ts';",
        "export { PublishCommerceRemotePublishedV1OutboxPayloadSchema } from './publish-commerce-remote-published-v1.outbox-message.ts';",
        "export { PublishCommerceRemotePublishedV1OutboxProducerModuleKey } from './publish-commerce-remote-published-v1.outbox-message.ts';",
        "export { PublishCommerceRemotePublishedV1OutboxTopic } from './publish-commerce-remote-published-v1.outbox-message.ts';",
        "export type { PublishCommerceRemotePublishedV1OutboxPayload } from './publish-commerce-remote-published-v1.outbox-message.ts';",
        '// </generated-outbox-message-exports>',
      ].join('\n'),
    );
    write(
      root,
      'verticals/remote/shared/api.ts',
      "import { RemoteStatusApi } from './apis/remote-status.ts'; export const remoteApi = RemoteStatusApi;",
    );
    write(
      root,
      'verticals/remote/shared/apis/remote-status.ts',
      [
        '// @generated by OntOS Codesmith module-api v1',
        'export const RemoteStatusRequestSchema = 1;',
        'export type RemoteStatusRequest = string;',
        'export const RemoteStatusResponseSchema = 1;',
        'export type RemoteStatusResponse = string;',
        'export const RemoteStatusApi = 1;',
        'export const unusedModuleApiNeighbor = 1;',
      ].join('\n'),
    );
    write(
      root,
      'verticals/remote/src/api/action-gateway.ts',
      [
        '// @generated by OntOS Codesmith MicroVertical Action Boundary v1',
        "export const ACTION_GATEWAY_AUDIENCE = 'remote' as const;",
        'export const makeOperationGateway = () => ACTION_GATEWAY_AUDIENCE;',
        'export const operationGateway = makeOperationGateway();',
        'export const unusedGatewayNeighbor = 1;',
      ].join('\n'),
    );
    write(
      root,
      'verticals/remote/api/auth/action-principal.ts',
      [
        '// @generated by OntOS Codesmith MicroVertical Action Boundary v1',
        '// @ontos-action-boundary-owner remote',
        '// @ontos-action-boundary-audience remote',
        'export const ACTION_PRINCIPAL_BEARER_CHALLENGE = 1;',
        'export const ActionPrincipalConfigurationErrorSchema = 1;',
        'export const ActionPrincipalExpiredErrorSchema = 1;',
        'export const ActionPrincipalInvalidErrorSchema = 1;',
        'export const ActionPrincipalMissingErrorSchema = 1;',
        'export const ActionPrincipalScopeErrorSchema = 1;',
        'export const ActionPrincipalUnavailableErrorSchema = 1;',
        'export type ActionPrincipalConfigurationError = string;',
        'export type ActionPrincipalError = string;',
        'export type ActionPrincipalExpiredError = string;',
        'export type ActionPrincipalInvalidError = string;',
        'export type ActionPrincipalMissingError = string;',
        'export type ActionPrincipalScopeError = string;',
        'export type ActionPrincipalUnavailableError = string;',
        'export const ACTION_GATEWAY_AUDIENCE = 1;',
        'export const ActionPrincipalVerifier = 1;',
        'export const ActionPrincipalVerifierLive = 1;',
        'export type ActionPrincipalVerificationOptions = string;',
        'export const verifyActionPrincipal = 1;',
        'export const authenticateOperationPrincipal = 1;',
        'export const unusedPrincipalNeighbor = 1;',
      ].join('\n'),
    );
    write(
      root,
      'verticals/remote/module-federation.config.ts',
      "export default {remotes: {childRemote:'child@https://example.test/remote.js'}};",
    );
    write(root, 'tools/oxlint/effect-native/report.mts', "runOxlint(join(pluginDirectory, 'report.config.ts'), []);");
    write(
      root,
      'tools/oxlint/effect-native/report.config.ts',
      'export default {}; export const unusedConfigNeighbor = 3;',
    );
    write(root, directFile, "import '@rspack/core';");
    write(root, 'src/helper.ts', 'export const used = 1; export const unusedNeighbor = 2;');
    write(root, 'src/worker.mts', 'console.log("worker"); export const unusedWorkerExport = 3;');
    write(root, 'src/dead.ts', 'export const genuinelyDead = 1;');
    write(root, 'src/public.ts', 'export const externallyConsumed = 1;');
    write(
      root,
      'src/schema.ts',
      [
        "import { pgSchema } from 'drizzle-orm/pg-core';",
        "export const registeredSchema = pgSchema('registered');",
        'export const unregisteredHelper = () => 7;',
      ].join('\n'),
    );
    write(
      root,
      'module-federation.config.ts',
      [
        "throw new Error('configuration must never execute');",
        "const remotes = { declaredRemote: 'remote@https://example.test/remote.js' };",
        "function shadow() { const remotes = { shadowedRemote: 'wrong' }; return remotes; }",
        'export default {',
        'remotes,',
        "shared: { effect: { singleton: true } }, exposes: { './Public': './src/public.ts' } };",
      ].join('\n'),
    );
    write(
      root,
      'drizzle.config.ts',
      "throw new Error('configuration must never execute'); export default { schema: './src/schema.ts' };",
    );
    return root;
  });

it.live(
  'native Modern route generation proves paired client loaders and splat defaults without hiding neighbors',
  Effect.fn(function* nativeModernRouteConsumers() {
    const root = yield* fixture();
    const packagePath = `${nativeRoutesWorkspace}/package.json`;
    const manifest = '{"name":"@fixture/native-routes","dependencies":{"@modern-js/runtime":"*"}}';
    write(root, packagePath, manifest);
    const configPath = `${nativeRoutesWorkspace}/modern.config.ts`;
    const configSource = "import { defineConfig } from '@modern-js/app-tools'; export default defineConfig({});";
    write(root, configPath, configSource);
    for (const component of ['page', 'layout', '$']) {
      write(
        root,
        `${nativeRoutesRoot}/${component}.tsx`,
        'export default function Page() { return null; } export const unusedComponentNeighbor = 1;',
      );
      write(root, `${nativeRoutesRoot}/${component}.data.ts`, 'export const loader = () => 1;');
      write(
        root,
        `${nativeRoutesRoot}/${component}.data.client.ts`,
        'export const loader = () => 1; export const unusedLoaderNeighbor = 1;',
      );
    }
    const invalidFiles = [
      `${nativeRoutesRoot}/orphan/page.data.client.ts`,
      `${nativeRoutesRoot}/not-page.data.client.ts`,
      `${nativeRoutesRoot}/page.data.clients.ts`,
      `${nativeRoutesWorkspace}/src/components/page.data.client.ts`,
    ];
    for (const file of invalidFiles) {
      write(root, file, 'export const loader = () => 1;');
    }
    const nativeGenerator = path.join(
      appRoot,
      'apps/shell-super-app/node_modules/@modern-js/runtime/dist/cjs/router/cli/code/nestedRoutes.js',
    );
    const generated = spawnSync(
      process.execPath,
      [
        '-e',
        `const { walk } = require(process.argv[1]);
walk({ dirname: process.argv[2], rootDir: process.argv[2], entryName: 'index', isMainEntry: true }).then((route) => {
  const pending = Array.isArray(route) ? [...route] : [route];
  const components = [];
  const clients = [];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current.component) components.push(current.component);
    if (current.clientData) clients.push(current.clientData);
    pending.push(...(current.children || []));
  }
  process.stdout.write(JSON.stringify({ components, clients }));
}, (error) => { process.stderr.write(String(error)); process.exitCode = 1; });`,
        nativeGenerator,
        path.join(root, nativeRoutesRoot),
      ],
      { encoding: 'utf-8', timeout: 30_000 },
    );
    expect(generated.status, generated.stderr).toBe(0);
    const native = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(
        Schema.Struct({ clients: Schema.Array(Schema.String), components: Schema.Array(Schema.String) }),
      ),
    )(generated.stdout);
    expect(native.components).toContain(path.join(root, `${nativeRoutesRoot}/$.tsx`));
    for (const component of ['page', 'layout', '$']) {
      expect(native.clients).toContain(path.join(root, `${nativeRoutesRoot}/${component}.data.client`));
    }
    const consumerPath = path.join(root, auditConsumersFile);
    const base = {
      workspaces: {
        '.': { entry: [], node: false, project: [] },
        'apps/*': {
          entry: ['modern.config.ts', 'src/routes/**/{page,layout}.tsx', 'src/routes/**/*.data.ts'],
          node: false,
          project: ['**/*.{ts,tsx}'],
        },
      },
    };
    const model = yield* buildKnipModel(root, base, consumerPath).pipe(Effect.provide(NodeServices.layer));
    const run = yield* runPinnedKnip(root, consumerPath, model).pipe(Effect.provide(NodeServices.layer));
    expect(run.status, run.stderr).toBe(1);
    const report = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ReportSchema))(run.stdout);
    const unusedFiles = report.issues.flatMap((issue) => issue.files.map((finding) => finding.name));
    for (const file of invalidFiles) {
      expect(unusedFiles).toContain(file);
    }
    for (const component of ['page', 'layout', '$']) {
      const clientFile = `${nativeRoutesRoot}/${component}.data.client.ts`;
      expect(unusedFiles).not.toContain(clientFile);
      const exports = report.issues.find((issue) => issue.file === clientFile)?.exports.map((finding) => finding.name);
      expect(exports).toContain('unusedLoaderNeighbor');
      expect(exports).not.toContain('loader');
    }
    const splatExports = report.issues
      .find((issue) => issue.file === `${nativeRoutesRoot}/$.tsx`)
      ?.exports.map((finding) => finding.name);
    expect(splatExports).toContain('unusedComponentNeighbor');
    expect(splatExports).not.toContain('default');
    for (const source of [
      `/* ${configSource} */ export default {};`,
      "import { defineConfig } from '@modern-js/app-tools'; void defineConfig; export default {};",
      configSource,
    ]) {
      write(root, configPath, source);
      if (source === configSource) {
        write(root, packagePath, '{"name":"@fixture/native-routes"}');
      }
      const disconnected = yield* buildKnipModel(root, base, consumerPath).pipe(Effect.provide(NodeServices.layer));
      expect(disconnected.evidence.some((fact) => fact.reason.startsWith('Modern native'))).toBe(false);
    }
  }),
);

it.live(
  'native Playwright webServer commands consume only proven process sources and retain neighboring findings',
  Effect.fn(function* nativePlaywrightConsumers() {
    const root = yield* fixture();
    write(root, packageFile, '{"name":"playwright-controls","type":"module","workspaces":["apps/*"]}');
    const workspace = 'apps/native-playwright';
    const manifestFile = `${workspace}/${packageFile}`;
    const configFile = `${workspace}/${playwrightConfigFile}`;
    const fixtureFile = 'tests/e2e/composition-fixture.mts';
    const neighborFile = 'tests/e2e/unrelated.mts';
    const unusedNeighbor = 'unusedFixtureNeighbor';
    const manifest = {
      devDependencies: { [playwrightPackageName]: '*' },
      name: '@fixture/native-playwright',
      scripts: { 'test:e2e': 'playwright test' },
      type: 'module',
    };
    const manifestSource = yield* stringify(manifest);
    write(root, manifestFile, manifestSource);
    write(root, `${workspace}/${fixtureFile}`, `export const ${unusedNeighbor} = 1;`);
    write(root, `${workspace}/${neighborFile}`, 'export const unused = 1;');
    write(root, `${workspace}/--fixture.mts`, 'export const unusedOption = 1;');
    // Parse the real native configuration without evaluating its environment or starting servers.
    const actualSource = readFileSync(path.join(appRoot, 'apps/shell-super-app', playwrightConfigFile), 'utf-8');
    write(root, configFile, actualSource);
    const consumerPath = path.join(root, auditConsumersFile);
    const base = {
      workspaces: {
        '.': { entry: [], node: false, project: [] },
        'apps/*': {
          entry: [playwrightConfigFile],
          node: false,
          playwright: { config: [], entry: ['tests/**/*.spec.ts'] },
          project: [allTypedSourcePattern],
        },
      },
    };
    const native = yield* runPinnedKnip(root, consumerPath, { config: base, consumerSource: '' }).pipe(
      Effect.provide(NodeServices.layer),
    );
    expect(native.status, native.stderr).toBe(1);
    const nativeReport = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ReportSchema))(native.stdout);
    expect(nativeReport.issues.flatMap((issue) => issue.files.map((finding) => finding.name))).toContain(
      `${workspace}/${fixtureFile}`,
    );
    const modeled = yield* buildKnipModel(root, base, consumerPath).pipe(Effect.provide(NodeServices.layer));
    const processSources = modeled.evidence.filter((fact) => fact.reason.startsWith(nativePlaywrightReason));
    expect(processSources.map((fact) => ({ owner: fact.owningManifest, target: fact.target }))).toEqual([
      { owner: manifestFile, target: fixtureFile },
    ]);
    const run = yield* runPinnedKnip(root, consumerPath, modeled).pipe(Effect.provide(NodeServices.layer));
    expect(run.status, run.stderr).toBe(1);
    const report = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ReportSchema))(run.stdout);
    const unusedFiles = report.issues.flatMap((issue) => issue.files.map((finding) => finding.name));
    expect(unusedFiles).not.toContain(`${workspace}/${fixtureFile}`);
    expect(unusedFiles).toContain(`${workspace}/${neighborFile}`);
    expect(
      report.issues
        .find((issue) => issue.file === `${workspace}/${fixtureFile}`)
        ?.exports.map((finding) => finding.name),
    ).toContain(unusedNeighbor);

    for (const server of [
      `{ command: 'node --experimental-strip-types ${fixtureFile}' }`,
      "{ command: 'node composition-fixture.mts', cwd: 'tests/e2e' }",
    ]) {
      write(root, configFile, playwrightConfigSource(server));
      const positive = yield* buildKnipModel(root, base, consumerPath).pipe(Effect.provide(NodeServices.layer));
      expect(
        positive.evidence.filter((fact) => fact.reason.startsWith(nativePlaywrightReason)).map((fact) => fact.target),
      ).toEqual([fixtureFile]);
    }
    const command = `node ${fixtureFile}`;
    const newlineCommand = JSON.stringify(`node\n${fixtureFile}`);
    const invalidConfigurations = [
      `export default { webServer: { command: '${command}' } };`,
      `const defineConfig = (value) => value; export default defineConfig({ webServer: { command: '${command}' } });`,
      `import { defineConfig } from './counterfeit.ts'; export default defineConfig({ webServer: { command: '${command}' } });`,
      `import type { defineConfig } from '${playwrightPackageName}'; export default defineConfig({ webServer: { command: '${command}' } });`,
      `${playwrightImportSource} defineConfig = (value) => value; export default defineConfig({ webServer: { command: '${command}' } });`,
      `${playwrightImportSource} const alias = defineConfig; export default alias({ webServer: { command: '${command}' } });`,
      `${playwrightImportSource} export default defineConfig(factory({ webServer: { command: '${command}' } }));`,
      `${playwrightImportSource} export default defineConfig({ webServer: { command: '${command}' }, ...unknown });`,
      `${playwrightImportSource} export default defineConfig({ webServer: { command: '${command}' }, webServer: {} });`,
      playwrightConfigSource(`{ command: '${command}', command: 'printf ${fixtureFile}' }`),
      playwrightConfigSource(`{ ['command']: '${command}' }`),
      playwrightConfigSource(`{ get command() { return '${command}'; } }`),
      playwrightConfigSource(`{ command: '${command}', ...unknown }`),
      `${playwrightImportSource} const command = '${command}'; export default defineConfig({ webServer: { command } });`,
      playwrightConfigSource(`{ command: 'printf ${fixtureFile}' }`),
      playwrightConfigSource(`{ command: 'node -e ${fixtureFile}' }`),
      playwrightConfigSource('{ command: "node --fixture.mts" }'),
      playwrightConfigSource(`{ command: ${newlineCommand} }`),
      playwrightConfigSource(`{ command: '${command} && echo ready' }`),
      playwrightConfigSource(`{ command: '${command} data.mts' }`),
      playwrightConfigSource(`{ command: '${command}', cwd: unknownDirectory }`),
      playwrightConfigSource(`{ command: '${command}', cwd: '.', cwd: 'elsewhere' }`),
      playwrightConfigSource(`{ command: 'node ../${fixtureFile}' }`),
      playwrightConfigSource(`[{ command: '${command}' }, ...unknownServers]`),
    ];
    for (const source of invalidConfigurations) {
      write(root, configFile, source);
      const rejected = yield* buildKnipModel(root, base, consumerPath).pipe(Effect.provide(NodeServices.layer));
      expect(
        rejected.evidence.some((fact) => fact.reason.startsWith(nativePlaywrightReason)),
        source,
      ).toBe(false);
    }
    write(root, configFile, actualSource);
    for (const owner of [
      { ...manifest, devDependencies: {} },
      { ...manifest, scripts: { 'test:e2e': 'printf playwright test' } },
      { ...manifest, scripts: { 'test:e2e': 'playwright\ntest' } },
      { ...manifest, scripts: { 'test:e2e': 'playwright test --config foreign.config.ts' } },
    ]) {
      write(root, manifestFile, yield* stringify(owner));
      const rejected = yield* buildKnipModel(root, base, consumerPath).pipe(Effect.provide(NodeServices.layer));
      expect(rejected.evidence.some((fact) => fact.reason.startsWith(nativePlaywrightReason))).toBe(false);
    }
    write(root, manifestFile, manifestSource);
    write(root, configFile, 'export default {};');
    write(root, `${workspace}/tests/${playwrightConfigFile}`, actualSource);
    const foreignConfig = yield* buildKnipModel(root, base, consumerPath).pipe(Effect.provide(NodeServices.layer));
    expect(foreignConfig.evidence.some((fact) => fact.reason.startsWith(nativePlaywrightReason))).toBe(false);
  }),
);

const writeOpaqueScopeFixtures = (root: string, shell: string) => {
  const cases = [
    [
      'for-of-path',
      (invoke: string) =>
        `for (const paths of [{ resolve: () => '/different' }]) { ${esbuildRootDeclaration} ${invoke} }`,
    ],
    [
      'for-of-factory',
      (invoke: string) => `${esbuildRootDeclaration} for (const Process of [{ make() {} }]) { ${invoke} }`,
    ],
    ['for-in-path', (invoke: string) => `for (const paths in { other: {} }) { ${esbuildRootDeclaration} ${invoke} }`],
    [
      'for-path',
      (invoke: string) =>
        `for (const paths = { resolve: () => '/different' }; flag;) { ${esbuildRootDeclaration} ${invoke} }`,
    ],
    [
      'for-destructured',
      (invoke: string) =>
        `for (const { inner: paths } of [{ inner: { resolve: () => '/different' } }]) { ${esbuildRootDeclaration} ${invoke} }`,
    ],
    [
      'var-path-owner',
      (invoke: string) =>
        `function run() { if (flag) { var paths = { resolve: () => '/different' }; } ${esbuildRootDeclaration} ${invoke} } run();`,
    ],
    [
      'var-factory-owner',
      (invoke: string) =>
        `function run() { if (flag) { var Process = { make() {} }; } ${esbuildRootDeclaration} ${invoke} } run();`,
    ],
    [
      'named-function-self',
      (invoke: string) => `const run = function paths() { ${esbuildRootDeclaration} ${invoke} }; run();`,
    ],
    [
      'named-class-self',
      (invoke: string) =>
        `const Owner = class Process { static run() { ${esbuildRootDeclaration} ${invoke} } }; Owner.run();`,
    ],
    [
      'switch-path',
      (invoke: string) =>
        `switch (flag) { case true: const paths = { resolve: () => '/different' }; ${esbuildRootDeclaration} ${invoke} }`,
    ],
    [
      'free-loader-after-loop',
      (invoke: string) =>
        `function loadDependency() { for (const require of [() => ({})]) {} const load = require; load('node:path'); } loadDependency(); ${esbuildRootDeclaration} ${invoke}`,
    ],
  ] satisfies readonly (readonly [string, (invoke: string) => string])[];
  const rejected = cases.map(([name, source]) => {
    const victim = `${shell}/tests/support/opaque-${name}.ts`;
    write(root, victim, 'export const unusedOpaqueVictim = 1;');
    write(
      root,
      `${shell}/tests/integration/opaque-${name}.test.ts`,
      [nativeEffectProcessImport, nativePathImport, source(esbuildInvocation(victim))].join('\n'),
    );
    return victim;
  });
  for (const [name, declaration, invocation] of [
    [
      'argv',
      "const argv = ['exec', '--', 'pnpm', 'exec', 'esbuild', target, '--bundle'];",
      "for (const argv of [unknownArgv]) { Process.make('mise', argv, { cwd: rootDirectory }); }",
    ],
    [
      'options',
      'const options = { cwd: rootDirectory };',
      "for (const options of [unknownOptions]) { Process.make('mise', ['exec', '--', 'pnpm', 'exec', 'esbuild', target, '--bundle'], options); }",
    ],
    [
      'default-owner',
      'const start = (file = target) => Process.make(process.execPath, [file], { cwd: rootDirectory });',
      'for (const start of [() => {}]) { start(); }',
    ],
  ]) {
    const victim = `${shell}/tests/support/opaque-${name}.ts`;
    rejected.push(victim);
    write(root, victim, 'export const unusedOpaqueVictim = 1;');
    write(
      root,
      `${shell}/tests/integration/opaque-${name}.test.ts`,
      [
        nativeEffectProcessImport,
        nativePathImport,
        esbuildRootDeclaration,
        `const target = '${victim}';`,
        declaration,
        invocation,
      ].join('\n'),
    );
  }
  const unusedBootstrapSource = 'export const unusedBootstrapExport = 1;';
  const preserved = `${shell}/tests/support/valid-unrelated-loop.ts`;
  write(root, preserved, unusedBootstrapSource);
  write(
    root,
    `${shell}/tests/integration/valid-unrelated-loop.test.ts`,
    [
      nativeEffectProcessImport,
      nativePathImport,
      "for (const paths of [unknownPaths]) {} for (const Process of [unknownProcesses]) {} for (const require of [() => ({})]) { require('node:path'); }",
      esbuildRootDeclaration,
      esbuildInvocation(preserved),
    ].join('\n'),
  );
  const lexicalPositives = [
    [
      'inner-data-under-self',
      () =>
        `const run = function argv() { { const argv = ['exec', '--', 'pnpm', 'exec', 'esbuild', TARGET, '--bundle']; Process.make('mise', argv, { cwd: rootDirectory }); } }; run();`,
    ],
    [
      'switch-discriminant',
      (invoke: string) => `switch (${invoke.replace(/;$/u, '')}) { case 0: const Process = unknownProcess; break; }`,
    ],
  ] satisfies readonly (readonly [string, (invoke: string) => string])[];
  const preservedFiles = lexicalPositives.map(([name, source]) => {
    const victim = `${shell}/tests/support/valid-${name}.ts`;
    write(root, victim, unusedBootstrapSource);
    write(
      root,
      `${shell}/tests/integration/valid-${name}.test.ts`,
      [
        nativeEffectProcessImport,
        nativePathImport,
        esbuildRootDeclaration,
        source(esbuildInvocation(victim)).replace('TARGET', JSON.stringify(victim)),
      ].join('\n'),
    );
    return victim;
  });
  return { preserved: [preserved, ...preservedFiles], rejected };
};

const writeNamespaceCapabilityFixtures = (root: string, shell: string) => {
  const rejected: string[] = [];
  const bad = (name: string) => `${shell}/tests/support/${name}.ts`;
  const namespaceCases = [
    ['url-constructor-alternate', "import { URL as other } from 'node:url'; other.prototype.pathname = '/different';"],
    ['named-default-write', "import { default as other } from 'node:path'; other.resolve = () => '/different';"],
    ['named-default-escape', "import { default as other } from 'node:path'; unknownMutator(other);"],
    ['bare-default-write', "import other from 'path'; other.resolve = () => '/different';"],
    ['namespace-default-write', "import * as other from 'node:path'; other.default.resolve = () => '/different';"],
    ['protected-subpath', "import other from 'node:path/posix'; unknownMutator(other);"],
    ['dynamic-protected', "const other = await import('node:path'); other.default.resolve = () => '/different';"],
    ['dynamic-unknown', 'const other = await import(unknownModule);'],
    [
      'parameter-default-body-var',
      "function capture(load = require) { var require = () => {}; load('node:path'); } capture();",
    ],
    [
      'destructured-default-body-var',
      "function capture({ load = require } = {}) { var require = () => {}; load('node:path'); } capture();",
    ],
    [
      'rest-default-body-var',
      "function capture([load = require] = [], ...rest) { var require = () => {}; load('node:path'); } capture();",
    ],
    [
      'inner-loader-under-self',
      "import { createRequire } from 'node:module'; const capture = function require() { { const require = createRequire(import.meta.url); require('node:path'); } }; capture();",
    ],
    [
      'inner-loader-under-loop',
      "import { createRequire } from 'node:module'; for (const require of values) { { const require = createRequire(import.meta.url); require('node:path'); } }",
    ],
    [
      'inner-loader-under-var',
      "import { createRequire } from 'node:module'; function capture() { var require = () => {}; { const require = createRequire(import.meta.url); require('node:path'); } } capture();",
    ],
    ['assignment-loop-loader', "for (require of values) {} const load = require; load('node:path');"],
    [
      'destructured-assignment-loop-loader',
      "for ({ load: require } of values) {} const load = require; load('node:path');",
    ],
    ['require-alias', "const load = require; const other = load('node:path');"],
    ['require-direct', "const other = require('path');"],
    [
      'create-require',
      "import { createRequire as makeLoader } from 'node:module'; const load = makeLoader(import.meta.url); const other = load('node:path');",
    ],
    [
      'module-namespace',
      "import * as loaders from 'node:module'; const load = loaders.createRequire(import.meta.url); const other = load('path');",
    ],
    [
      'module-default',
      "import { default as loaders } from 'module'; const load = loaders.createRequire(import.meta.url); const other = load('node:path');",
    ],
    ['loader-container', "import { createRequire } from 'module'; const box = { createRequire };"],
    [
      'loader-unknown',
      "import { createRequire } from 'module'; const load = createRequire(import.meta.url); load(unknownModule);",
    ],
    [
      loaderLateCase,
      "import { createRequire } from 'module'; const load = createRequire(import.meta.url); load('node:path');",
    ],
    ['builtin-sync', "import { syncBuiltinESMExports as sync } from 'node:module'; sync();"],
    ['process-loader', "const other = process.getBuiltinModule('path');"],
    ['global-loader', "const other = globalThis.require('path');"],
    [
      'global-alias',
      "const ambient = globalThis; const load = ambient.require; const other = load('node:path'); other.resolve = () => '/different';",
    ],
    [
      'global-container',
      "const box = { ambient: globalThis }; const other = box.ambient.require('node:path'); other.resolve = () => '/different';",
    ],
    [
      'global-nested-container',
      "const box = { ambient: [{ nested: globalThis }] }; box.ambient[0].nested.require('node:path');",
    ],
    ['global-array', "const box = [globalThis]; box[0].require('node:path');"],
    ['global-wrapped', "const ambient = (globalThis as unknown); ambient.require('node:path');"],
    ['global-spread', 'const box = { ...globalThis };'],
    ['global-argument', 'unknownMutator(globalThis);'],
    ['global-return', 'function capture() { return globalThis; }'],
    ['global-closure', 'const capture = () => globalThis;'],
    ['global-conditional', 'const box = flag ? globalThis : {};'],
    ['global-logical', 'const box = flag && globalThis;'],
    ['global-sequence', 'const box = (0, globalThis);'],
    ['global-destructure', 'const { require: load } = globalThis;'],
    ['global-computed', "globalThis['crypto'].randomUUID();"],
    ['global-optional', 'globalThis?.crypto.randomUUID();'],
    ['global-member-write', 'globalThis.crypto.randomUUID = replacement;'],
    ['global-member-update', 'globalThis.crypto.randomUUID++;'],
    ['global-member-delete', 'delete globalThis.crypto.randomUUID;'],
    ['global-root-alternate', "const ambient = global; ambient.require('node:path');"],
    ['window-root-alternate', "const ambient = window; ambient.require('node:path');"],
    ['self-root-alternate', "const ambient = self; ambient.require('node:path');"],
    ['global-default-body-var', 'function capture(ambient = globalThis) { var globalThis; } capture();'],
    ['process-alias-loader', "const ambient = process; ambient.getBuiltinModule('path');"],
    ['process-container-loader', "const box = { nested: [process] }; box.nested[0].getBuiltinModule('path');"],
    [
      'process-import-alias-loader',
      "import otherProcess from 'node:process'; const box = { otherProcess }; box.otherProcess.getBuiltinModule('path');",
    ],
    ['module-container-loader', "const box = { module }; box.module.require('node:path');"],

    [
      'file-target-alias',
      "import { pathToFileURL as toFile } from 'node:url'; const convert = toFile; await import(convert(generatedPath).href);",
    ],
    ['file-target-factory', 'await import(unknownConverter(generatedPath).href);'],
    ['file-target-member', "import * as urls2 from 'node:url'; await import(urls2.pathToFileURL(generatedPath).href);"],
    [
      'file-target-stored',
      "import { pathToFileURL as toFile } from 'node:url'; const location = toFile(generatedPath).href; await import(location);",
    ],
    [
      'file-target-computed',
      "import { pathToFileURL as toFile } from 'node:url'; await import(toFile(generatedPath)['href']);",
    ],
    ['object-write', "const box = { paths }; box.paths.resolve = () => '/different';"],
    ['object-escape', 'const box = { paths }; unknownMutator(box);'],
    ['array', 'const box = [paths];'],
    ['argument', 'unknownMutator(paths);'],
    ['assignment', 'let box; box = paths;'],
    ['delete', 'delete paths.resolve;'],
    ['update', 'paths.resolve++;'],
    ['extraction', 'const method = paths.resolve;'],
    ['call', 'paths.resolve.call(null);'],
    ['apply', 'paths.resolve.apply(null, []);'],
    ['bind', 'paths.resolve.bind(null);'],
    ['optional-call', 'paths.resolve?.();'],
    ['optional-namespace', 'paths?.resolve();'],
    ['wrapped', 'const box = { paths: (paths as unknown) };'],
    ['nested', 'const box = { nested: [{ paths }] };'],
    ['conditional', 'const box = flag ? paths : {};'],
    ['logical', 'const box = flag && paths;'],
    ['sequence', 'const box = (0, paths);'],
    ['destructure', 'const { resolve } = paths;'],
    ['spread', 'const box = { ...paths };'],
    ['return', 'function expose() { return paths; }'],
    ['export', 'export { paths };'],
    ['closure', 'const expose = () => paths;'],
    ['alias', 'const alias = paths;'],
    ['dynamic', "paths['resolve'] = () => '/different';"],
    ['unknown-method', 'paths.unknown();'],
    ['late', 'const box = { paths }; unknownMutator(box);'],
    ['factory', 'const box = { Process }; unknownMutator(box);'],
    ['child-namespace', 'const box = { child }; unknownMutator(box);'],
    ['process', 'const box = { process }; unknownMutator(box);'],
    ['url-constructor', 'const box = { URL }; unknownMutator(box);'],
    ['url-namespace', 'const box = { urls }; unknownMutator(box);'],
  ];
  for (const [name, capture] of namespaceCases) {
    const victim = bad(`namespace-${name}`);
    rejected.push(victim);
    write(root, victim, 'export const unusedNamespaceVictim = 1;');
    const cwd =
      name === 'url-namespace' || name === 'url-constructor' || name === 'url-constructor-alternate'
        ? "urls.fileURLToPath(new URL('../../../../', import.meta.url))"
        : 'rootDirectory';
    const invocation =
      name === 'process' || name === 'child-namespace'
        ? `${name === 'process' ? 'Process.make' : 'child.spawn'}(process.execPath, ['${victim}'], { cwd: rootDirectory });`
        : esbuildInvocation(victim, `{ cwd: ${cwd} }`);
    write(
      root,
      `${shell}/tests/integration/namespace-${name}.test.ts`,
      [
        nativeEffectProcessImport,
        nativePathImport,
        "import * as urls from 'node:url';",
        nativeChildNamespaceImport,
        name === 'late' || name === loaderLateCase ? '' : capture,
        esbuildRootDeclaration,
        invocation,
        name === 'late' || name === loaderLateCase ? capture : '',
      ].join('\n'),
    );
  }
  const nativeNamespaceInput = bad('valid-native-namespace');
  const helperNamespaceInput = bad('valid-helper-namespace');
  for (const victim of [nativeNamespaceInput, helperNamespaceInput]) {
    write(root, victim, 'console.log("bootstrap side effect"); export const unusedBootstrapExport = 1;');
  }
  write(
    root,
    `${shell}/tests/integration/valid-namespace.test.ts`,
    [
      nativeEffectProcessImport,
      nativePathImport,
      "import * as urls from 'node:url';",
      nativeChildNamespaceImport,
      "const rootDirectory = paths.join(urls.fileURLToPath(new URL('../../../../', import.meta.url)), '.');",
      `child.spawn(process.execPath, ['${nativeNamespaceInput}'], { cwd: rootDirectory });`,
      esbuildInvocation(helperNamespaceInput),
    ].join('\n'),
  );
  const canonicalPositives = [
    ['named-default', "import { default as paths } from 'node:path';"],
    ['bare-default', "import paths from 'path';"],
    ['namespace', "import * as paths from 'node:path';"],
    ['ordinary-require', `${nativePathImport} function require() { return {}; } require('node:path');`],
    [
      'ordinary-loader',
      `${nativePathImport} import { createRequire as makeLoader } from 'node:module'; const load = makeLoader(import.meta.url); load('@fixture/ordinary');`,
    ],
    ['ordinary-dynamic', `${nativePathImport} await import('./ordinary.ts');`],
    ['ordinary-global-crypto', `${nativePathImport} globalThis.crypto.randomUUID();`],
    [
      'local-global-object-shadow',
      `${nativePathImport} function capture(globalThis) { const box = { globalThis }; } capture({});`,
    ],
    ['local-process-shadow', `${nativePathImport} function capture(process) { const box = { process }; } capture({});`],

    [
      'ordinary-file',
      `${nativePathImport} import { pathToFileURL as toFile } from 'node:url'; await import(toFile(generatedPath).href);`,
    ],
    ['type-only', `${nativePathImport} import type { createRequire } from 'node:module';`],
  ].map(([name, importSource]) => {
    const victim = bad(`valid-${name}`);
    write(root, victim, 'export const unusedBootstrapExport = 1;');
    write(
      root,
      `${shell}/tests/integration/valid-canonical-${name}.test.ts`,
      [nativeEffectProcessImport, importSource, esbuildRootDeclaration, esbuildInvocation(victim)].join('\n'),
    );
    return victim;
  });
  return { canonicalPositives, helperNamespaceInput, nativeNamespaceInput, rejected };
};

it.live(
  'esbuild subprocess inputs retain exact binding and cwd proof without hiding unused neighbors',
  Effect.fn(function* esbuildSubprocessConsumers() {
    const root = yield* fixture();
    write(
      root,
      packageFile,
      '{"name":"bundle-controls","private":true,"type":"module","workspaces":["apps/*","verticals/*"]}',
    );
    const shell = 'apps/bundle-shell';
    const receiver = 'verticals/bundle-receiver';
    for (const workspace of [shell, receiver]) {
      write(
        root,
        `${workspace}/package.json`,
        JSON.stringify({ dependencies: { effect: '*' }, name: `@fixture/${workspace.split('/')[1]}`, type: 'module' }),
      );
    }
    const shellInput = `${shell}/tests/support/shell-http.ts`;
    const receiverInput = `${receiver}/tests/support/receiver-http.ts`;
    const immutableInput = `${shell}/tests/support/immutable-alias-http.ts`;
    const crossInput = `${receiver}/tests/support/cross-http.ts`;
    const unused = `${shell}/tests/support/never-bundled.ts`;
    const rejected = [
      'fake-driver',
      shadowDriverCase,
      'mutable-argv',
      'spliced-argv',
      'aliased-argv',
      'aliased-options',
      'aliased-factory',
      'member-argv',
      'member-options',
      'member-escape',
      'conditional-alias',
      'logical-alias',
      'sequence-alias',
      'destructured-alias',
      'nested-computed-alias',
      'returned-options',
      'constructor-options',
      'url-mutation',
      'url-escape',
      'captured-path',
      'captured-cwd',
      'escaped-argv',
      mutableCwdCase,
      unknownCwdCase,
      'spread-cwd',
      'fake-path',
      'fake-url',
      'wrong-prefix',
      'wrong-executable',
      'output-only',
      'string-only',
    ].map((name) => `${shell}/tests/support/${name}.ts`);
    for (const file of [shellInput, receiverInput, crossInput, immutableInput, unused, ...rejected]) {
      write(root, file, 'console.log("bootstrap side effect"); export const unusedBootstrapExport = 1;');
    }
    const bad = (name: string) => `${shell}/tests/support/${name}.ts`;
    const shellConsumer = `${shell}/tests/integration/consumer.test.ts`;
    const receiverConsumer = `${receiver}/tests/integration/consumer.test.ts`;
    write(
      root,
      shellConsumer,
      [
        nativeEffectProcessImport,
        nativePathImport,
        esbuildRootDeclaration,
        esbuildInvocation(shellInput),
        esbuildInvocation(crossInput),
        `const stableArgv = ['exec', '--', 'pnpm', 'exec', 'esbuild', '${immutableInput}', '--bundle']; const stableAlias = stableArgv; const stableOptions = { cwd: rootDirectory }; const stableOptionAlias = stableOptions; Process.make('mise', stableAlias, stableOptionAlias);`,
        `{ const Process = { make() {} }; ${esbuildInvocation(bad('fake-driver'))} }`,
        `function shadow(Process) { ${esbuildInvocation(bad(shadowDriverCase))} } shadow({ make() {} });`,
        `const args = ['exec', '--', 'pnpm', 'exec', 'esbuild', '${bad('mutable-argv')}']; args[5] = 'elsewhere.ts'; Process.make('mise', args, { cwd: rootDirectory });`,
        `{ const argv = ['exec', '--', 'pnpm', 'exec', 'esbuild', '${bad('spliced-argv')}', '--bundle']; argv.splice(5, 1, '${shellInput}'); Process.make('mise', argv, { cwd: rootDirectory }); }`,
        `{ const argv = ['exec', '--', 'pnpm', 'exec', 'esbuild', '${bad('aliased-argv')}', '--bundle']; const alias = argv; alias[5] = '${shellInput}'; Process.make('mise', argv, { cwd: rootDirectory }); }`,
        `{ const options = { cwd: rootDirectory }; const alias = options; alias.cwd = '/different'; ${esbuildInvocation(bad('aliased-options'), 'options')} }`,
        `{ const argv = ['exec', '--', 'pnpm', 'exec', 'esbuild', '${bad('escaped-argv')}', '--bundle']; unknownMutator(argv); Process.make('mise', argv, { cwd: rootDirectory }); }`,
        `{ let cwd = rootDirectory; cwd = '/different'; ${esbuildInvocation(bad(mutableCwdCase), '{ cwd }')} }`,
        `{ const argv = ['exec', '--', 'pnpm', 'exec', 'esbuild', '${bad('member-argv')}', '--bundle']; const outer = { argv }; const projected = outer.argv; projected[5] = '${shellInput}'; Process.make('mise', argv, { cwd: rootDirectory }); }`,
        ...[
          [
            'member-options',
            'const outer = { options }; const projected = outer.options; projected.cwd = "/different";',
          ],
          ['member-escape', 'const outer = { options }; const projected = outer.options; unknownMutator(projected);'],
          ['conditional-alias', 'const projected = condition ? options : {}; unknownMutator(projected);'],
          ['logical-alias', 'const projected = condition && options; unknownMutator(projected);'],
          ['sequence-alias', 'const projected = (null, options); projected.cwd = "/different";'],
          ['destructured-alias', 'const { inner } = { inner: options }; unknownMutator(inner);'],
          [
            'nested-computed-alias',
            'const outer = { inner: { options } }; const projected = outer.inner["options"]; unknownMutator(projected);',
          ],
          ['returned-options', 'const escape = () => options; unknownMutator(escape);'],
          ['constructor-options', 'new UnknownMutator(options);'],
        ].map(
          ([name, mutation]) =>
            `{ const options = { cwd: rootDirectory }; ${mutation} ${esbuildInvocation(bad(name), 'options')} }`,
        ),
        `function capturedCwd(directory) { const captured = directory; { const directory = rootDirectory; ${esbuildInvocation(bad('captured-cwd'), '{ cwd: captured }')} } } capturedCwd('/different');`,
        esbuildInvocation(bad(unknownCwdCase), '{ cwd: missingDirectory }'),
        esbuildInvocation(bad('spread-cwd'), '{ ...missingOptions }'),
        `{ const paths = { resolve: () => rootDirectory }; const fakeRoot = paths.resolve(import.meta.dirname); ${esbuildInvocation(bad('fake-path'), '{ cwd: fakeRoot }')} }`,
        esbuildInvocation(bad('wrong-prefix'), esbuildCwdOptions, "'mise'", "'exec', '--', 'pnpm', 'run', 'esbuild'"),
        esbuildInvocation(bad('wrong-executable'), esbuildCwdOptions, "'printf'"),
        `Process.make('mise', ['exec', '--', 'pnpm', 'exec', 'esbuild', '--outfile=${bad('output-only')}'], { cwd: rootDirectory });`,
        `const documentation = ${JSON.stringify(esbuildInvocation(bad('string-only')))}; void documentation;`,
      ].join('\n'),
    );
    write(
      root,
      receiverConsumer,
      [
        nativeEffectProcessImport,
        "import { fileURLToPath as toPath } from 'node:url';",
        "const rootDirectory = toPath(new URL('../../../../', import.meta.url));",
        esbuildInvocation(receiverInput),
        ...[
          ['url-mutation', 'const projected = address; projected.pathname = "/different";'],
          ['url-escape', 'unknownMutator(address);'],
        ].map(
          ([name, mutation]) =>
            `{ const address = new URL('../../../../', import.meta.url); ${mutation} ${esbuildInvocation(bad(name), '{ cwd: toPath(address) }')} }`,
        ),
        `{ const toPath = () => rootDirectory; const fakeRoot = toPath(new URL('../../../../', import.meta.url)); ${esbuildInvocation(bad('fake-url'), '{ cwd: fakeRoot }')} }`,
      ].join('\n'),
    );
    write(
      root,
      `${shell}/tests/integration/mutated-factory.test.ts`,
      [
        nativeEffectProcessImport,
        nativePathImport,
        esbuildRootDeclaration,
        'const driverAlias = Process; driverAlias.make = () => {};',
        esbuildInvocation(bad('aliased-factory')),
      ].join('\n'),
    );
    write(
      root,
      `${shell}/tests/integration/captured-path.test.ts`,
      [
        nativeEffectProcessImport,
        nativePathImport,
        `function capturedPath(fakePaths) { const captured = fakePaths; { const fakePaths = paths; ${esbuildInvocation(bad('captured-path'), "{ cwd: captured.resolve(import.meta.dirname, '..', '..', '..', '..') }")} } } capturedPath({ resolve: () => '/different' });`,
      ].join('\n'),
    );
    const opaqueFixtures = writeOpaqueScopeFixtures(root, shell);
    rejected.push(...opaqueFixtures.rejected);
    const namespaceFixtures = writeNamespaceCapabilityFixtures(root, shell);
    const { helperNamespaceInput, nativeNamespaceInput } = namespaceFixtures;
    namespaceFixtures.canonicalPositives.push(...opaqueFixtures.preserved);
    rejected.push(...namespaceFixtures.rejected);
    const config = {
      workspaces: {
        '.': { entry: [], node: false, project: [sourceScriptsPattern] },
        'apps/*': { entry: ['tests/integration/consumer.test.ts'], node: false, project: ['**/*.ts'] },
        'verticals/*': { entry: ['tests/integration/consumer.test.ts'], node: false, project: ['**/*.ts'] },
      },
    };
    const consumerPath = path.join(root, auditConsumersFile);
    const model = yield* buildKnipModel(root, config, consumerPath).pipe(Effect.provide(NodeServices.layer));
    const bundled = model.evidence.filter((fact) => fact.reason.startsWith('Native esbuild subprocess'));
    for (const [source, target, workspace] of [
      [shellConsumer, shellInput, shell],
      [shellConsumer, crossInput, shell],
      [shellConsumer, immutableInput, shell],
      [receiverConsumer, receiverInput, receiver],
    ]) {
      const proof = bundled.find(
        (fact) => fact.source === source && path.resolve(root, fact.workspace, fact.target) === path.join(root, target),
      );
      expect(proof).toMatchObject({ kind: 'file', workspace });
      expect(proof?.line).toBeGreaterThan(0);
      expect(proof?.column).toBeGreaterThanOrEqual(0);
    }
    for (const target of [nativeNamespaceInput, helperNamespaceInput, ...namespaceFixtures.canonicalPositives]) {
      expect(
        model.evidence.some(
          (fact) => fact.kind === 'file' && path.resolve(root, fact.workspace, fact.target) === path.join(root, target),
        ),
        target,
      ).toBe(true);
    }
    for (const file of [unused, ...rejected]) {
      expect(
        model.evidence.some((fact) => path.resolve(root, fact.workspace, fact.target) === path.join(root, file)),
        file,
      ).toBe(false);
    }
    const run = yield* runPinnedKnip(root, consumerPath, model).pipe(Effect.provide(NodeServices.layer));
    expect(run.status, run.stderr).toBe(1);
    const report = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ReportSchema))(run.stdout);
    const unusedFiles = report.issues.flatMap((issue) => issue.files.map((finding) => finding.name));
    for (const file of [
      shellInput,
      receiverInput,
      crossInput,
      immutableInput,
      nativeNamespaceInput,
      helperNamespaceInput,
      ...namespaceFixtures.canonicalPositives,
    ]) {
      expect(unusedFiles).not.toContain(file);
      expect(report.issues.find((issue) => issue.file === file)?.exports.map((finding) => finding.name)).toContain(
        'unusedBootstrapExport',
      );
    }
    for (const file of [unused, ...rejected]) {
      expect(unusedFiles).toContain(file);
    }

    // Exercise the exact production-test source syntax without evaluating its modules.
    const actualShell = 'apps/shell-super-app/tests/integration/auth-runtime.test.ts';
    const actualReceiver =
      'verticals/commerce-customer-context/tests/integration/purchase-resolution-permission-plan-postgres.test.ts';
    for (const [workspace, name] of [
      ['apps/shell-super-app', '@fixture/actual-shell'],
      ['verticals/party-registry', '@fixture/actual-party'],
      ['verticals/commerce-customer-context', '@fixture/actual-receiver'],
    ]) {
      write(root, `${workspace}/package.json`, JSON.stringify({ name, type: 'module' }));
    }
    for (const file of [actualShell, actualReceiver]) {
      write(root, file, readFileSync(path.join(appRoot, file), 'utf-8'));
    }
    const actualInputs = [
      'apps/shell-super-app/tests/support/tenant-party-shell-http.ts',
      'verticals/party-registry/tests/support/tenant-party-http.ts',
      'verticals/commerce-customer-context/tests/support/purchase-resolution-permission-plan-receiver.fixture.ts',
    ];
    for (const file of actualInputs) {
      write(root, file, 'export const unusedActualExport = 1;');
    }
    const actual = yield* buildKnipModel(root, config, consumerPath).pipe(Effect.provide(NodeServices.layer));
    for (const target of actualInputs) {
      expect(
        actual.evidence.some(
          (fact) =>
            fact.kind === 'file' &&
            fact.reason.startsWith('Native esbuild subprocess') &&
            [actualShell, actualReceiver].includes(fact.source) &&
            path.resolve(root, fact.workspace, fact.target) === path.join(root, target),
        ),
      ).toBe(true);
    }
  }),
);

it.live(
  'native subprocess consumers prove working directories and called parameter values without hiding neighbors',
  Effect.fn(function* nativeSubprocessConsumers() {
    const root = yield* fixture();
    write(root, packageFile, '{"name":"process-controls","type":"module","workspaces":["apps/*","packages/*"]}');
    const shell = 'apps/process-shell';
    const core = 'packages/process-core';
    write(root, `${shell}/package.json`, '{"name":"@fixture/process-shell","type":"module"}');
    write(
      root,
      `${core}/package.json`,
      '{"name":"@fixture/process-core","type":"module","dependencies":{"effect":"*"}}',
    );
    const nativeFixture = 'scripts/native.fixture.mts';
    const coreFixture = `${core}/tests/fixtures/worker.fixture.ts`;
    const overrideFixture = `${core}/tests/fixtures/override.fixture.ts`;
    for (const file of [nativeFixture, coreFixture, overrideFixture]) {
      write(root, file, 'export const unusedNativeNeighbor = 1;');
    }
    const invalidFiles = [
      'data',
      'local-driver',
      shadowDriverCase,
      'destructured-driver',
      'foreign-executable',
      'eval',
      'fake-path',
      'mutable-path',
      unknownCwdCase,
      'spread-options',
      'factory-options',
      'dynamic-member',
      'duplicate-cwd',
      'getter-cwd',
      'mutated-driver',
      'unused-default',
      'overridden-default',
    ].map((name) => `scripts/${name}.fixture.mts`);
    for (const file of invalidFiles) {
      write(root, file, 'export const unusedControl = 1;');
    }
    write(
      root,
      `${shell}/tests/consumer.ts`,
      [
        "import { spawn as execute } from 'node:child_process';",
        nativeChildNamespaceImport,
        nativePathImport,
        "execute(process.execPath, ['--experimental-strip-types', paths.resolve('../../scripts/native.fixture.mts'), paths.resolve('../../scripts/data.fixture.mts')], { stdio: 'pipe' });",
        `{ const execute = () => {}; ${nativeInvocation('local-driver')} }`,
        `function shadow(execute) { ${nativeInvocation(shadowDriverCase)} } shadow(() => {});`,
        `function destructured({ execute }) { ${nativeInvocation('destructured-driver')} } destructured({ execute: () => {} });`,
        nativeInvocation('foreign-executable', "'/usr/bin/printf'"),
        `execute(process.execPath, ['-e', ${scriptArgument('eval')}]);`,
        `{ const paths = { resolve: (value) => value }; ${nativeInvocation('fake-path')} }`,
        "{ let target = '../../scripts/mutable-path.fixture.mts'; const alias = target; target = 'elsewhere.mts'; execute(process.execPath, [paths.resolve(alias)]); }",
        nativeInvocation(unknownCwdCase, nodeExecutableExpression, '{ cwd: unknownDirectory }'),
        nativeInvocation('spread-options', nodeExecutableExpression, '{ ...unknownOptions }'),
        nativeInvocation('factory-options', nodeExecutableExpression, 'unknownFactory({})'),
        `{ const method = 'spawn'; child[method](process.execPath, [${scriptArgument('dynamic-member')}]); }`,
        nativeInvocation('duplicate-cwd', nodeExecutableExpression, "{ cwd: '.', cwd: '/different' }"),
        nativeInvocation('getter-cwd', nodeExecutableExpression, "{ get cwd() { return '.'; } }"),
        `const driver = execute; driver.custom = true; driver(process.execPath, [${scriptArgument('mutated-driver')}]);`,
        `const unused = (file = '../../scripts/unused-default.fixture.mts') => execute(process.execPath, [file]);`,
        `const overridden = (file = '../../scripts/overridden-default.fixture.mts') => execute(process.execPath, [file]); overridden('../../scripts/native.fixture.mts');`,
      ].join('\n'),
    );
    write(
      root,
      `${core}/tests/unit/consumer.test.ts`,
      [
        nativeEffectProcessImport,
        "const start = (signal, file = 'tests/fixtures/worker.fixture.ts') => (() => Process.make(process.execPath, ['--experimental-strip-types', file], { cwd: new URL('../..', import.meta.url).pathname }))();",
        "const assertStopped = (signal, file = 'tests/fixtures/worker.fixture.ts') => start(signal, file);",
        "assertStopped('SIGTERM'); assertStopped('SIGINT', 'tests/fixtures/override.fixture.ts');",
      ].join('\n'),
    );
    const consumerPath = path.join(root, auditConsumersFile);
    const model = yield* buildKnipModel(
      root,
      {
        workspaces: {
          '.': { entry: [], node: false, project: [sourceScriptsPattern] },
          'apps/*': { entry: ['tests/consumer.ts'], node: false, project: ['**/*.ts'] },
          'packages/*': { entry: ['tests/unit/consumer.test.ts'], node: false, project: ['**/*.ts'] },
        },
      },
      consumerPath,
    ).pipe(Effect.provide(NodeServices.layer));
    const subprocesses = model.evidence.filter((fact) => fact.reason.startsWith(nativeSubprocessReason));
    expect(
      subprocesses.some((fact) => fact.workspace === shell && fact.target === '../../scripts/native.fixture.mts'),
    ).toBe(true);
    expect(
      subprocesses.some((fact) => fact.workspace === core && fact.target === 'tests/fixtures/worker.fixture.ts'),
    ).toBe(true);
    expect(
      subprocesses.some((fact) => fact.workspace === core && fact.target === 'tests/fixtures/override.fixture.ts'),
    ).toBe(true);
    for (const file of invalidFiles) {
      expect(subprocesses.some((fact) => fact.target.endsWith(path.basename(file)))).toBe(false);
    }
    const run = yield* runPinnedKnip(root, consumerPath, model).pipe(Effect.provide(NodeServices.layer));
    expect(run.status, run.stderr).toBe(1);
    const report = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ReportSchema))(run.stdout);
    const unusedFiles = report.issues.flatMap((issue) => issue.files.map((finding) => finding.name));
    for (const file of invalidFiles) {
      expect(unusedFiles).toContain(file);
    }
    for (const file of [nativeFixture, coreFixture, overrideFixture]) {
      expect(unusedFiles).not.toContain(file);
      expect(report.issues.find((issue) => issue.file === file)?.exports.map((finding) => finding.name)).toContain(
        'unusedNativeNeighbor',
      );
    }
    const actualShellConsumer = 'apps/shell-super-app/tests/integration/module-api-node-process.test.ts';
    const actualCoreConsumer = 'packages/core-runtime/tests/unit/outbox-process.test.ts';
    const shellSource = `${shell}/tests/integration/module-api-node-process.test.ts`;
    const coreSource = `${core}/tests/unit/outbox-process.test.ts`;
    write(root, shellSource, readFileSync(path.join(appRoot, actualShellConsumer), 'utf-8'));
    write(root, coreSource, readFileSync(path.join(appRoot, actualCoreConsumer), 'utf-8'));
    write(root, 'scripts/integration/fixtures/native-owner-process.mts', 'export const unusedNeighbor = 1;');
    write(root, `${core}/tests/fixtures/outbox-worker-process.fixture.ts`, 'export const unusedNeighbor = 1;');
    const actual = yield* buildKnipModel(
      root,
      {
        workspaces: {
          '.': { entry: [], node: false, project: [sourceScriptsPattern] },
          'apps/*': { entry: ['tests/integration/module-api-node-process.test.ts'], node: false, project: ['**/*.ts'] },
          'packages/*': { entry: ['tests/unit/outbox-process.test.ts'], node: false, project: ['**/*.ts'] },
        },
      },
      consumerPath,
    ).pipe(Effect.provide(NodeServices.layer));
    expect(
      actual.evidence.some(
        (fact) =>
          fact.source === shellSource &&
          fact.reason.startsWith(nativeSubprocessReason) &&
          fact.target === '../../scripts/integration/fixtures/native-owner-process.mts',
      ),
    ).toBe(true);
    expect(
      actual.evidence.some(
        (fact) =>
          fact.source === coreSource &&
          fact.reason.startsWith(nativeSubprocessReason) &&
          fact.target === 'tests/fixtures/outbox-worker-process.fixture.ts',
      ),
    ).toBe(true);
  }),
);

it.live(
  'real pinned Knip models exact consumers and preserves neighboring findings',
  Effect.fn(function* testEffect3() {
    const root = yield* fixture();
    const base = yield* Schema.decodeUnknownEffect(KnipConfigSchema)({
      workspaces: {
        '.': {
          drizzle: { config: [] },
          entry: [indexFile, configurationFiles],
          lefthook: false,
          node: false,
          project: [sourcePattern, configurationFiles, toolsPattern],
        },
        'verticals/*': {
          entry: [indexFile, configurationFiles],
          project: [allTypedSourcePattern],
        },
      },
    });
    const consumerPath = path.join(root, '.codex/knip-model/consumers.mts');
    const model = yield* buildKnipModel(root, base, consumerPath).pipe(Effect.provide(NodeServices.layer));
    const run = yield* runPinnedKnip(root, consumerPath, model).pipe(Effect.provide(NodeServices.layer));
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(1);
    expect(run.stderr).toBe('');
    const report = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ReportSchema))(run.stdout);
    const findings = (kind: 'files' | 'exports' | 'types' | 'dependencies' | 'unlisted') =>
      report.issues.flatMap((issue) => issue[kind].map((finding) => `${issue.file}#${finding.name}`));
    expect(findings('files').includes('src/dead.ts#src/dead.ts')).toBe(true);
    expect(!findings('files').some((finding) => finding.startsWith('src/worker.mts#'))).toBe(true);
    expect(!findings('files').some((finding) => finding.startsWith('src/public.ts#'))).toBe(true);
    expect(findings('exports').includes('src/helper.ts#unusedNeighbor')).toBe(true);
    expect(!findings('exports').includes('verticals/remote/src/api/action-gateway.ts#ACTION_GATEWAY_AUDIENCE')).toBe(
      true,
    );
    expect(!findings('exports').includes('verticals/remote/src/api/action-gateway.ts#makeOperationGateway')).toBe(true);
    expect(!findings('exports').includes('verticals/remote/src/api/action-gateway.ts#operationGateway')).toBe(true);
    expect(findings('exports').includes('verticals/remote/src/api/action-gateway.ts#unusedGatewayNeighbor')).toBe(true);
    expect(findings('exports')).not.toContain(
      'verticals/remote/api/auth/action-principal.ts#ACTION_PRINCIPAL_BEARER_CHALLENGE',
    );
    expect(findings('exports')).not.toContain(
      'verticals/remote/api/auth/action-principal.ts#ActionPrincipalConfigurationErrorSchema',
    );
    expect(findings('types')).not.toContain(
      'verticals/remote/api/auth/action-principal.ts#ActionPrincipalVerificationOptions',
    );
    expect(findings('exports')).not.toContain(
      'verticals/remote/api/auth/action-principal.ts#authenticateOperationPrincipal',
    );
    expect(findings('exports')).toContain('verticals/remote/api/auth/action-principal.ts#unusedPrincipalNeighbor');
    expect(findings('exports')).not.toContain('verticals/remote/src/actions/publish.action.ts#PublishPayloadSchema');
    expect(findings('types')).not.toContain('verticals/remote/src/actions/publish.action.ts#PublishPayload');
    expect(findings('exports')).toContain('verticals/remote/src/actions/publish.action.ts#unusedActionNeighbor');
    expect(findings('exports')).not.toContain(
      'verticals/remote/src/actions/publish-commerce-remote-published-v1.outbox-message.ts#PublishCommerceRemotePublishedV1OutboxPayloadSchema',
    );
    expect(findings('types')).not.toContain(
      'verticals/remote/src/actions/publish-commerce-remote-published-v1.outbox-message.ts#PublishCommerceRemotePublishedV1OutboxPayload',
    );
    expect(findings('types')).not.toContain('verticals/remote/shared/apis/remote-status.ts#RemoteStatusResponse');
    expect(findings('exports')).toContain('verticals/remote/shared/apis/remote-status.ts#unusedModuleApiNeighbor');
    expect(!findings('exports').includes('tools/oxlint/effect-native/report.config.ts#default')).toBe(true);
    expect(findings('exports').includes('tools/oxlint/effect-native/report.config.ts#unusedConfigNeighbor')).toBe(true);
    expect(findings('exports').includes('src/schema.ts#unregisteredHelper')).toBe(true);
    expect(!findings('exports').includes('src/schema.ts#registeredSchema')).toBe(true);
    expect(!findings('exports').includes('src/public.ts#externallyConsumed')).toBe(true);
    expect(findings('dependencies').includes('package.json#jose')).toBe(true);
    expect(!findings('dependencies').includes('package.json#effect')).toBe(true);
    expect(findings('unlisted').includes('src/index.ts#misspelledRemote')).toBe(true);
    expect(findings('unlisted').includes('src/index.ts#declaredRemote')).toBe(true);
    expect(!findings('unlisted').includes('verticals/remote/src/index.ts#childRemote')).toBe(true);
    expect(findings('unlisted').includes('verticals/remote/src/index.ts#misspelledChild')).toBe(true);
    expect(findings('unlisted').includes('verticals/remote/src/index.ts#declaredRemote')).toBe(true);
    expect(findings('dependencies').includes('verticals/remote/package.json#effect')).toBe(true);
    expect(
      findings('dependencies').includes('verticals/remote/package.json#drizzle-orm'),
      'a zephyr:dependencies composition reference must count as a dependency consumer',
    ).toBe(false);
    expect(model.config.workspaces['.']?.ignoreDependencies).toEqual([]);
    expect(findings('unlisted').includes('src/index.ts#shadowedRemote')).toBe(true);
    expect(findings('unlisted').includes('src/direct.ts#@rspack/core')).toBe(true);
    expect(findings('unlisted').includes('src/own-resolver.ts#oxc-parser')).toBe(true);
    expect(!model.evidence.some((item) => item.kind === 'resolver' && item.source === 'src/own-resolver.ts')).toBe(
      true,
    );
    expect(
      model.evidence.some(
        (item) =>
          item.kind === 'resolver' &&
          item.source === resolverFile &&
          item.target === rspackPackageName &&
          item.line === 3 &&
          item.column === 17 &&
          item.resolved !== undefined,
      ),
    ).toBe(true);
    expect(!model.evidence.some((item) => item.kind === 'resolver' && item.source === directFile)).toBe(true);
    expect(
      model.evidence.some((item) => item.target === 'src/schema.ts#registeredSchema' && item.kind === 'export'),
    ).toBe(true);
  }),
);

it.live(
  'Drizzle reflection models modular table re-exports without consuming unrelated exports',
  Effect.fn(function* testModularDrizzleSchema() {
    const root = yield* fixture();
    write(
      root,
      'src/inventory-schema.ts',
      "import { pgSchema } from 'drizzle-orm/pg-core'; export const inventorySchema = pgSchema('inventory');",
    );
    write(
      root,
      'src/inventory-table.ts',
      [
        "import { text } from 'drizzle-orm/pg-core';",
        "import { inventorySchema } from './inventory-schema.ts';",
        "export const inventoryStockItems = inventorySchema.table.withRLS('stock_items', { id: text('id') });",
        'export const unrelatedSchemaHelper = () => 7;',
      ].join('\n'),
    );
    write(root, 'src/schema.ts', "export { inventoryStockItems, unrelatedSchemaHelper } from './inventory-table.ts';");
    const model = yield* buildKnipModel(root, { entry: [indexFile] }).pipe(Effect.provide(NodeServices.layer));
    const reflected = model.evidence
      .filter((fact) => fact.reason.startsWith('Drizzle reflective schema consumer'))
      .map((fact) => fact.target);
    expect(reflected).toContain('src/schema.ts#inventoryStockItems');
    expect(reflected).not.toContain('src/schema.ts#unrelatedSchemaHelper');
  }),
);

it.live(
  'modeling fails on invalid source instead of silently losing consumer evidence',
  Effect.fn(function* testEffect4() {
    const root = yield* fixture();
    write(root, 'module-federation.config.ts', 'export default { broken: ;');
    yield* buildKnipModel(root, { entry: [indexFile] })
      .pipe(Effect.provide(NodeServices.layer))
      .pipe(
        Effect.flip,
        Effect.map((error) =>
          expect(Schema.decodeUnknownSync(Schema.Struct({ reason: Schema.String }))(error).reason).toMatch(
            /Invalid quality model source/u,
          ),
        ),
      );
  }),
);

it.live(
  'Catalog models shared contract leaves and limits aliases to declared entries or runtime consumers',
  Effect.fn(function* testCatalogAliases() {
    const root = yield* fixture();
    write(
      root,
      'verticals/catalog/package.json',
      yield* stringify({
        exports: { './semantic': './shared/domain/semantic.ts' },
        name: '@app/catalog',
        private: true,
        type: 'module',
      }),
    );
    write(
      root,
      'verticals/catalog/shared/domain/semantic.ts',
      'export const ProductIdSchema = 1; export const ProductUuidSchema = ProductIdSchema;',
    );
    write(
      root,
      'verticals/catalog/shared/actions/publish.ts',
      'export const PublishPayloadSchema = 1; export type PublishPayload = string;',
    );
    write(
      root,
      'verticals/catalog/shared/actions/orphan.ts',
      'export const OrphanPayloadSchema = 1; export type OrphanPayload = string;',
    );
    write(
      root,
      'verticals/catalog/src/actions/publish.action.ts',
      [
        '// @generated by OntOS Codesmith Action v1',
        '// @ontos-action-owner catalog',
        '// @ontos-action-slug publish',
        "export { PublishPayloadSchema } from '../../shared/actions/publish.ts';",
        "export type { PublishPayload } from '../../shared/actions/publish.ts';",
      ].join('\n'),
    );
    write(
      root,
      'verticals/catalog/src/api/status.read.ts',
      [
        '// @generated by OntOS Codesmith module-api v1',
        'export interface StatusOwnerPort { readonly read: () => string }',
        "export class StatusOwner extends Context.Service<StatusOwner, StatusOwnerPort>()('StatusOwner') {}",
        'interface StatusServices { readonly owner: StatusOwnerPort }',
        'const servicesForScope = (): StatusServices => ({ owner: { read: () => "ok" } });',
        'export const readStatus = (_services: StatusServices) => _services.owner.read();',
        'export const unusedReadNeighbor = 1;',
        'export const statusRead = defineRead({}, (_input: unknown) => readStatus(servicesForScope()));',
      ].join('\n'),
    );
    write(
      root,
      'verticals/catalog/src/runtime-error.ts',
      'export class RuntimeError {} export const RuntimeErrorSchema = RuntimeError;',
    );
    write(
      root,
      'verticals/catalog/src/runtime-consumer.ts',
      "import { RuntimeError, RuntimeErrorSchema } from './runtime-error.ts'; void RuntimeError; void RuntimeErrorSchema;",
    );
    write(
      root,
      'verticals/catalog/src/internal-alias.ts',
      'export const InternalSchema = 1; export const UnusedInternalSchema = InternalSchema;',
    );
    write(
      root,
      'verticals/catalog/src/persistence/store.ts',
      [
        'export interface StoreInput { readonly value: string }',
        'export interface Store { readonly run: (input: StoreInput) => void }',
        'export interface UnusedStoreType { readonly value: string }',
      ].join('\n'),
    );
    write(
      root,
      'verticals/catalog/src/runtime-consumer.ts',
      [
        "import { RuntimeError, RuntimeErrorSchema } from './runtime-error.ts';",
        "import type { Store } from './persistence/store.ts';",
        'void RuntimeError; void RuntimeErrorSchema; const store = undefined as Store | undefined; void store;',
      ].join('\n'),
    );
    const model = yield* buildKnipModel(root, {
      workspaces: {
        'verticals/*': { entry: ['src/runtime-consumer.ts'], project: ['**/*.ts'] },
      },
    }).pipe(Effect.provide(NodeServices.layer));
    expect(model.config.workspaces['verticals/catalog']?.ignoreIssues).toEqual({
      'shared/domain/semantic.ts': ['duplicates'],
      'src/runtime-error.ts': ['duplicates'],
    });
    expect(
      model.evidence.some(
        (fact) => fact.kind === 'alias' && fact.target.endsWith('semantic.ts#ProductUuidSchema=ProductIdSchema'),
      ),
    ).toBe(true);
    expect(model.evidence.some((fact) => fact.kind === 'alias' && fact.source.endsWith('internal-alias.ts'))).toBe(
      false,
    );
    expect(
      model.evidence.some(
        (fact) => fact.kind === 'type' && fact.target.endsWith('src/persistence/store.ts#StoreInput'),
      ),
    ).toBe(true);
    expect(
      model.evidence.some(
        (fact) => fact.kind === 'type' && fact.target.endsWith('src/persistence/store.ts#UnusedStoreType'),
      ),
    ).toBe(false);
    expect(
      model.evidence.some(
        (fact) => fact.kind === 'type' && fact.target.endsWith('shared/actions/publish.ts#PublishPayload'),
      ),
    ).toBe(true);
    expect(
      model.evidence.some(
        (fact) => fact.kind === 'type' && fact.target.endsWith('shared/actions/orphan.ts#OrphanPayload'),
      ),
    ).toBe(true);
    expect(
      model.evidence.some(
        (fact) => fact.reason.includes('shared contract leaf') && fact.source.endsWith('src/internal-alias.ts'),
      ),
    ).toBe(false);
    expect(model.evidence.some((fact) => fact.target.endsWith('src/api/status.read.ts#readStatus'))).toBe(true);
    expect(model.evidence.some((fact) => fact.target.endsWith('src/api/status.read.ts#StatusOwner'))).toBe(true);
    expect(model.evidence.some((fact) => fact.target.endsWith('src/api/status.read.ts#unusedReadNeighbor'))).toBe(
      false,
    );
  }),
);

it.live(
  'the model regression harness uses the repository-pinned Knip version',
  Effect.fn(function* testEffect5() {
    const manifest = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Schema.Struct({ version: Schema.Literal('6.34.0') })),
    )(readFileSync(path.join(appRoot, knipManifestFile), 'utf-8'));
    expect(manifest.version).toBe('6.34.0');
  }),
);

it.live(
  'runner calibrates only the proven resolver record and retains the direct import',
  Effect.fn(function* testEffect6() {
    const root = yield* fixture();
    const installedManifest = readFileSync(path.join(appRoot, knipManifestFile));
    const installedBinary = readFileSync(path.join(appRoot, 'node_modules/.bin/knip'));
    const output = yield* Effect.acquireRelease(
      Effect.sync(() => mkdtempSync(path.join(tmpdir(), 'ontos-knip-model-output-'))),
      (directory) => Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
    ).pipe(Effect.map((directory) => realpathSync(directory)));
    write(
      root,
      'quality-audit/scope.json',
      yield* stringify({
        exclude: [],
        patterns: [sourcePattern, configurationFiles, 'verticals/**/*.{ts,mts}'],
      }),
    );
    write(
      root,
      'quality-audit/knip.json',
      yield* stringify({
        workspaces: {
          '.': {
            drizzle: { config: [] },
            entry: [indexFile, configurationFiles],
            lefthook: false,
            node: false,
            project: [sourcePattern, configurationFiles, toolsPattern],
          },
          'verticals/*': {
            entry: [indexFile, configurationFiles],
            project: [allTypedSourcePattern],
          },
        },
      }),
    );
    write(
      root,
      'quality-audit/knip-reporter.mts',
      readFileSync(path.join(appRoot, 'quality-audit/knip-reporter.mts'), 'utf-8'),
    );
    yield* runQualityAudit(root, output, 'knip').pipe(Effect.provide(NodeServices.layer));
    expect(readFileSync(path.join(appRoot, knipManifestFile))).toEqual(installedManifest);
    expect(readFileSync(path.join(appRoot, 'node_modules/.bin/knip'))).toEqual(installedBinary);
    const summary = Schema.decodeUnknownSync(
      Schema.fromJsonString(
        Schema.Struct({
          results: Schema.Array(
            Schema.Struct({
              coverage: Schema.Struct({
                findingCounts: Schema.Record(Schema.String, Schema.Number),
                modeledUsages: Schema.Number,
                nativeFindingCounts: Schema.Record(Schema.String, Schema.Number),
              }),
              name: Schema.String,
            }),
          ),
          runDirectory: Schema.String,
          status: Schema.Literal('reported'),
        }),
      ),
    )(readFileSync(path.join(output, 'summary.json'), 'utf-8'));
    const result = summary.results.find((entry) => entry.name === 'knip');
    expect(result !== undefined).toBe(true);
    if (result === undefined) {
      throw new Error('Expected result to be present');
    }
    expect(result.coverage.modeledUsages).toBe(1);
    expect(result.coverage.nativeFindingCounts.unlisted).toBe((result.coverage.findingCounts.unlisted ?? 0) + 1);
    const modeled = Schema.decodeUnknownSync(
      Schema.fromJsonString(Schema.Array(Schema.Struct({ file: Schema.String }))),
    )(readFileSync(path.join(summary.runDirectory, 'knip/modeled-usages.json'), 'utf-8'));
    expect(modeled).toEqual([{ file: resolverFile }]);
    const raw = Schema.decodeUnknownSync(Schema.fromJsonString(ReportSchema))(
      readFileSync(path.join(summary.runDirectory, 'knip/report.ndjson'), 'utf-8').trim().split('\n')[0],
    );
    expect(
      raw.issues.some(
        (issue) => issue.file === directFile && issue.unlisted.some((entry) => entry.name === rspackPackageName),
      ),
    ).toBe(true);
  }),
);

it.live(
  'vendor ownership rejects a different installed copy and accepts the same canonical target',
  Effect.fn(function* testEffect7() {
    const root = yield* Effect.acquireRelease(
      Effect.sync(() => mkdtempSync(path.join(tmpdir(), 'ontos-knip-copy-controls-'))),
      (directory) => Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
    ).pipe(Effect.map((directory) => realpathSync(directory)));
    write(root, packageFile, yield* stringify({ name: 'copy-controls', private: true }));
    const owner = 'node_modules/owner';
    const producer = `${owner}/node_modules/producer`;
    const ownerTarget = `${owner}/node_modules/target`;
    const producerTarget = `${producer}/node_modules/target`;
    yield* Effect.all(
      (
        [
          [owner, 'owner', { producer: '1.0.0' }],
          [producer, 'producer', { target: '1.0.0' }],
          [ownerTarget, 'target', {}],
          [producerTarget, 'target', {}],
        ] as const
      ).map(([directory, name, dependencies]) =>
        Effect.gen(function* testEffect8() {
          write(root, `${directory}/package.json`, yield* stringify({ dependencies, main: 'index.js', name }));
          write(root, `${directory}/index.js`, fixtureModuleSource);
        }),
      ),
      { concurrency: 'unbounded' },
    );
    write(
      root,
      indexFile,
      [
        ...requirePrelude,
        `require.resolve('target', { paths: [${JSON.stringify(path.join(root, owner, 'index.js'))}] });`,
      ].join('\n'),
    );
    const consumerPath = path.join(root, auditConsumersFile);
    const build = () =>
      Effect.gen(function* testEffect9() {
        return yield* buildKnipModel(
          root,
          { entry: [indexFile], node: false, project: [sourcePattern] },
          consumerPath,
        ).pipe(Effect.provide(NodeServices.layer));
      });
    const differentCopies = yield* build();
    expect(!differentCopies.evidence.some((item) => item.kind === 'resolver' && item.target === 'target')).toBe(true);
    const mismatch = differentCopies.evidence.find(
      (item) => item.kind === 'resolver-unproven' && item.target === 'target',
    );
    expect(mismatch !== undefined).toBe(true);
    if (mismatch === undefined) {
      throw new Error('Expected mismatch to be present');
    }
    expect(mismatch.producerManifest).toBe(path.join(root, producer, packageFile));
    expect(mismatch.producerResolved).toBe(realpathSync(path.join(root, producerTarget, 'index.js')));
    expect(mismatch.resolved).toBe(realpathSync(path.join(root, ownerTarget, 'index.js')));
    expect(mismatch.reason).toMatch(/different canonical target/u);
    const run = yield* runPinnedKnip(root, consumerPath, differentCopies).pipe(Effect.provide(NodeServices.layer));
    expect(run.status, run.stderr).toBe(1);
    const report = Schema.decodeUnknownSync(Schema.fromJsonString(ReportSchema))(run.stdout);
    expect(
      report.issues.some((issue) => issue.file === indexFile && issue.unlisted.some((item) => item.name === 'target')),
    ).toBe(true);
    rmSync(path.join(root, producerTarget), { force: true, recursive: true });
    symlinkSync(path.join(root, ownerTarget), path.join(root, producerTarget), 'dir');
    const sameCopy = yield* build();
    expect(
      sameCopy.evidence.some(
        (item) =>
          item.kind === 'resolver' &&
          item.target === 'target' &&
          item.owningManifest === path.join(root, producer, packageFile),
      ),
    ).toBe(true);
    write(
      root,
      indexFile,
      [
        ...requirePrelude,
        `require.resolve('target', { paths: [${yield* stringify(path.join(root, owner, 'missing'))}] });`,
      ].join('\n'),
    );
    const missingAnchor = yield* build();
    expect(!missingAnchor.evidence.some((item) => item.kind === 'resolver' && item.target === 'target')).toBe(true);
  }),
);

it.live(
  'UltraModern compiler commands consume tsrs without hiding unused compiler neighbors',
  Effect.fn(function* testUltramodernCompilerConsumers() {
    const root = yield* fixture();
    const child = 'verticals/compiler';
    const consumerPath = path.join(root, auditConsumersFile);
    const prepare = 'ultramodern-create ultramodern compiler-prepare';
    const typecheck = 'ultramodern-create ultramodern typecheck --project tsconfig.json';
    const compilerDependencies = { '@effect/tsgo': '0.63.0', tsrs: '0.20.1-ts7.1.0-beta', yaml: '2.9.1' };
    const manifests = (rootCommand: string, childCommand: string, withProvider = true) =>
      Effect.gen(function* writeCompilerManifests() {
        const devDependencies = withProvider
          ? compilerDependencies
          : { tsrs: compilerDependencies.tsrs, yaml: '2.9.1' };
        write(
          root,
          packageFile,
          yield* stringify({
            devDependencies,
            name: 'compiler-consumer-controls',
            private: true,
            scripts: { prepare: rootCommand },
            type: 'module',
            workspaces: ['verticals/*'],
          }),
        );
        write(
          root,
          `${child}/${packageFile}`,
          yield* stringify({
            devDependencies,
            name: '@fixture/compiler',
            private: true,
            scripts: { typecheck: childCommand },
            type: 'module',
          }),
        );
      });
    write(root, indexFile, 'export {};');
    write(root, `${child}/${indexFile}`, 'export {};');
    const base = {
      workspaces: {
        '.': { entry: [indexFile], node: false, project: [sourcePattern] },
        'verticals/*': { entry: [indexFile], node: false, project: [sourcePattern] },
      },
    };
    const analyze = () =>
      Effect.gen(function* analyzeCompilerConsumers() {
        const model = yield* buildKnipModel(root, base, consumerPath).pipe(Effect.provide(NodeServices.layer));
        const run = yield* runPinnedKnip(root, consumerPath, model).pipe(Effect.provide(NodeServices.layer));
        expect(run.status, run.stderr).toBe(1);
        const report = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ReportSchema))(run.stdout);
        return { model, report };
      });
    yield* manifests(prepare, typecheck);
    const consumed = yield* analyze();
    expect(consumed.model.evidence.filter((fact) => fact.target === 'tsrs')).toEqual([
      expect.objectContaining({ kind: 'dependency', source: packageFile, workspace: '.' }),
      expect.objectContaining({ kind: 'dependency', source: `${child}/${packageFile}`, workspace: child }),
    ]);
    for (const file of [packageFile, `${child}/${packageFile}`]) {
      expect(unusedDevDependencies(consumed.report, file)).not.toContain('tsrs');
      expect(unusedDevDependencies(consumed.report, file)).toContain('yaml');
    }
    for (const { childCommand, rootCommand, withProvider } of [
      {
        childCommand: 'ultramodern-create ultramodern skills install',
        rootCommand: `echo '${prepare}'`,
        withProvider: true,
      },
      { childCommand: typecheck, rootCommand: prepare, withProvider: false },
    ]) {
      yield* manifests(rootCommand, childCommand, withProvider);
      const unused = yield* analyze();
      expect(unused.model.evidence.some((fact) => fact.target === 'tsrs')).toBe(false);
      for (const file of [packageFile, `${child}/${packageFile}`]) {
        expect(unusedDevDependencies(unused.report, file)).toContain('tsrs');
        expect(unusedDevDependencies(unused.report, file)).toContain('yaml');
      }
    }
  }),
);

it.live(
  'Rstest, compiler type tests and Oxlint loaders consume files without hiding unused exports',
  Effect.fn(function* testConsumerExports() {
    const root = yield* fixture();
    const lintDirectory = 'tools/oxlint/effect-native';
    const policyScript = `${lintDirectory}/repository-policy.mts`;
    const helperTest = `${lintDirectory}/tests/shared-helpers.test.mts`;
    const loadedFiles = [
      rstestConfigFile,
      `${lintDirectory}/repository-policy.config.ts`,
      `${lintDirectory}/tests/shared-helpers-probe.ts`,
    ];
    write(root, packageFile, '{"name":"consumer-controls","type":"module","scripts":{"test":"rstest --project unit"}}');
    for (const file of loadedFiles) {
      write(root, file, 'export default {}; export const unusedNeighbor = 1;');
    }
    write(root, policyScript, "runOxlint(nodePath.join(pluginDirectory, 'repository-policy.config.ts'), []);");
    write(
      root,
      helperTest,
      "void { name: 'shared-helpers-probe', specifier: path.join(testsDirectory, 'shared-helpers-probe.ts') };",
    );
    write(root, 'tsconfig.json', '{"include":["src"]}');
    const typeTest = 'src/contract.type-test.ts';
    write(root, typeTest, 'export const unusedTypeTestNeighbor = 1;');
    const consumerPath = path.join(root, auditConsumersFile);
    const base = {
      workspaces: {
        '.': {
          entry: [policyScript, helperTest],
          node: false,
          project: [rstestConfigFile, 'src/*.ts', toolsPattern],
          rstest: { config: [] },
        },
      },
    };
    const model = yield* buildKnipModel(root, base, consumerPath).pipe(Effect.provide(NodeServices.layer));
    const run = yield* runPinnedKnip(root, consumerPath, model).pipe(Effect.provide(NodeServices.layer));
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(1);
    const report = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ReportSchema))(run.stdout);
    const files = report.issues.flatMap((issue) => issue.files.map((finding) => finding.name));
    const exports = report.issues.flatMap((issue) => issue.exports.map((finding) => `${issue.file}#${finding.name}`));
    for (const file of loadedFiles) {
      expect(files).not.toContain(file);
      expect(exports).toContain(`${file}#unusedNeighbor`);
      expect(exports).not.toContain(`${file}#default`);
    }
    expect(files).not.toContain(typeTest);
    expect(exports).toContain(`${typeTest}#unusedTypeTestNeighbor`);
    expect(files).toContain('src/dead.ts');
    const probeFile = `${lintDirectory}/tests/shared-helpers-probe.ts`;
    expect(model.evidence.filter((fact) => fact.source === helperTest)).toEqual([
      expect.objectContaining({
        column: 6,
        kind: 'file',
        line: 1,
        source: helperTest,
        target: probeFile,
        workspace: '.',
      }),
      expect.objectContaining({
        column: 6,
        kind: 'export',
        line: 1,
        source: helperTest,
        target: `${probeFile}#default`,
        workspace: '.',
      }),
    ]);
    for (const specifier of [
      'undefined',
      "'shared-helpers-probe.ts'",
      "join(testsDirectory, 'shared-helpers-probe.ts')",
      "path.resolve(testsDirectory, 'shared-helpers-probe.ts')",
      "path.join('testsDirectory', 'shared-helpers-probe.ts')",
      "path.join(otherDirectory, 'shared-helpers-probe.ts')",
      "path.join(testsDirectory, 'other-probe.ts')",
    ]) {
      write(root, helperTest, `void { name: 'shared-helpers-probe', specifier: ${specifier} };`);
      const unrecognized = yield* buildKnipModel(root, base, consumerPath).pipe(Effect.provide(NodeServices.layer));
      expect(unrecognized.evidence.some((fact) => fact.source === helperTest)).toBe(false);
    }
    write(
      root,
      packageFile,
      '{"name":"consumer-controls","type":"module","scripts":{"test":"rstest --config other.ts"}}',
    );
    write(root, 'tsconfig.json', '{"include":["src"],"exclude":["src/*.type-test.ts"]}');
    write(root, policyScript, "runOxlint(nodePath.join(pluginDirectory, 'other.config.ts'), []);");
    write(
      root,
      helperTest,
      "void { name: 'other-plugin', specifier: path.join(testsDirectory, 'shared-helpers-probe.ts') };",
    );
    const unrelated = yield* buildKnipModel(root, base, consumerPath).pipe(Effect.provide(NodeServices.layer));
    expect(unrelated.evidence.some((fact) => loadedFiles.includes(fact.target) || fact.target === typeTest)).toBe(
      false,
    );
  }),
);

it.live(
  'Rstest environments follow only exported static projects and retain source provenance',
  Effect.fn(function* testProjectEnvironments() {
    const root = yield* fixture();
    const configFile = rstestConfigFile;
    write(
      root,
      configFile,
      [
        "const environment = 'happy-dom' as const;",
        'const browser = { testEnvironment: environment };',
        'const alias = browser;',
        'const cycle = cycle;',
        "const unrelated = { testEnvironment: 'unrelated-environment' };",
        "function shadow() { const environment = 'shadow-environment'; return environment; }",
        'const projects = [alias, { testEnvironment: `jsdom` }, browser,',
        "  { testEnvironment: 'node' }, { testEnvironment: choose() }, cycle,",
        "  { metadata: unrelated }, 'external.config.ts', ...dynamicProjects];",
        "export default { testEnvironment: 'node', projects, metadata: unrelated };",
      ].join('\n'),
    );
    const model = yield* buildKnipModel(root, { entry: [configFile] }).pipe(Effect.provide(NodeServices.layer));
    const environments = model.evidence.filter((fact) => fact.reason === rstestEnvironmentReason);
    expect(environments.map((fact) => fact.target)).toEqual(['happy-dom', 'jsdom', 'happy-dom']);
    expect(environments[0]).toEqual(
      expect.objectContaining({
        kind: 'dependency',
        line: 2,
        source: configFile,
        workspace: '.',
      }),
    );
    expect(environments[1]?.line).toBe(7);
    for (const projects of ['choose()', 'cycle']) {
      write(
        root,
        configFile,
        `const cycle = cycle; export default { testEnvironment: 'happy-dom', projects: ${projects} };`,
      );
      const dynamic = yield* buildKnipModel(root, { entry: [configFile] }).pipe(Effect.provide(NodeServices.layer));
      expect(
        dynamic.evidence.filter((fact) => fact.reason === rstestEnvironmentReason).map((fact) => fact.target),
      ).toEqual(['happy-dom']);
    }
  }),
);

it.live(
  'pinned Knip consumes project environment evidence without hiding an unused dependency',
  Effect.fn(function* testPinnedProjectEnvironment() {
    const root = yield* fixture();
    write(
      root,
      packageFile,
      yield* stringify({
        dependencies: { 'happy-dom': '20.8.3', jose: '6.2.5' },
        name: 'project-environment-controls',
        private: true,
        type: 'module',
      }),
    );
    write(root, rstestConfigFile, "export default { projects: [{ testEnvironment: 'happy-dom' }] };");
    const consumerPath = path.join(root, auditConsumersFile);
    const model = yield* buildKnipModel(
      root,
      {
        entry: [rstestConfigFile],
        node: false,
        project: [rstestConfigFile],
        rstest: { config: [] },
      },
      consumerPath,
    ).pipe(Effect.provide(NodeServices.layer));
    expect(model.evidence.some((fact) => fact.reason === rstestEnvironmentReason && fact.target === 'happy-dom')).toBe(
      true,
    );
    for (const [consumerSource, expectedUnused] of [
      [model.consumerSource, false],
      ['', true],
    ] as const) {
      const run = yield* runPinnedKnip(root, consumerPath, {
        ...model,
        consumerSource,
      }).pipe(Effect.provide(NodeServices.layer));
      expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(1);
      expect(run.stderr).toBe('');
      const report = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ReportSchema))(run.stdout);
      const dependencies = report.issues.flatMap((issue) => issue.dependencies.map((item) => item.name));
      expect(dependencies.includes('happy-dom')).toBe(expectedUnused);
      expect(dependencies).toContain('jose');
    }
  }),
);
