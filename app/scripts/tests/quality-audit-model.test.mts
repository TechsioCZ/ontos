import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { Array as EffectArray, Effect, Order, Schema } from 'effect';
import { expect, it, layer } from 'effect-rstest';

import { buildKnipModel, KnipConfigSchema } from '../../quality-audit/knip-model.mts';
import { runQualityAudit } from '../quality-audit.mts';
import { runPinnedKnip } from './quality-audit-test-support.mts';

const nativePlatformModule = '@effect/platform-node';
const counterfeitModule = './counterfeit.mts';
const nativeProgramMain = 'NodeRuntime.runMain(program);';
const nativeVitestReason = 'Native Vitest';
const fakeMtsImport = "from './counterfeit.mts'";
const fakeTsImport = "from './counterfeit.ts'";
const operatorFile = 'scripts/operator.mts';
const unusedNeighborName = 'unusedNeighbor';
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
const emptyModuleSource = 'export {};';
const moduleFederationConfigFile = 'module-federation.config.ts';
const operatorScriptPattern = 'scripts/**/*.mts';
const rstestConfigFile = 'rstest.config.ts';
const auditConsumersFile = '.audit/consumers.mts';
const rstestEnvironmentReason = 'Rstest testEnvironment consumer';
const appRoot = path.resolve(import.meta.dirname, '../..');
const nativeRoutesWorkspace = 'apps/native-routes';
const nativeRoutesRoot = `${nativeRoutesWorkspace}/src/routes/[lang]`;
const nodeExecutableExpression = 'process.execPath';
const unusedNeighborSource = 'export const unusedNeighbor = 1;';
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
      duplicates: Schema.Array(Schema.Array(Schema.Struct({ name: Schema.String }))),
      exports: Names,
      file: Schema.String,
      files: Names,
      types: Names,
      unlisted: Names,
    }),
  ),
});
const expectPageDuplicatePolicy = (
  model: { readonly config: typeof KnipConfigSchema.Type },
  owner: string,
  allowed: boolean,
): void => {
  const ignored = model.config.workspaces?.[owner]?.ignoreIssues?.[String.raw`src/routes/\[lang\]/page.tsx`] ?? [];
  expect(ignored.includes('duplicates')).toBe(allowed);
};
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
      moduleFederationConfigFile,
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
    write(root, 'scripts/integration/fixtures/native-owner-process.mts', unusedNeighborSource);
    write(root, `${core}/tests/fixtures/outbox-worker-process.fixture.ts`, unusedNeighborSource);
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
    write(root, moduleFederationConfigFile, 'export default { broken: ;');
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
    write(root, indexFile, emptyModuleSource);
    write(root, `${child}/${indexFile}`, emptyModuleSource);
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
    const policyTest = `${lintDirectory}/tests/repository-policy.test.mts`;
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
    write(root, policyTest, "runOxlint(nodePath.join(pluginDirectory, 'repository-policy.config.ts'), []);");
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
          entry: [policyTest, helperTest],
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
    write(root, policyTest, "runOxlint(nodePath.join(pluginDirectory, 'other.config.ts'), []);");
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

layer(NodeServices.layer)('finite dynamic quality consumers', (testing) => {
  testing.effect(
    'Core module action aliases require the published outbox contract and runtime creator import',
    Effect.fn(function* coreModuleOutboxAliases() {
      const root = yield* fixture();
      const owner = 'packages/core-runtime';
      const slug = 'change-tenant-module-state';
      const topic = 'core-modules-tenant-module-state-changed-v1';
      const action = `${owner}/src/modules/actions/${slug}.action.ts`;
      const message = `${owner}/src/modules/actions/${slug}-${topic}.outbox-message.ts`;
      const contract = `${owner}/src/outbox/${topic}.ts`;
      const manifest = {
        exports: { [`./outbox/${topic}`]: `./src/outbox/${topic}.ts` },
        name: '@app/core-runtime',
        type: 'module',
      };
      write(root, `${owner}/package.json`, yield* stringify(manifest));
      const actionSource = readFileSync(path.join(appRoot, action), 'utf-8');
      write(
        root,
        action,
        `${actionSource}\nexport const unusedActionNeighbor = 1; export type UnusedActionNeighbor = string;`,
      );
      write(
        root,
        message,
        `${readFileSync(path.join(appRoot, message), 'utf-8')}\nexport const unusedMessageNeighbor = 1; export type UnusedMessageNeighbor = string;`,
      );
      write(root, contract, readFileSync(path.join(appRoot, contract), 'utf-8'));
      write(
        root,
        `${owner}/src/index.ts`,
        `import { changeTenantModuleStateAction } from './modules/actions/${slug}.action.ts'; console.log(changeTenantModuleStateAction);`,
      );
      const config = {
        workspaces: {
          '.': { entry: [], node: false, project: [] },
          'packages/*': { entry: [indexFile], node: false, project: ['src/**/*.ts'] },
        },
      };
      const consumerPath = path.join(root, auditConsumersFile);
      const model = yield* buildKnipModel(root, config, consumerPath);
      const aliases = model.evidence.filter(
        (fact) =>
          (fact.source === action || fact.source === message) && fact.reason.startsWith('Generated Outbox Message'),
      );
      expect(aliases).toHaveLength(9);
      const run = yield* runPinnedKnip(root, consumerPath, model);
      const report = yield* Schema.decodeEffect(Schema.fromJsonString(ReportSchema))(run.stdout);
      const names = report.issues.flatMap((issue) =>
        [...issue.exports, ...issue.types].map((item) => `${issue.file}#${item.name}`),
      );
      for (const alias of aliases) {
        expect(names).not.toContain(alias.target);
      }
      for (const { bindings, file } of [
        { bindings: ['unusedActionNeighbor', 'UnusedActionNeighbor'], file: action },
        { bindings: ['unusedMessageNeighbor', 'UnusedMessageNeighbor'], file: message },
      ]) {
        for (const binding of bindings) {
          expect(names).toContain(`${file}#${binding}`);
        }
      }
      write(root, `${owner}/package.json`, yield* stringify({ ...manifest, exports: {} }));
      const unpublished = yield* buildKnipModel(root, config, consumerPath);
      expect(unpublished.evidence.some((fact) => aliases.some((alias) => alias.target === fact.target))).toBe(false);
      write(root, `${owner}/package.json`, yield* stringify(manifest));
      write(
        root,
        action,
        actionSource.replace(
          `import { createChangeTenantModuleStateCoreModulesTenantModuleStateChangedV1OutboxMessage } from './${slug}-${topic}.outbox-message.ts';`,
          '',
        ),
      );
      const disconnected = yield* buildKnipModel(root, config, consumerPath);
      expect(disconnected.evidence.some((fact) => aliases.some((alias) => alias.target === fact.target))).toBe(false);
      const invalidRun = yield* runPinnedKnip(root, consumerPath, disconnected);
      const invalid = yield* Schema.decodeEffect(Schema.fromJsonString(ReportSchema))(invalidRun.stdout);
      expect(invalid.issues.find((issue) => issue.file === action)?.exports.map((item) => item.name)).toContain(
        'ChangeTenantModuleStateCoreModulesTenantModuleStateChangedV1OutboxPayloadSchema',
      );
      write(root, action, actionSource);
      write(root, `${owner}/package.json`, yield* stringify({ ...manifest, name: '@fixture/not-core' }));
      const foreignOwner = yield* buildKnipModel(root, config, consumerPath);
      expect(foreignOwner.evidence.some((fact) => aliases.some((alias) => alias.target === fact.target))).toBe(false);
    }),
  );

  testing.effect(
    'page aliases require named manifest use and default federation exposure without exempting extra duplicate bindings',
    Effect.fn(function* manifestPageAliases() {
      const root = yield* fixture();
      const owner = 'verticals/page-controls';
      const page = `${owner}/src/routes/[lang]/page.tsx`;
      const pagePattern = String.raw`src/routes/\[lang\]/page.tsx`;
      const manifestFile = `${owner}/vertical.manifest.ts`;
      const pageSource = 'export const RecordsPage = () => null; export default RecordsPage;';
      write(
        root,
        `${owner}/package.json`,
        '{"name":"@fixture/pages","type":"module","modernjs":{"ontosModule":{"manifest":"./vertical.manifest.ts"}}}',
      );
      write(
        root,
        `${owner}/vertical.manifest.ts`,
        "import { RecordsPage } from './src/routes/[lang]/page.tsx'; export const manifest = { publicSurface: { components: { records: RecordsPage } } };",
      );
      write(
        root,
        `${owner}/module-federation.config.ts`,
        "import { createModuleFederationConfig } from '@module-federation/modern-js-v3'; const config: Parameters<typeof createModuleFederationConfig>[0] = createModuleFederationConfig({ exposes: { './Page': './src/routes/[lang]/page.tsx' } }); export default config;",
      );
      write(root, page, pageSource);
      const config = {
        workspaces: {
          '.': { entry: [], node: false, project: [] },
          'verticals/*': {
            entry: ['vertical.manifest.ts', moduleFederationConfigFile],
            node: false,
            project: ['**/*.{ts,tsx}'],
          },
        },
      };
      const consumerPath = path.join(root, auditConsumersFile);
      const readKnipReport = () =>
        Effect.sync(() =>
          spawnSync(
            process.execPath,
            [
              path.join(appRoot, 'node_modules/knip/bin/knip.js'),
              '--directory',
              root,
              '--config',
              path.join(root, '.audit/knip.json'),
              '--reporter',
              'json',
              '--no-progress',
              '--include-entry-exports',
            ],
            { encoding: 'utf-8', timeout: 60_000 },
          ),
        );
      const model = yield* buildKnipModel(root, config, consumerPath);
      expect(model.evidence.some((fact) => fact.target === `${page}#default=RecordsPage`)).toBe(true);
      yield* runPinnedKnip(root, consumerPath, model);
      const run = yield* readKnipReport();
      const validReport = yield* Schema.decodeEffect(Schema.fromJsonString(ReportSchema))(run.stdout);
      expect(validReport.issues.some((issue) => issue.file === page)).toBe(false);
      const manifestWithPreload =
        "import { RecordsPage, preloadPage } from './src/routes/[lang]/page.tsx'; preloadPage(); export const manifest = { publicSurface: { components: { records: RecordsPage } } };";
      write(root, manifestFile, manifestWithPreload);
      write(
        root,
        page,
        `${pageSource} const modulePagePreload = (load: () => void) => load; export const preloadPage = modulePagePreload(() => undefined);`,
      );
      const calledPreload = yield* buildKnipModel(root, config, consumerPath);
      expectPageDuplicatePolicy(calledPreload, owner, true);
      yield* runPinnedKnip(root, consumerPath, calledPreload);
      const calledPreloadRun = yield* readKnipReport();
      const calledPreloadReport = yield* Schema.decodeEffect(Schema.fromJsonString(ReportSchema))(
        calledPreloadRun.stdout,
      );
      expect(calledPreloadReport.issues.some((issue) => issue.file === page)).toBe(false);

      const loader = `${owner}/src/routes/[lang]/loader.ts`;
      write(root, loader, 'export const preloadRecords = () => undefined; export const unusedLoaderNeighbor = 1;');
      const reexport = "export { preloadRecords as preloadPage } from './loader.ts';";
      write(root, page, `${pageSource} ${reexport}`);
      const forwardedPreload = yield* buildKnipModel(root, config, consumerPath);
      expectPageDuplicatePolicy(forwardedPreload, owner, true);
      yield* runPinnedKnip(root, consumerPath, forwardedPreload);
      const forwardedRun = yield* readKnipReport();
      const forwardedReport = yield* Schema.decodeEffect(Schema.fromJsonString(ReportSchema))(forwardedRun.stdout);
      expect(forwardedReport.issues.some((issue) => issue.file === page)).toBe(false);
      expect(forwardedReport.issues.find((issue) => issue.file === loader)?.exports.map((item) => item.name)).toContain(
        'unusedLoaderNeighbor',
      );

      const importedPreloadSource = "import { preloadRecords } from './loader.ts';";
      write(root, page, `${importedPreloadSource} ${pageSource} export const preloadPage = preloadRecords;`);
      const importedPreload = yield* buildKnipModel(root, config, consumerPath);
      expectPageDuplicatePolicy(importedPreload, owner, true);
      yield* runPinnedKnip(root, consumerPath, importedPreload);
      const importedRun = yield* readKnipReport();
      const importedReport = yield* Schema.decodeEffect(Schema.fromJsonString(ReportSchema))(importedRun.stdout);
      expect(importedReport.issues.some((issue) => issue.file === page)).toBe(false);
      expect(importedReport.issues.find((issue) => issue.file === loader)?.exports.map((item) => item.name)).toContain(
        'unusedLoaderNeighbor',
      );
      write(
        root,
        page,
        `${importedPreloadSource} ${pageSource} export const preloadPage = preloadRecords; export const OtherPreload = preloadRecords;`,
      );
      const duplicateImportedPreload = yield* buildKnipModel(root, config, consumerPath);
      expectPageDuplicatePolicy(duplicateImportedPreload, owner, false);
      yield* runPinnedKnip(root, consumerPath, duplicateImportedPreload);
      const duplicatedImportRun = yield* readKnipReport();
      expect(duplicatedImportRun.stdout).toContain('OtherPreload');
      write(
        root,
        page,
        `${importedPreloadSource} ${pageSource} export const preloadPage = preloadRecords; export { preloadRecords as OtherPreload } from './loader.ts';`,
      );
      const mixedForwarding = yield* buildKnipModel(root, config, consumerPath);
      expectPageDuplicatePolicy(mixedForwarding, owner, false);
      write(
        root,
        page,
        `${pageSource} export { preloadRecords as preloadPage, preloadRecords as OtherPreload } from './loader.ts';`,
      );
      const duplicateReexport = yield* buildKnipModel(root, config, consumerPath);
      expectPageDuplicatePolicy(duplicateReexport, owner, false);
      yield* runPinnedKnip(root, consumerPath, duplicateReexport);
      const duplicateReexportRun = yield* readKnipReport();
      const duplicateReexportReport = yield* Schema.decodeEffect(Schema.fromJsonString(ReportSchema))(
        duplicateReexportRun.stdout,
      );
      expect(
        duplicateReexportReport.issues
          .find((issue) => issue.file === page)
          ?.duplicates.flat()
          .map((item) => item.name),
      ).toEqual(expect.arrayContaining(['RecordsPage', 'default']));

      write(root, page, `${pageSource} ${reexport}`);
      write(root, loader, "export { RecordsPage as preloadRecords } from './page.tsx';");
      const indirectPageAlias = yield* buildKnipModel(root, config, consumerPath);
      expectPageDuplicatePolicy(indirectPageAlias, owner, false);
      write(root, loader, 'export const original = () => undefined; export const preloadRecords = original;');
      const remoteAlias = yield* buildKnipModel(root, config, consumerPath);
      expectPageDuplicatePolicy(remoteAlias, owner, false);
      write(root, page, `${importedPreloadSource} ${pageSource} export const preloadPage = preloadRecords;`);
      const importedRemoteAlias = yield* buildKnipModel(root, config, consumerPath);
      expectPageDuplicatePolicy(importedRemoteAlias, owner, false);

      write(
        root,
        page,
        'export const RecordsPage = () => null; export default RecordsPage; export const projectAgenda = () => [];',
      );
      write(
        root,
        `${owner}/vertical.manifest.ts`,
        "import { RecordsPage, projectAgenda } from './src/routes/[lang]/page.tsx'; projectAgenda(); export const manifest = { publicSurface: { components: { records: RecordsPage } } };",
      );
      const helperModel = yield* buildKnipModel(root, config, consumerPath);
      expect(helperModel.evidence.some((fact) => fact.target === `${page}#default=RecordsPage`)).toBe(true);
      expect(helperModel.evidence.some((fact) => fact.target === `${page}#projectAgenda`)).toBe(false);
      expect(helperModel.config.workspaces['verticals/page-controls']?.ignoreIssues?.[pagePattern] ?? []).toContain(
        'duplicates',
      );
      yield* runPinnedKnip(root, consumerPath, helperModel);
      const helperRun = yield* readKnipReport();
      const helperReport = yield* Schema.decodeEffect(Schema.fromJsonString(ReportSchema))(helperRun.stdout);
      expect(helperReport.issues.some((issue) => issue.file === page)).toBe(false);
      write(
        root,
        `${owner}/vertical.manifest.ts`,
        "import { RecordsPage } from './src/routes/[lang]/page.tsx'; export const manifest = { publicSurface: { components: { records: RecordsPage } } };",
      );
      write(root, `${owner}/src/preload.ts`, 'export const load = () => undefined;');
      const verifyLoaderAliasControls = Effect.fn(function* verifyLoaderAliasControls() {
        for (const loaderSource of [
          'const modulePagePreload = (load: () => void) => load; export const preloadPage = modulePagePreload(() => undefined);',
          "export { load as preloadPage } from '../../preload.ts';",
        ]) {
          write(root, page, `export const RecordsPage = () => null; export default RecordsPage; ${loaderSource}`);
          const withLoader = yield* buildKnipModel(root, config, consumerPath);
          expect(withLoader.config.workspaces['verticals/page-controls']?.ignoreIssues?.[pagePattern] ?? []).toContain(
            'duplicates',
          );
          yield* runPinnedKnip(root, consumerPath, withLoader);
          const loaderRun = yield* readKnipReport();
          const loaderReport = yield* Schema.decodeEffect(Schema.fromJsonString(ReportSchema))(loaderRun.stdout);
          expect(loaderReport.issues.find((issue) => issue.file === page)?.duplicates ?? []).toEqual([]);
          write(
            root,
            page,
            `export const RecordsPage = () => null; export default RecordsPage; ${loaderSource} export { RecordsPage as HiddenAlias };`,
          );
          const extraLoaderAlias = yield* buildKnipModel(root, config, consumerPath);
          expect(
            extraLoaderAlias.config.workspaces['verticals/page-controls']?.ignoreIssues?.[pagePattern] ?? [],
          ).not.toContain('duplicates');
          yield* runPinnedKnip(root, consumerPath, extraLoaderAlias);
          const aliasRun = yield* readKnipReport();
          expect(aliasRun.stdout).toContain('HiddenAlias');
        }
      });
      yield* verifyLoaderAliasControls();
      write(
        root,
        page,
        'export const RecordsPage = () => null; export default RecordsPage; export const Unused = () => null; export { Unused as OtherUnused };',
      );
      const neighbor = yield* buildKnipModel(root, config, consumerPath);
      expect(neighbor.evidence.some((fact) => fact.target === `${page}#default=RecordsPage`)).toBe(true);
      expect(neighbor.config.workspaces['verticals/page-controls']?.ignoreIssues?.[pagePattern] ?? []).not.toContain(
        'duplicates',
      );
      yield* runPinnedKnip(root, consumerPath, neighbor);
      const invalidRun = yield* readKnipReport();
      expect(invalidRun.status).toBe(1);
      expect(invalidRun.stdout).toContain('Unused');
      expect(invalidRun.stdout).toContain('OtherUnused');
      write(
        root,
        page,
        'export const RecordsPage = () => null; export default RecordsPage; export { RecordsPage as OtherPage };',
      );
      const extraPageAlias = yield* buildKnipModel(root, config, consumerPath);
      expect(extraPageAlias.evidence.some((fact) => fact.target === `${page}#default=RecordsPage`)).toBe(true);
      expect(extraPageAlias.evidence.some((fact) => fact.target === `${page}#OtherPage=RecordsPage`)).toBe(false);
      expect(
        extraPageAlias.config.workspaces['verticals/page-controls']?.ignoreIssues?.[pagePattern] ?? [],
      ).not.toContain('duplicates');
      yield* runPinnedKnip(root, consumerPath, extraPageAlias);
      const extraAliasRun = yield* readKnipReport();
      expect(extraAliasRun.status).toBe(1);
      expect(extraAliasRun.stdout).toContain('OtherPage');
      write(
        root,
        `${owner}/vertical.manifest.ts`,
        "import { RecordsPage, OtherPage } from './src/routes/[lang]/page.tsx'; OtherPage(); export const manifest = { publicSurface: { components: { records: RecordsPage } } };",
      );
      const usedExtraAlias = yield* buildKnipModel(root, config, consumerPath);
      expect(usedExtraAlias.evidence.some((fact) => fact.target === `${page}#default=RecordsPage`)).toBe(true);
      expect(
        usedExtraAlias.config.workspaces['verticals/page-controls']?.ignoreIssues?.[pagePattern] ?? [],
      ).not.toContain('duplicates');
      yield* runPinnedKnip(root, consumerPath, usedExtraAlias);
      const usedExtraAliasRun = yield* readKnipReport();
      const usedExtraAliasReport = yield* Schema.decodeEffect(Schema.fromJsonString(ReportSchema))(
        usedExtraAliasRun.stdout,
      );
      expect(usedExtraAliasReport.issues.find((issue) => issue.file === page)?.exports).toEqual([]);
      expect(
        usedExtraAliasReport.issues
          .find((issue) => issue.file === page)
          ?.duplicates.flat()
          .map((item) => item.name),
      ).toEqual(expect.arrayContaining(['RecordsPage', 'default']));
      write(root, page, pageSource);
      write(root, `${owner}/module-federation.config.ts`, 'export default {};');
      const noExposure = yield* buildKnipModel(root, config, consumerPath);
      expect(noExposure.evidence.some((fact) => fact.target === `${page}#default=RecordsPage`)).toBe(false);
      write(
        root,
        `${owner}/module-federation.config.ts`,
        "export default { exposes: { './Page': './src/routes/[lang]/page.tsx' } };",
      );
      write(
        root,
        manifestFile,
        "import { RecordsPage } from './src/routes/[lang]/page.tsx'; RecordsPage(); export const manifest = { publicSurface: { components: {} } };",
      );
      const noPublicComponent = yield* buildKnipModel(root, config, consumerPath);
      expect(noPublicComponent.evidence.some((fact) => fact.target === `${page}#default=RecordsPage`)).toBe(false);
      expectPageDuplicatePolicy(noPublicComponent, owner, false);
      yield* runPinnedKnip(root, consumerPath, noPublicComponent);
      const noComponentRun = yield* readKnipReport();
      expect(noComponentRun.status).toBe(1);
      expect(noComponentRun.stdout).toContain('RecordsPage');
    }),
  );
});

it.live(
  'native top-level Effect CLI roots preserve manual operators and reject nearby non-entry source',
  Effect.fn(function* nativeCliControls() {
    const root = yield* fixture();
    const owner = 'verticals/manual-cli';
    const nativeImport = "import { NodeRuntime } from '@effect/platform-node'; import { Effect, Layer } from 'effect';";
    const main = 'NodeRuntime.runMain(Effect.scoped(Layer.build(runtimeLive)));';
    const source = `${nativeImport}\nconst runtimeLive = Layer.empty;\n${main}`;
    write(root, `${owner}/package.json`, '{"name":"@fixture/manual-cli","type":"module"}');
    write(root, `${owner}/src/index.ts`, emptyModuleSource);
    write(root, `${owner}/scripts/operator.mts`, source);
    write(
      root,
      `${owner}/scripts/alias.mts`,
      source.replaceAll('NodeRuntime', 'Runtime').replace('{ Runtime }', '{ NodeRuntime as Runtime }'),
    );
    const invalid = [
      source.replace(main, `function unused() { ${main} }`),
      source.replace(main, `const unused = () => { ${main} };`),
      source.replace(main, `// ${main}`),
      source.replace(main, `void ${JSON.stringify(main)};`),
      source.replace(nativePlatformModule, counterfeitModule),
      source
        .replace('Effect, Layer', 'Effect as ForeignEffect, Layer')
        .replace(main, `const Effect = replacement; ${main}`),
      source.replace(main, `NodeRuntime.runMain = replacement; ${main}`),
      source.replace('const runtimeLive', 'let runtimeLive'),
      source.replace('Effect.scoped(Layer.build(runtimeLive))', 'runtimeLive'),
    ];
    for (const [index, text] of invalid.entries()) {
      write(root, `${owner}/scripts/invalid-${index}.mts`, text);
    }
    write(root, `${owner}/src/not-an-operator.mts`, source);
    const consumerPath = path.join(root, auditConsumersFile);
    const model = yield* buildKnipModel(
      root,
      {
        workspaces: {
          '.': { entry: [], project: [] },
          'verticals/*': { entry: [indexFile], project: ['**/*.{ts,mts}'] },
        },
      },
      consumerPath,
    ).pipe(Effect.provide(NodeServices.layer));
    expect(
      EffectArray.sort(
        model.evidence
          .filter((fact) => fact.reason.startsWith('Native top-level NodeRuntime'))
          .map((fact) => fact.target),
        Order.String,
      ),
    ).toEqual(['scripts/alias.mts', operatorFile]);
    const run = yield* runPinnedKnip(root, consumerPath, model).pipe(Effect.provide(NodeServices.layer));
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(1);
    const report = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ReportSchema))(run.stdout);
    const files = report.issues.filter((issue) => issue.files.length > 0).map((issue) => issue.file);
    expect(files).not.toContain(`${owner}/scripts/operator.mts`);
    expect(files).not.toContain(`${owner}/scripts/alias.mts`);
    for (const [index] of invalid.entries()) {
      expect(files).toContain(`${owner}/scripts/invalid-${index}.mts`);
    }
    expect(files).toContain(`${owner}/src/not-an-operator.mts`);

    // Real operator bodies are parsed as data. Nothing imports or executes their database behavior.
    const operators = [
      'verticals/finance-billing/scripts/repair-demo-rental.mts',
      'verticals/finance-billing/scripts/repair-demo-v2.mts',
      'verticals/finance-billing/scripts/repair-invoice-parties.mts',
      'verticals/finance-billing/scripts/repair-prepared-step.mts',
      'verticals/work-tasks/scripts/prune-demo-leftovers.mts',
    ];
    for (const file of operators) {
      const workspace = file.split('/').slice(0, 2).join('/');
      write(root, `${workspace}/package.json`, '{"name":"@fixture/operator","type":"module"}');
      write(root, file, readFileSync(path.join(appRoot, file), 'utf-8'));
    }
    const real = yield* buildKnipModel(root, {
      workspaces: { '.': { entry: [], project: [] }, 'verticals/*': { entry: [], project: ['**/*.mts'] } },
    }).pipe(Effect.provide(NodeServices.layer));
    for (const file of operators) {
      expect(
        real.evidence.some(
          (fact) =>
            fact.source === file && fact.kind === 'entry' && fact.reason.startsWith('Native top-level NodeRuntime'),
        ),
      ).toBe(true);
    }
  }),
);

it.live(
  'native lint argv and factory parser consume the 34 exact documents without admitting neighboring files or exports',
  Effect.fn(function* nativeLintConsumers() {
    const root = yield* fixture();
    const tests = 'tools/oxlint/effect-native/tests';
    const parser = 'tools/oxlint/anti-slop/effect/rules/data-factory-proof.ts';
    const harness = `${tests}/oxlint.mts`;
    const names = [
      'decoded-unknown-parameter',
      'generic-json-canonicalizer',
      'known-value-widening',
      'native-service-factory-import',
      'owner-data-decoder',
      'schema-value-constructor',
    ];
    const anti = 'tools/oxlint/anti-slop/tests/fixtures';
    const service = `${anti}/no-service-constructor-imports`;
    const transaction =
      'tools/oxlint/anti-slop/effect/fixtures/no-service-constructor-imports/transaction-bound-factory';
    const configs = names.slice(0, 4).map((name) => `${tests}/${name}.config.ts`);
    const documents = [
      ...configs,
      ...['native-effect-boundaries', 'owner-boundaries', 'unproved-boundaries', 'unproved-effect-boundaries'].map(
        (name) => `${anti}/no-unknown-parameters/${name}.ts`,
      ),
      ...[
        'valid/indexed-owner-types',
        'valid/owner-contract',
        'valid/owner-mapped-types',
        'invalid/open-and-erased-mapped-types',
      ].map((name) => `${anti}/no-known-value-widening/${name}.ts`),
      ...[
        'invalid-constructor',
        'invalid-eager-argument',
        'invalid-escape',
        'invalid-handler-slot',
        'invalid-lookalike',
        'owner',
        'valid-reference',
      ].map((name) => `${transaction}/${name}.ts`),
      ...[
        'ares-snapshot-consumer',
        'temporal-data-decoder',
        'temporal-decoder-consumer',
        'temporal-decoder-effect-transform',
        'temporal-decoder-effect',
        'temporal-decoder-executable-transform',
        'temporal-decoder-fake-datetime',
        'temporal-decoder-unknown',
        'branded-constructor-consumer',
        'branded-constructor-context',
        'branded-constructor-executable-check',
        'branded-constructor-executable-input',
        'branded-constructor-fake-make',
        'branded-constructor-unchecked',
        'branded-constructor-unknown',
      ].map((name) => `${service}/${name}.ts`),
    ];
    expect(documents).toHaveLength(34);
    for (const file of [
      harness,
      parser,
      ...names.map((name) => `${tests}/${name}.test.mts`),
      ...documents,
      `${service}/ares-snapshot-owner.ts`,
      `${service}/branded-string-constructor.ts`,
    ]) {
      write(root, file, readFileSync(path.join(appRoot, file), 'utf-8'));
    }
    const neighbor = `${service}/unused-neighbor.ts`;
    write(root, neighbor, unusedNeighborSource);
    write(root, configs[0], `${readFileSync(path.join(root, configs[0]), 'utf-8')}\n${unusedNeighborSource}`);
    const producer = `${service}/ares-snapshot-owner.ts`;
    write(root, producer, `${readFileSync(path.join(root, producer), 'utf-8')}\n${unusedNeighborSource}`);
    const base = { entry: [`${tests}/*.test.mts`], node: false, project: [toolsPattern] };
    const consumerPath = path.join(root, auditConsumersFile);
    const model = yield* buildKnipModel(`${root}/`, base, consumerPath).pipe(Effect.provide(NodeServices.layer));
    for (const file of documents) {
      expect(
        model.evidence.some((fact) => fact.target === file && ['file', 'entry'].includes(fact.kind)),
        file,
      ).toBe(true);
    }
    for (const [file, name] of [
      [producer, 'makeAresAppliedEvidence'],
      [`${service}/branded-string-constructor.ts`, 'makeEntityId'],
    ]) {
      expect(
        model.evidence.some((fact) => fact.target === `${file}#${name}`),
        `${file}#${name}`,
      ).toBe(true);
    }
    expect(model.evidence.some((fact) => fact.target === neighbor || fact.target.endsWith('#unusedNeighbor'))).toBe(
      false,
    );
    const run = yield* runPinnedKnip(root, consumerPath, model).pipe(Effect.provide(NodeServices.layer));
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(1);
    const report = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ReportSchema))(run.stdout);
    const unusedFiles = report.issues.filter((issue) => issue.files.length > 0).map((issue) => issue.file);
    for (const file of documents) {
      expect(unusedFiles, file).not.toContain(file);
    }
    expect(unusedFiles).toContain(neighbor);
    for (const file of [configs[0], producer]) {
      expect(
        report.issues.find((issue) => issue.file === file)?.exports.map((item) => item.name),
        file,
      ).toContain(unusedNeighborName);
    }

    const actualHarness = readFileSync(path.join(root, harness), 'utf-8');
    for (const invalid of [
      actualHarness.replace('node:child_process', counterfeitModule),
      actualHarness.replace('process.execPath,', "'printf',"),
      actualHarness.replace("'-c', configPath", "'--unused', configPath"),
      actualHarness.replace('  const result = spawnSync(', '  const result = () => spawnSync('),
      actualHarness.replace('export function runOxlint', 'oxlintEntryPoint = replacement;\nexport function runOxlint'),
    ]) {
      write(root, harness, invalid);
      const control = yield* buildKnipModel(root, base).pipe(Effect.provide(NodeServices.layer));
      expect(control.evidence.some((fact) => fact.reason.startsWith('Native Oxlint'))).toBe(false);
    }
    write(root, harness, actualHarness);
    const consumer = `${tests}/decoded-unknown-parameter.test.mts`;
    const actualConsumer = readFileSync(path.join(root, consumer), 'utf-8');
    for (const invalid of [
      actualConsumer.replaceAll(', appRoot)', ", '/wrong-cwd')").replaceAll('    appRoot,', "    '/wrong-cwd',"),
      actualConsumer.replaceAll("from 'effect-rstest'", fakeMtsImport),
      actualConsumer.replaceAll('const run = runOxlint(', 'const run = () => runOxlint('),
      actualConsumer.replaceAll('const run = runOxlint(', 'const runOxlint = replacement; const run = runOxlint('),
    ]) {
      write(root, consumer, invalid);
      const control = yield* buildKnipModel(root, base).pipe(Effect.provide(NodeServices.layer));
      expect(control.evidence.some((fact) => fact.source === consumer && fact.reason.startsWith('Native Oxlint'))).toBe(
        false,
      );
    }
    write(root, consumer, actualConsumer);
    const actualParser = readFileSync(path.join(root, parser), 'utf-8');
    for (const invalid of [
      actualParser.replace("from 'node:fs'", fakeMtsImport),
      actualParser.replace(
        'const consumer = proof.load(filename);',
        'const consumer = null; void "proof.load(filename)";',
      ),
      actualParser.replace(
        'const owner = proof.imported(consumer, source);',
        'const owner = null; void "proof.imported(consumer, source)";',
      ),
      actualParser.replace('owner?.exports.get(importedName)', 'owner?.exports.get("wrong")'),
      actualParser.replace('path.resolve(path.dirname(model.filename), source)', 'path.resolve("/wrong", source)'),
    ]) {
      write(root, parser, invalid);
      const control = yield* buildKnipModel(root, base).pipe(Effect.provide(NodeServices.layer));
      expect(control.evidence.some((fact) => fact.reason.startsWith('Native factory parser'))).toBe(false);
    }
  }),
);

it.live(
  'native Vitest importActual reads only explicit members through a proven URL alias and preserves neighboring exports',
  Effect.fn(function* vitestNamespaceControls() {
    const root = yield* fixture();
    const owner = 'akros-storefront';
    const config = `${owner}/vitest.config.ts`;
    const consumer = `${owner}/tests/unit/catalog.test.ts`;
    const producer = `${owner}/src/ontos/catalog-server.ts`;
    write(
      root,
      `${owner}/package.json`,
      '{"name":"@fixture/storefront","type":"module","scripts":{"test":"vitest run"},"devDependencies":{"vitest":"5.0.2"}}',
    );
    symlinkSync(path.join(appRoot, owner, 'node_modules'), path.join(root, owner, 'node_modules'), 'dir');
    const configuration = [
      "import { fileURLToPath } from 'node:url'; import { defineConfig } from 'vitest/config';",
      "export default defineConfig({ resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } }, test: { include: ['tests/unit/*.test.ts'] } });",
    ].join('\n');
    const source = [
      "import { beforeEach, it, expect, vi } from 'vitest';",
      "type Server = typeof import('@/ontos/catalog-server'); let server: Server;",
      "beforeEach(async () => { server = await vi.importActual<Server>('@/ontos/catalog-server'); });",
      "it('uses actual members', () => { expect(server.CATALOG_CACHE_MS + server.CATEGORY_CACHE_MS).toBe(3); server.getCategoryTree(); });",
    ].join('\n');
    write(root, config, configuration);
    write(root, consumer, source);
    write(
      root,
      producer,
      'export const CATALOG_CACHE_MS = 1; export const CATEGORY_CACHE_MS = 2; export function getCategoryTree() { return []; } export const unusedNeighbor = 1;',
    );
    const consumerPath = path.join(root, auditConsumersFile);
    const base = {
      workspaces: { '.': { entry: [], project: [] }, [owner]: { entry: ['*.config.ts'], project: ['**/*.ts'] } },
    };
    const model = yield* buildKnipModel(root, base, consumerPath).pipe(Effect.provide(NodeServices.layer));
    const targets = EffectArray.sort(
      model.evidence.filter((fact) => fact.reason.startsWith(nativeVitestReason)).map((fact) => fact.target),
      Order.String,
    );
    expect(targets).toEqual(
      EffectArray.sort(
        ['CATALOG_CACHE_MS', 'CATEGORY_CACHE_MS', 'getCategoryTree'].map((name) => `${producer}#${name}`),
        Order.String,
      ),
    );
    const run = yield* runPinnedKnip(root, consumerPath, model).pipe(Effect.provide(NodeServices.layer));
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(1);
    const report = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ReportSchema))(run.stdout);
    expect(report.issues.find((issue) => issue.file === producer)?.exports.map((item) => item.name)).toEqual([
      unusedNeighborName,
    ]);
    const disconnected = yield* runPinnedKnip(root, consumerPath, { ...model, consumerSource: '' }).pipe(
      Effect.provide(NodeServices.layer),
    );
    const disconnectedReport = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ReportSchema))(
      disconnected.stdout,
    );
    expect(
      EffectArray.sort(
        disconnectedReport.issues.find((issue) => issue.file === producer)?.exports.map((item) => item.name) ?? [],
        Order.String,
      ),
    ).toEqual(
      EffectArray.sort(['CATALOG_CACHE_MS', 'CATEGORY_CACHE_MS', 'getCategoryTree', unusedNeighborName], Order.String),
    );
    for (const invalid of [
      source.replace("from 'vitest'", fakeTsImport),
      source.replace('beforeEach(async ()', 'unused(async ()'),
      source.replace('server = await vi.importActual', 'const server = await vi.importActual'),
      source.replace("it('uses", "server = replacement; it('uses"),
      source.replace('server = await vi.importActual', 'vi.importActual = replacement; server = await vi.importActual'),
      source
        .replace('server.CATALOG_CACHE_MS + server.CATEGORY_CACHE_MS', '0')
        .replace('server.getCategoryTree();', ''),
    ]) {
      write(root, consumer, invalid);
      const control = yield* buildKnipModel(root, base).pipe(Effect.provide(NodeServices.layer));
      expect(control.evidence.some((fact) => fact.reason.startsWith(nativeVitestReason))).toBe(false);
    }
    write(root, consumer, source);
    for (const invalid of [
      configuration.replace("from 'node:url'", fakeTsImport),
      configuration.replace("from 'vitest/config'", fakeTsImport),
      configuration.replace("new URL('./src', import.meta.url)", "new URL('./src', unknownBase)"),
      configuration.replace('export default', 'const URL = replacement; export default'),
      configuration.replace("['tests/unit/*.test.ts']", "['tests/other/*.test.ts']"),
    ]) {
      write(root, config, invalid);
      const control = yield* buildKnipModel(root, base).pipe(Effect.provide(NodeServices.layer));
      expect(control.evidence.some((fact) => fact.reason.startsWith(nativeVitestReason))).toBe(false);
    }
  }),
);

it.live(
  'native import.meta.main operators require a direct imported Effect runtime, not inert or foreign runners',
  Effect.fn(function* guardedOperatorControls() {
    const root = yield* fixture();
    const main = 'await Effect.runPromise(program);';
    const source = `import { Effect } from 'effect'; const program = Effect.void; if (import.meta.main) { ${main} }`;
    write(root, operatorFile, source);
    write(root, 'scripts/exit.mts', source.replace(main, 'const exit = await Effect.runPromiseExit(program);'));
    write(
      root,
      'scripts/runtime.mts',
      `import { NodeRuntime } from '@effect/platform-node'; const program = replacement; if (import.meta.main) { NodeRuntime.runMain(program); }`,
    );
    const invalid = [
      source.replace('import.meta.main', '!import.meta.main'),
      source.replace('import.meta.main', 'options.main'),
      source.replace(main, `const inert = async () => { ${main} };`),
      source.replace(main, `void ${JSON.stringify(main)};`),
      source.replace("from 'effect'", fakeMtsImport),
      source.replace(main, `Effect.runPromise = replacement; ${main}`),
      source.replace(main, 'Effect.runPromise(program);'),
    ];
    for (const [index, text] of invalid.entries()) {
      write(root, `scripts/not-main-${index}.mts`, text);
    }
    const consumerPath = path.join(root, auditConsumersFile);
    const model = yield* buildKnipModel(
      root,
      { entry: [], node: false, project: [operatorScriptPattern] },
      consumerPath,
    ).pipe(Effect.provide(NodeServices.layer));
    expect(
      EffectArray.sort(
        model.evidence.filter((fact) => fact.reason.startsWith('Native import.meta.main')).map((fact) => fact.target),
        Order.String,
      ),
    ).toEqual(['scripts/exit.mts', operatorFile, 'scripts/runtime.mts']);
    const run = yield* runPinnedKnip(root, consumerPath, model).pipe(Effect.provide(NodeServices.layer));
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(1);
    const report = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ReportSchema))(run.stdout);
    const files = report.issues.filter((issue) => issue.files.length > 0).map((issue) => issue.file);
    for (const [index] of invalid.entries()) {
      expect(files).toContain(`scripts/not-main-${index}.mts`);
    }
    expect(files).not.toContain(operatorFile);
  }),
);

it.live(
  'unguarded native Command CLIs and their documented side-effect wrappers retain nearby invalid controls',
  Effect.fn(function* nativeCommandCliControls() {
    const root = yield* fixture();
    const imports =
      "import { NodeRuntime } from '@effect/platform-node'; import { Effect } from 'effect'; import { Command } from 'effect/cli';";
    const command = "const command = Command.make('operator', {}, () => Effect.void);";
    const pipeline = "Command.run(command, { version: '1' }).pipe(Effect.scoped)";
    const main = `NodeRuntime.runMain(${pipeline});`;
    const runMain = `${imports}\n${command}\n${main}`;
    const awaited = `const exit = await Effect.runPromiseExit(${pipeline}, { signal: abort.signal });`;
    const signal = `${imports}\n${command}\nconst abort = new AbortController();\n${awaited}`;
    const commandFile = 'scripts/command-operator.mts';
    const signalFile = 'scripts/signal-operator.mts';
    const wrapperFile = 'scripts/command-wrapper.mts';
    const usage = `// node ${wrapperFile} [--help]\n`;
    const wrapper = `${usage}import './signal-operator.mts';`;
    write(root, commandFile, runMain);
    write(root, signalFile, signal);
    write(root, wrapperFile, wrapper);
    write(
      root,
      'scripts/command-alias.mts',
      runMain.replaceAll('NodeRuntime', 'Runtime').replace('{ Runtime }', '{ NodeRuntime as Runtime }'),
    );
    const invalid = [
      runMain.replace(main, `function unused() { ${main} }`),
      runMain.replace('effect/cli', counterfeitModule),
      runMain.replace(nativePlatformModule, counterfeitModule),
      runMain.replace(main, `Command.run = replacement; ${main}`),
      runMain.replace('Command.make', 'counterfeit.make'),
      runMain.replace('Effect.scoped)', 'foreign.scoped)'),
      signal.replace('await Effect.runPromiseExit', 'Effect.runPromiseExit'),
      signal.replace(awaited, `async function unused() { ${awaited} }`),
      signal.replace('new AbortController()', 'new ForeignController()'),
      signal.replace('const abort =', 'const AbortController = replacement; const abort ='),
      signal.replace('{ signal: abort.signal }', '{ signal: foreign.signal }'),
      signal.replace('{ signal: abort.signal }', '{ ...options, signal: abort.signal }'),
      signal.replace(awaited, `abort.signal = replacement; ${awaited}`),
      signal.replace('const abort =', 'let abort ='),
      signal.replace(awaited, `Effect.runPromiseExit = replacement; ${awaited}`),
    ];
    for (const [index, source] of invalid.entries()) {
      write(root, `scripts/not-command-${index}.mts`, source);
    }
    const consumerPath = path.join(root, auditConsumersFile);
    const base = { entry: [], node: false, project: [operatorScriptPattern] };
    const model = yield* buildKnipModel(root, base, consumerPath).pipe(Effect.provide(NodeServices.layer));
    const roots = model.evidence.filter(
      (fact) =>
        fact.reason.startsWith('Native top-level Command CLI') ||
        fact.reason.startsWith('Documented direct-node wrapper'),
    );
    expect(
      EffectArray.sort(
        roots.map((fact) => fact.target),
        Order.String,
      ),
    ).toEqual(EffectArray.sort([commandFile, signalFile, wrapperFile, 'scripts/command-alias.mts'], Order.String));
    const run = yield* runPinnedKnip(root, consumerPath, model).pipe(Effect.provide(NodeServices.layer));
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(1);
    const report = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ReportSchema))(run.stdout);
    const files = report.issues.filter((issue) => issue.files.length > 0).map((issue) => issue.file);
    for (const file of [commandFile, signalFile, wrapperFile]) {
      expect(files).not.toContain(file);
    }
    for (const [index] of invalid.entries()) {
      expect(files).toContain(`scripts/not-command-${index}.mts`);
    }
    for (const source of [
      wrapper.replace(usage, ''),
      wrapper.replace(wrapperFile, `${wrapperFile}-other`),
      wrapper.replace("import './signal-operator.mts'", "import { unused } from './signal-operator.mts'"),
      `${usage}const inert = "import './signal-operator.mts'";`,
      `${usage}import './not-command-0.mts';`,
      `${usage}import './guarded-command.mts';`,
    ]) {
      write(root, 'scripts/guarded-command.mts', runMain.replace(main, `if (import.meta.main) { ${main} }`));
      write(root, wrapperFile, source);
      const control = yield* buildKnipModel(root, base).pipe(Effect.provide(NodeServices.layer));
      expect(control.evidence.some((fact) => fact.source === wrapperFile && fact.kind === 'entry')).toBe(false);
    }
    // Parse actual operator bodies as source data, never import or execute their behavior.
    const operators = [
      'scripts/demo/migrate-domain-regroup-authorization.mts',
      'scripts/demo/mcp-oauth-e2e/dev-session.mts',
      'scripts/demo/mcp-oauth-e2e/prove-agent-entity.mts',
      'scripts/demo/prove-agent-entity.mts',
    ];
    for (const file of operators) {
      write(root, file, readFileSync(path.join(appRoot, file), 'utf-8'));
    }
    const actual = yield* buildKnipModel(root, base).pipe(Effect.provide(NodeServices.layer));
    for (const file of operators) {
      expect(
        actual.evidence.some((fact) => fact.source === file && fact.kind === 'entry'),
        file,
      ).toBe(true);
    }
  }),
);

it.live(
  'route.meta duplicate policy requires native same-binding contracts and the generated named consumer',
  Effect.fn(function* routeMetadataAliasControls() {
    const root = yield* fixture();
    // Replace only this fixture's owned symlink, never the shared installed dependency tree.
    rmSync(path.join(root, 'node_modules'));
    const generator = 'node_modules/@modern-js/ultramodern-create/dist/esm/ultramodern-workspace/routes.js';
    const loader =
      'node_modules/@modern-js/ultramodern-create/templates/workspace-scripts/generate-public-surface-assets.mjs';
    const owner = 'apps/route-contract';
    const route = `${owner}/src/routes/[lang]/set-password/route.meta.ts`;
    const metadata = `${owner}/src/routes/ultramodern-route-metadata.ts`;
    const source =
      "export const routeMeta = { id: 'password', ownerAppId: 'route-contract', canonicalPath: '/set-password' }; export default routeMeta;";
    const consumer =
      "import { routeMeta as route0 } from './[lang]/set-password/route.meta'; export const ultramodernRouteMetadata = [route0] as const;";
    const nativeGenerator = readFileSync(path.join(appRoot, generator), 'utf-8');
    const nativeLoader = readFileSync(path.join(appRoot, loader), 'utf-8');
    write(root, generator, nativeGenerator);
    write(root, loader, nativeLoader);
    write(root, `${owner}/package.json`, '{"name":"@fixture/route-contract","type":"module"}');
    write(root, route, source);
    write(root, metadata, consumer);
    write(root, `${owner}/src/arbitrary.ts`, 'export const arbitrary = { id: 1 }; export default arbitrary;');
    write(root, `${owner}/src/index.ts`, "import value, { arbitrary } from './arbitrary.ts'; void [value, arbitrary];");
    const base = {
      workspaces: {
        '.': { entry: [], project: [] },
        'apps/*': { entry: ['src/routes/**/*.ts', indexFile], project: ['src/**/*.ts'] },
      },
    };
    const consumerPath = path.join(root, auditConsumersFile);
    const model = yield* buildKnipModel(root, base, consumerPath).pipe(Effect.provide(NodeServices.layer));
    expect(model.evidence.some((fact) => fact.source === route && fact.kind === 'alias')).toBe(true);
    const run = yield* runPinnedKnip(root, consumerPath, model).pipe(Effect.provide(NodeServices.layer));
    const report = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ReportSchema))(run.stdout);
    expect(report.issues.find((issue) => issue.file === route)?.duplicates ?? []).toEqual([]);
    expect(report.issues.find((issue) => issue.file === `${owner}/src/arbitrary.ts`)?.duplicates.length).toBe(1);
    for (const [file, invalid] of [
      [route, source.replace('export default routeMeta;', 'export default { ...routeMeta };')],
      [metadata, consumer.replace('[route0]', '[]')],
      [metadata, consumer.replace('routeMeta as', 'other as')],
      [generator, nativeGenerator.replace('export default routeMeta;', 'export default other;')],
      [loader, nativeLoader.replace('module.routeMeta ??', 'module.wrong ??')],
      [generator, `const inert = ${JSON.stringify(nativeGenerator)};`],
    ]) {
      write(root, file, invalid);
      const control = yield* buildKnipModel(root, base).pipe(Effect.provide(NodeServices.layer));
      expect(control.evidence.some((fact) => fact.source === route && fact.kind === 'alias')).toBe(false);
      write(root, route, source);
      write(root, metadata, consumer);
      write(root, generator, nativeGenerator);
      write(root, loader, nativeLoader);
    }
  }),
);

it.live(
  'native runMain accepts an immutable Effect generator program but rejects foreign and inert operator lookalikes',
  Effect.fn(function* generatorCliControls() {
    const root = yield* fixture();
    const source =
      "import { NodeRuntime } from '@effect/platform-node'; import { Effect } from 'effect'; const program = Effect.gen(function* () { return 1; }); NodeRuntime.runMain(program);";
    const file = 'scripts/sql-printer.mts';
    write(root, file, source);
    const invalid = [
      source.replace("from 'effect'", fakeMtsImport),
      source.replace(nativePlatformModule, counterfeitModule),
      source.replace('const program', 'let program'),
      source.replace(nativeProgramMain, 'program = replacement; NodeRuntime.runMain(program);'),
      source.replace(nativeProgramMain, 'function unused() { NodeRuntime.runMain(program); }'),
      source.replace('Effect.gen(function* () { return 1; })', 'foreign.gen(function* () { return 1; })'),
      source.replace('Effect.gen(function* () { return 1; })', 'Effect.gen(() => 1)'),
      source.replace(nativeProgramMain, 'NodeRuntime.runMain = replacement; NodeRuntime.runMain(program);'),
    ];
    for (const [index, text] of invalid.entries()) {
      write(root, `scripts/not-generator-${index}.mts`, text);
    }
    const consumerPath = path.join(root, auditConsumersFile);
    const base = { entry: [], node: false, project: [operatorScriptPattern] };
    const model = yield* buildKnipModel(root, base, consumerPath).pipe(Effect.provide(NodeServices.layer));
    expect(model.evidence.some((fact) => fact.source === file && fact.kind === 'entry')).toBe(true);
    for (const [index] of invalid.entries()) {
      expect(
        model.evidence.some((fact) => fact.source === `scripts/not-generator-${index}.mts` && fact.kind === 'entry'),
      ).toBe(false);
    }
    const run = yield* runPinnedKnip(root, consumerPath, model).pipe(Effect.provide(NodeServices.layer));
    const report = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ReportSchema))(run.stdout);
    expect(report.issues.filter((issue) => issue.files.length > 0).map((issue) => issue.file)).not.toContain(file);
    for (const [index] of invalid.entries()) {
      expect(run.stdout).toContain(`scripts/not-generator-${index}.mts`);
    }
    const actual = 'verticals/facility-operations/scripts/seed/assets-sql.mts';
    write(root, 'verticals/facility-operations/package.json', '{"name":"@fixture/facility","type":"module"}');
    write(root, actual, readFileSync(path.join(appRoot, actual), 'utf-8'));
    const real = yield* buildKnipModel(root, {
      workspaces: { '.': base, 'verticals/*': { entry: [], project: [operatorScriptPattern] } },
    }).pipe(Effect.provide(NodeServices.layer));
    expect(real.evidence.some((fact) => fact.source === actual && fact.kind === 'entry')).toBe(true);
  }),
);

it.live(
  'native Rstest includes admit an exact colocated test and its real schema imports, not adjacent source',
  Effect.fn(function* nativeRstestIncludeControls() {
    const root = yield* fixture();
    const owner = 'verticals/colocated';
    const manifest = `${owner}/package.json`;
    const config = `${owner}/rstest.config.ts`;
    const test = `${owner}/src/routes/[lang]/documents.test.ts`;
    const declarations = `${owner}/src/documents.ts`;
    const script = '{"name":"@fixture/colocated","type":"module","scripts":{"test:unit":"rstest --project unit"}}';
    const source =
      "import { defineConfig } from '@rstest/core'; export default defineConfig({ name: 'unit', root: new URL('.', import.meta.url).pathname, include: ['src/routes/[[]lang]/documents.test.ts'] });";
    write(root, manifest, script);
    write(root, config, source);
    write(
      root,
      declarations,
      'export const DocumentSchema = 1; export const DocumentVersionSchema = 2; export const unusedNeighbor = 3;',
    );
    write(
      root,
      test,
      "import { it } from 'effect-rstest'; import { DocumentSchema, DocumentVersionSchema } from '../../documents.ts'; it('consumes schemas', () => { void [DocumentSchema, DocumentVersionSchema]; });",
    );
    write(root, `${owner}/src/routes/[lang]/not-a-test.ts`, unusedNeighborSource);
    const base = {
      workspaces: {
        '.': { entry: [], project: [] },
        'verticals/*': { entry: [], project: ['**/*.ts'], rstest: { config: [], entry: ['tests/**/*.test.ts'] } },
      },
    };
    const consumerPath = path.join(root, auditConsumersFile);
    const model = yield* buildKnipModel(root, base, consumerPath).pipe(Effect.provide(NodeServices.layer));
    expect(
      model.evidence
        .filter((fact) => fact.reason.startsWith('Native manifest-invoked Rstest'))
        .map((fact) => fact.target),
    ).toEqual(['src/routes/[lang]/documents.test.ts']);
    const run = yield* runPinnedKnip(root, consumerPath, model).pipe(Effect.provide(NodeServices.layer));
    const report = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ReportSchema))(run.stdout);
    expect(report.issues.find((issue) => issue.file === declarations)?.exports.map((item) => item.name)).toEqual([
      unusedNeighborName,
    ]);
    expect(report.issues.find((issue) => issue.file === `${owner}/src/routes/[lang]/not-a-test.ts`)?.files.length).toBe(
      1,
    );
    for (const [file, invalid] of [
      [config, source.replace('@rstest/core', counterfeitModule)],
      [config, source.replace("new URL('.',", "new URL('../',")],
      [config, source.replace('export default defineConfig(', 'const inert = defineConfig(')],
      [config, source.replace("name: 'unit'", "name: 'other'")],
      [config, source.replace('include: [', "exclude: ['**/*'], include: [")],
      [manifest, script.replace('rstest --project unit', 'echo rstest --project unit')],
    ]) {
      write(root, file, invalid);
      const control = yield* buildKnipModel(root, base).pipe(Effect.provide(NodeServices.layer));
      expect(control.evidence.some((fact) => fact.reason.startsWith('Native manifest-invoked Rstest'))).toBe(false);
      write(root, config, source);
      write(root, manifest, script);
    }
  }),
);
