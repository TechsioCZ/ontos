#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { hasCompleteGeneratedModuleApiSeam } from './generated-module-api-boundary.mts';
import { privateOwnerImportViolation } from './ultramodern-api-boundary-rules.mts';

const workspaceRoot = process.env.ULTRAMODERN_WORKSPACE_ROOT ?? process.cwd();
const failures: string[] = [];

const ignoredDirectories = new Set([
  '.git',
  '.modern',
  '.output',
  'coverage',
  'dist',
  'dist-cloudflare',
  'node_modules',
  'repos',
]);

const normalize = (filePath: string): string => filePath.split(path.sep).join('/');

const relative = (filePath: string): string => normalize(path.relative(workspaceRoot, filePath));

const exists = (relativePath: string): boolean =>
  fs.existsSync(path.join(workspaceRoot, relativePath));

const readText = (relativePath: string): string =>
  fs.readFileSync(path.join(workspaceRoot, relativePath), 'utf-8');

const fail = (message: string): void => {
  failures.push(message);
};

const assert = (condition: boolean, message: string): void => {
  if (!condition) {
    fail(message);
  }
};

const listFiles = (startDirectory: string): string[] => {
  const absoluteStart = path.join(workspaceRoot, startDirectory);
  if (!fs.existsSync(absoluteStart)) {
    return [];
  }

  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (ignoredDirectories.has(entry.name)) {
        continue;
      }

      const absoluteEntry = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absoluteEntry);
        continue;
      }

      if (entry.isFile()) {
        files.push(relative(absoluteEntry));
      }
    }
  };

  visit(absoluteStart);
  return files;
};

const listDirectories = (startDirectory: string): string[] => {
  const absoluteStart = path.join(workspaceRoot, startDirectory);
  if (!fs.existsSync(absoluteStart)) {
    return [];
  }

  return fs
    .readdirSync(absoluteStart, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !ignoredDirectories.has(entry.name))
    .map((entry) => path.posix.join(startDirectory, entry.name));
};

const assertNoPath = (relativePath: string, message: string): void => {
  if (exists(relativePath)) {
    fail(message);
  }
};

const assertContains = (
  relativePath: string,
  content: string,
  pattern: RegExp,
  message: string,
): void => {
  assert(pattern.test(content), `${relativePath}: ${message}`);
};

const assertNotContains = (
  relativePath: string,
  content: string,
  pattern: RegExp,
  message: string,
): void => {
  assert(!pattern.test(content), `${relativePath}: ${message}`);
};

const isGeneratedInfrastructureReadinessApi = (verticalPath: string, content: string): boolean => {
  const stem = path.posix.basename(verticalPath);
  const endpoints = [
    ...content.matchAll(/HttpApiEndpoint\.(get|post)\(\s*'([^']+)'\s*,\s*'([^']+)'/gu),
  ].map((match) => `${match[1]}:${match[2]}:${match[3]}`);
  return (
    endpoints.length === 1 &&
    endpoints[0] === `get:readiness:/${stem}/readiness` &&
    content.includes(`export const ${stem}ApiContract = {`) &&
    content.includes(`readinessPath: '/${stem}-api/${stem}/readiness'`)
  );
};

const assertPrivateOwnerImports = (file, content) => {
  const imports = content.matchAll(
    /(?:from\s+|import\s*\(|require\s*\()\s*['"](?<specifier>[^'"]+)['"]/gu,
  );
  for (const match of imports) {
    const specifier = match.groups?.specifier;
    if (specifier === undefined) continue;
    const violation = privateOwnerImportViolation(workspaceRoot, file, specifier);
    if (violation !== undefined) {
      fail(`${file}: ${violation}. Discover other deployments as allowlisted data.`);
    }
  }
};

for (const forbiddenPath of [
  ...listDirectories('apps').flatMap((appPath) => [
    `${appPath}/api/effect`,
    `${appPath}/api/lambda`,
    `${appPath}/shared/effect`,
    `${appPath}/src/effect`,
  ]),
  ...listDirectories('verticals').flatMap((verticalPath) => [
    `${verticalPath}/api/effect`,
    `${verticalPath}/api/lambda`,
    `${verticalPath}/shared/effect`,
    `${verticalPath}/src/effect`,
  ]),
]) {
  assertNoPath(
    forbiddenPath,
    `${forbiddenPath} is forbidden in UltraModern strictEffectApproach workspaces; use api/index.ts, shared/api.ts and src/api/* instead.`,
  );
}

const generatedFiles = [...listFiles('apps'), ...listFiles('verticals'), ...listFiles('packages')];
const textFiles = generatedFiles.filter((file) =>
  /\.(?:[cm]?[jt]sx?|json|md|mjs|mts|cts)$/u.test(file),
);

for (const file of textFiles) {
  const content = readText(file);

  assertPrivateOwnerImports(file, content);
  assertNotContains(
    file,
    content,
    /(?:from\s+|import\s*\(|require\s*\()\s*['"]@app\/[a-z0-9-]+\/(?:src|workers|worker-host)\//u,
    'cross-MicroVertical imports must use generated API clients, Module Federation, or schema-only Outbox exports rather than private source paths.',
  );

  if (/\/api\//u.test(file)) {
    assertNotContains(
      file,
      content,
      /\bnew\s+Response\s*\(|\bResponse\.json\s*\(/u,
      'API modules must not hand-build Response objects; model endpoints through Effect HttpApi and schemas.',
    );
    assertNotContains(
      file,
      content,
      /\b(?:request|req)\.(?:json|text|formData|arrayBuffer)\s*\(/u,
      'API modules must not manually parse request bodies; use HttpApiEndpoint payload/query/params schemas.',
    );
    assertNotContains(
      file,
      content,
      /\bexport\s+const\s+handler\b|\bexport\s+default\s+async\b/u,
      'API modules must not export raw request handlers; export defineEffectBff(...) from api/index.ts.',
    );
    assertNotContains(
      file,
      content,
      /\bcreateHandler\s*[:=]\s*(?!defineEffectBff\b)/u,
      'API modules must not define unbranded handler factories; use defineEffectBff(...).',
    );
    assertNotContains(
      file,
      content,
      /\bSchema\.(?:UnknownFromJsonString|Unknown|Any)\b/u,
      'API modules must use concrete request, response and error schemas; Schema.UnknownFromJsonString, Schema.Unknown and Schema.Any are forbidden in UltraModern API code.',
    );
  }

  assertNotContains(
    file,
    content,
    /@modern-js\/plugin-bff\/hono-server/u,
    'UltraModern API workspaces must not import Hono server helpers; use @modern-js/plugin-bff/effect-edge and HttpApi.',
  );
  assertNotContains(
    file,
    content,
    /\bruntimeFramework\s*(?::|=)\s*['"]hono['"]/u,
    'Generated UltraModern API apps must use the Effect runtime.',
  );
  assertNotContains(
    file,
    content,
    /\bstrictEffectApproach\s*(?::|=)\s*false\b/u,
    'Generated UltraModern API apps must keep strictEffectApproach enabled.',
  );
}

const verticalDirectories = listDirectories('verticals').filter((verticalPath) =>
  exists(`${verticalPath}/package.json`),
);
const shellClient = 'apps/shell-super-app/src/api/vertical-clients.ts';
if (exists('apps/shell-super-app') && verticalDirectories.length > 0) {
  assert(exists(shellClient), `${shellClient} must aggregate vertical API clients.`);
}

const assertApiSurface = (appPath: string): void => {
  const apiEntry = `${appPath}/api/index.ts`;
  const backendEffectExpose = `${appPath}/api/effect-api.ts`;
  const sharedApi = `${appPath}/shared/api.ts`;
  const srcApiDirectory = `${appPath}/src/api`;
  const modernConfig = `${appPath}/modern.config.ts`;
  const packageJsonPath = `${appPath}/package.json`;

  assert(exists(apiEntry), `${apiEntry} is required.`);
  assert(exists(sharedApi), `${sharedApi} is required.`);
  assert(exists(srcApiDirectory), `${srcApiDirectory} is required.`);

  if (exists(srcApiDirectory)) {
    const clientFiles = listFiles(srcApiDirectory).filter((file) => file.endsWith('-client.ts'));
    assert(clientFiles.length > 0, `${srcApiDirectory} must contain a generated API client.`);
  }

  if (exists(apiEntry)) {
    const entry = readText(apiEntry);
    assertContains(
      apiEntry,
      entry,
      /\bdefineEffectBff\b/u,
      'must export a defineEffectBff(...) runtime definition.',
    );
    assertContains(
      apiEntry,
      entry,
      /\bHttpApiBuilder\b/u,
      'must implement handlers through HttpApiBuilder.',
    );
    assertContains(apiEntry, entry, /\bLayer\b/u, 'must compose dependencies with Effect Layer.');
    assertContains(
      apiEntry,
      entry,
      /from ['"]\.\.\/shared\/api\.ts['"]/u,
      'must import the contract from ../shared/api.ts.',
    );
  }
  if (exists(backendEffectExpose)) {
    const backendExpose = readText(backendEffectExpose);
    assertContains(
      backendEffectExpose,
      backendExpose,
      /backendFederationContract/u,
      'must export backendFederationContract metadata.',
    );
    assertContains(
      backendEffectExpose,
      backendExpose,
      /role:\s*['"]microvertical-server['"]/u,
      'must describe the MicroVertical server role.',
    );
    assertContains(
      backendEffectExpose,
      backendExpose,
      /strictEffectApproach:\s*true/u,
      'must preserve strict Effect backend execution.',
    );
    assertContains(
      backendEffectExpose,
      backendExpose,
      /contractVersion:\s*['"]microvertical-server-effect-v1['"]/u,
      'must preserve the MicroVertical server contract version.',
    );
    assertContains(
      backendEffectExpose,
      backendExpose,
      /export\s*\{\s*default\s*,\s*default\s+as\s+runtime\s*\}\s+from\s+['"]\.\/index\.ts['"]/u,
      'must re-export the generated Effect BFF runtime as both default and runtime.',
    );
    assert(
      !/\b(?<member>request|handler)\s*:\s*async\s*\(/u.test(backendExpose),
      `${backendEffectExpose}: must not expose raw request handlers.`,
    );
  }

  if (exists(sharedApi)) {
    const contract = readText(sharedApi);
    assertContains(sharedApi, contract, /\bHttpApi\.make\b/u, 'must declare the HttpApi contract.');
    assertContains(sharedApi, contract, /\bHttpApiGroup\.make\b/u, 'must declare HttpApi groups.');
    assertContains(
      sharedApi,
      contract,
      /\bHttpApiEndpoint\./u,
      'must declare endpoints through HttpApiEndpoint.',
    );
    assertContains(
      sharedApi,
      contract,
      /\bSchema\./u,
      'must use Schema for request, response and error shapes.',
    );
  }

  if (exists(modernConfig)) {
    const config = readText(modernConfig);
    assertContains(
      modernConfig,
      config,
      /runtimeFramework:\s*['"]effect['"]/u,
      'must use bff.runtimeFramework: effect.',
    );
    assertContains(
      modernConfig,
      config,
      /entry:\s*['"]\.\/api\/index['"]/u,
      'must point bff.effect.entry at ./api/index.',
    );
    assertContains(
      modernConfig,
      config,
      /strictEffectApproach:\s*true/u,
      'must enable strictEffectApproach explicitly.',
    );
  }

  if (exists(packageJsonPath)) {
    const packageJson = JSON.parse(readText(packageJsonPath));
    const isPrivateVerticalInfrastructureApi =
      appPath.startsWith('verticals/') &&
      exists(sharedApi) &&
      isGeneratedInfrastructureReadinessApi(appPath, readText(sharedApi));
    if (isPrivateVerticalInfrastructureApi) {
      assert(
        packageJson.exports?.['./api'] === undefined &&
          packageJson.exports?.['./api/client'] === undefined,
        `${packageJsonPath}: infrastructure-only vertical APIs must remain private deployment surfaces.`,
      );
    } else {
      assert(
        packageJson.exports?.['./api'] === './shared/api.ts',
        `${packageJsonPath}: package must export ./api from shared/api.ts.`,
      );
      assert(
        typeof packageJson.exports?.['./api/client'] === 'string' &&
          packageJson.exports['./api/client'].startsWith('./src/api/'),
        `${packageJsonPath}: package must export ./api/client from src/api/*.`,
      );
    }
  }
};

for (const appPath of listDirectories('apps')) {
  if (exists(`${appPath}/api/index.ts`) || exists(`${appPath}/shared/api.ts`)) {
    assertApiSurface(appPath);
  }
}

for (const verticalPath of verticalDirectories) {
  assertApiSurface(verticalPath);
  const sharedApi = `${verticalPath}/shared/api.ts`;
  const sharedApiContent = exists(sharedApi) ? readText(sharedApi) : '';
  const verticalSources = new Map(
    listFiles(verticalPath).map((file) => [file, readText(file)] as const),
  );
  if (
    /\bHttpApiEndpoint\./u.test(sharedApiContent) &&
    !isGeneratedInfrastructureReadinessApi(verticalPath, sharedApiContent) &&
    !hasCompleteGeneratedModuleApiSeam(verticalSources, sharedApi)
  ) {
    fail(
      `${sharedApi}: module APIs require an approved Codesmith generator, structured api registration, verified trusted tenant context, and the server ModuleEntrypointGateway before an endpoint may be introduced.`,
    );
  }
}

if (exists('apps/shell-super-app/package.json')) {
  const shellPackageJson = JSON.parse(readText('apps/shell-super-app/package.json'));
  assert(
    shellPackageJson.exports?.['./api/clients'] === './src/api/vertical-clients.ts',
    'apps/shell-super-app/package.json must export ./api/clients.',
  );
}

if (exists('package.json')) {
  const rootPackageJson = JSON.parse(readText('package.json'));
  assert(
    rootPackageJson.scripts?.['api:check'] ===
      'node ./scripts/check-ultramodern-api-boundaries.mts',
    'Root package.json must expose api:check.',
  );
  assert(
    rootPackageJson.scripts?.check?.includes('pnpm api:check'),
    'Root check script must include pnpm api:check.',
  );
}

if (exists('topology/reference-topology.json')) {
  const topology = JSON.parse(readText('topology/reference-topology.json'));
  for (const vertical of topology.verticals ?? []) {
    if (vertical.api?.runtime === 'effect') {
      assert(
        vertical.api.bff?.strictEffectApproach === true,
        `${vertical.id} topology must mark strictEffectApproach as true.`,
      );
      assert(
        typeof vertical.api.serverEntry === 'string' &&
          vertical.api.serverEntry.endsWith('/api/index.ts'),
        `${vertical.id} topology must use api/index.ts as the server entry.`,
      );
    }
    assert(
      !vertical.api?.effect,
      `${vertical.id} topology must describe the API directly, not under api.effect.`,
    );
  }
}

if (failures.length > 0) {
  console.error('UltraModern API boundary check failed:');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log('UltraModern API boundary check passed.');
