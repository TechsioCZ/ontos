import { readFile } from 'node:fs/promises';
import { createCodesmithGenerator } from '../generator-adapter.mts';
import {
  asJsonObject,
  createMutation,
  ensureUniqueMutationPaths,
  requiredString,
  resolveContainedPath,
  updateMutation,
} from '../shared.mts';
import type {
  JsonObject,
  JsonValue,
  MicroverticalScaffoldConfig,
  MicroverticalScaffoldResult,
  Mutation,
  ScaffoldPlan,
} from '../shared.mts';

const slugPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const json = (value: JsonValue) => `${JSON.stringify(value, null, 2)}\n`;
const readJson = async (filePath: string) => {
  const content = await readFile(filePath, 'utf8');
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(content) as JsonValue;
  } catch {
    throw new Error(`invalid JSON at ${filePath}`);
  }
  return { content, value: asJsonObject(parsed, filePath) };
};
const pushUpdate = (mutations: Mutation[], filePath: string, before: string, after: string) => {
  const mutation = updateMutation(filePath, before, after);
  if (mutation !== undefined) mutations.push(mutation);
};
const title = (slug: string) =>
  slug
    .split('-')
    .map((part) => `${part[0]?.toUpperCase()}${part.slice(1)}`)
    .join('');
const zeropsService = (slug: string, port: number) => `  - setup: '${slug}'
    build:
      base: 'alpine@3.23'
      prepareCommands:
        - sudo apk add --no-cache curl libstdc++
        - sh /build/source/app/scripts/install-zerops-node.sh --with-pnpm
      buildCommands:
        - cd app && PATH="$HOME/.local/node-26.5.0/bin:$PATH" node scripts/reset-workspace-dependencies.mjs
        - cd app && PNPM_CONFIG_ENABLE_GLOBAL_VIRTUAL_STORE=false PATH="$HOME/.local/node-26.5.0/bin:$PATH" pnpm install --frozen-lockfile --force --config.enable-global-virtual-store=false --virtual-store-dir=node_modules/.pnpm
        - cd app && NODE_OPTIONS=--max-old-space-size=4096 PNPM_CONFIG_ENABLE_GLOBAL_VIRTUAL_STORE=false ULTRAMODERN_SOURCE_REVISION="$(git rev-parse HEAD)" PATH="$HOME/.local/node-26.5.0/bin:$PATH" pnpm --config.enable-global-virtual-store=false --filter '@app/${slug}' run build
        - cd app && PNPM_CONFIG_ENABLE_GLOBAL_VIRTUAL_STORE=false PATH="$HOME/.local/node-26.5.0/bin:$PATH" pnpm --config.enable-global-virtual-store=false run zerops:materialize -- --app '${slug}' --package '@app/${slug}' --package-dir 'verticals/${slug}'
        - cp 'app/topology/reference-topology.json' 'app/.zerops/runtime/${slug}/topology.json'
        - cp 'app/topology/local-overlays/development.json' 'app/.zerops/runtime/${slug}/local-overlay.json'
      deployFiles:
        - 'app/.zerops/runtime/${slug}'
        - 'app/scripts/install-zerops-node.sh'
    deploy:
      temporaryShutdown: false
      readinessCheck:
        httpGet:
          port: ${port}
          path: '/${slug}-api/${slug}/readiness'
        failureTimeout: 3m
        retryPeriod: 10s
    run:
      base: 'nodejs@24'
      initCommands:
        - ZEROPS_NODE_ROOT=/var/www sh app/scripts/install-zerops-node.sh
      ports:
        - port: ${port}
          protocol: tcp
          httpSupport: true
      envVariables:
        NODE_ENV: production
        PORT: '${port}'
        SPICEDB_ENDPOINT: 'spicedb:50051'
        SPICEDB_INSECURE: 'true'
        ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: stage
        ULTRAMODERN_ZEROPS_SERVICE: ${slug}
        VERTICAL_${slug.replaceAll('-', '_').toUpperCase()}_PORT: '${port}'
      healthCheck:
        httpGet:
          port: ${port}
          path: '/${slug}-api/${slug}/readiness'
      start: sh -c 'cd app/.zerops/runtime/${slug} && PATH="/var/www/.local/node-26.5.0/bin:$PATH" exec npm run serve'

`;

const baseFiles = (slug: string, port: number): Readonly<Record<string, string>> => ({
  'package.json': json({
    name: `@app/${slug}`,
    version: '0.1.0',
    private: true,
    type: 'module',
    exports: { './api': './shared/api.ts', './api/client': `./src/api/${slug}-client.ts` },
    scripts: {
      build: 'modern build && MODERNJS_DEPLOY=node modern deploy --skip-build',
      'cloudflare:build':
        'MODERNJS_DEPLOY=cloudflare modern build && MODERNJS_DEPLOY=cloudflare modern deploy --skip-build',
      'db:generate': 'drizzle-kit generate --config drizzle.config.ts',
      'db:migrate': 'drizzle-kit migrate --config drizzle.config.ts',
      'db:verify': 'node scripts/verify-db-schema.mts',
      dev: 'modern dev',
      serve: 'modern serve',
      typecheck: 'node ../../scripts/ultramodern-typecheck.mts --project tsconfig.json',
    },
    dependencies: {
      '@app/shared-contracts': 'workspace:*',
      '@modern-js/plugin-bff': 'npm:@bleedingdev/modern-js-plugin-bff@3.8.2-ultramodern.12',
      '@modern-js/runtime': 'npm:@bleedingdev/modern-js-runtime@3.8.2-ultramodern.12',
      '@module-federation/modern-js-v3': '2.8.0',
      '@module-federation/runtime': '2.8.0',
      'drizzle-orm': '0.45.2',
      effect: '4.0.0-beta.107',
      pg: '8.22.0',
      react: '19.2.8',
      'react-dom': '19.2.8',
    },
    devDependencies: {
      '@effect/tsgo': '0.19.0',
      '@modern-js/app-tools': 'npm:@bleedingdev/modern-js-app-tools@3.8.2-ultramodern.12',
      '@types/node': '^20',
      '@types/pg': '8.20.0',
      '@types/react': '^19.2.17',
      '@types/react-dom': '^19.2.3',
      'drizzle-kit': '0.31.10',
      typescript: '7.0.2',
    },
    modernjs: {
      appId: slug,
      apiRuntime: 'effect',
      preset: 'presetUltramodern',
      role: 'module-federation-remote',
      topology: '../../topology/reference-topology.json',
    },
  }),
  'tsconfig.json': json({
    extends: '../../tsconfig.base.json',
    compilerOptions: {
      composite: true,
      declaration: true,
      declarationMap: false,
      emitDeclarationOnly: true,
      incremental: true,
      noEmit: false,
      skipLibCheck: true,
      outDir: `../../node_modules/.cache/tsgo/declarations/verticals__${slug}`,
      tsBuildInfoFile: `../../node_modules/.cache/tsgo/verticals__${slug}.tsbuildinfo`,
    },
    include: ['api/**/*.ts', 'shared/**/*.ts', 'src/**/*.ts', '*.ts'],
    references: [
      { path: '../../packages/core-runtime' },
      { path: '../../packages/shared-contracts' },
    ],
  }),
  'drizzle.config.ts': `import { defineConfig } from 'drizzle-kit';\nexport default defineConfig({ dialect: 'postgresql', out: './drizzle', schema: './src/db/schema.ts' });\n`,
  'src/db/schema.ts': `import { pgSchema } from 'drizzle-orm/pg-core';\nexport const ${slug.replaceAll('-', '')}Schema = pgSchema('${slug}');\nexport const ${slug.replaceAll('-', '')}DatabaseSchema = {} as const;\n`,
  'shared/api.ts': `export const ${slug.replaceAll('-', '')}ApiContract = { appId: '${slug}', basePath: '/${slug}-api/${slug}' } as const;\n`,
  [`src/api/${slug}-client.ts`]: `export { ${slug.replaceAll('-', '')}ApiContract } from '../../shared/api.ts';\n`,
  'api/index.ts': `export const ${slug.replaceAll('-', '')}ApiRuntime = { appId: '${slug}', readinessPath: '/${slug}/readiness' } as const;\n`,
  'api/effect-api.ts': `export { ${slug.replaceAll('-', '')}ApiRuntime } from './index.ts';\n`,
  'src/App.tsx': `const App = () => null;\nexport default App;\n`,
  'module-federation.config.ts': `import { createModuleFederationConfig } from '@module-federation/modern-js-v3';\nconst config: ReturnType<typeof createModuleFederationConfig> = createModuleFederationConfig({ exposes: {}, filename: 'remoteEntry.js', name: 'vertical${title(slug)}' });\nexport default config;\n`,
  'backend-federation.config.ts': `import { createModuleFederationConfig } from '@module-federation/modern-js-v3';\nconst config: ReturnType<typeof createModuleFederationConfig> = createModuleFederationConfig({ dts: false, exposes: { './effect-api': './api/effect-api.ts' }, filename: 'backendRemoteEntry.cjs', library: { type: 'commonjs-module' }, name: 'vertical${title(slug)}Backend' });\nexport default config;\n`,
  'modern.config.ts': `import { appTools, defineConfig } from '@modern-js/app-tools';\nimport { bffPlugin } from '@modern-js/plugin-bff';\nimport { moduleFederationPlugin } from '@module-federation/modern-js-v3';\nexport default defineConfig({ plugins: [appTools(), bffPlugin(), moduleFederationPlugin()], server: { port: ${port} } });\n`,
});

const deployment = (slug: string, port: number): JsonObject => {
  const unit = {
    schemaVersion: 1,
    kind: 'microvertical-delivery-unit',
    unitId: `app/${slug}`,
    packageName: `@app/${slug}`,
    version: '0.1.0',
    buildMarker: 'workspace',
    sourceRevision: 'workspace',
  };
  const ownership = {
    team: 'super-app-platform',
    slack: '#super-app-platform',
    pagerDuty: 'pd-super-app-platform',
    runbookRef: `runbooks/verticals/${slug}.md`,
    adrRef: `docs/super-app-rfc-adr/verticals.md#${slug}`,
    blastRadius: {
      tier: 'tier-2-vertical',
      references: [`docs/super-app-rfc-adr/blast-radius.md#${slug}`],
    },
  };
  return {
    id: slug,
    kind: 'vertical',
    domain: slug,
    package: `@app/${slug}`,
    path: `verticals/${slug}`,
    moduleFederation: {
      role: 'remote',
      name: `vertical${title(slug)}`,
      manifestUrl: `http://localhost:${port}/mf-manifest.json`,
      exposes: [],
      ssr: true,
      sharedContractVersion: 'mf-ssr-contract-v1',
    },
    backendFederation: {
      role: 'microvertical-server',
      name: `vertical${title(slug)}Backend`,
      runtimeFramework: 'effect',
      strictEffectApproach: true,
      deliveryUnit: unit,
      exposes: {
        './effect-api': {
          contract: `verticals/${slug}/shared/api.ts`,
          runtime: `verticals/${slug}/api/index.ts`,
          client: `verticals/${slug}/src/api/${slug}-client.ts`,
          openapi: `/${slug}-api/openapi.json`,
          readiness: `/${slug}-api/${slug}/readiness`,
        },
      },
    },
    deliveryUnit: unit,
    api: {
      runtime: 'effect',
      bff: { prefix: `/${slug}-api`, openapi: '/openapi.json', strictEffectApproach: true },
      contract: { export: './api', path: `verticals/${slug}/shared/api.ts` },
      client: { export: './api/client', path: `verticals/${slug}/src/api/${slug}-client.ts` },
      serverEntry: `verticals/${slug}/api/index.ts`,
      basePath: `/${slug}-api/${slug}`,
      consumedBy: ['shell-super-app', slug],
      readiness: {
        endpoint: `/${slug}/readiness`,
        checks: ['moduleFederation', 'ssr', 'translations', 'api'],
      },
    },
    cloudflare: {
      target: 'cloudflare',
      workerName: `app-${slug}`,
      publicUrlEnv: `ULTRAMODERN_PUBLIC_URL_${slug.replaceAll('-', '_').toUpperCase()}`,
      compatibilityDate: '2026-06-02',
      compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'],
      assetsBinding: 'ASSETS',
      routes: { apiReadiness: `/${slug}-api/${slug}/readiness` },
      jsonSmokeChecks: [
        {
          id: `${slug}-readiness-smoke`,
          route: `/${slug}-api/${slug}/readiness`,
          expect: { status: 'ready' },
        },
      ],
    },
    ownership,
  };
};

export const planMicroverticalScaffold = async (
  workspaceRoot: string,
  config: MicroverticalScaffoldConfig,
): Promise<ScaffoldPlan<MicroverticalScaffoldResult>> => {
  const slug = requiredString(config.vertical, 'vertical');
  if (!slugPattern.test(slug)) throw new Error('vertical must be lower-kebab-case');
  if (!/^\d+$/u.test(config.port))
    throw new Error('port must be an integer between 1024 and 65535');
  const port = Number(config.port);
  if (port < 1024 || port > 65535)
    throw new Error('port must be an integer between 1024 and 65535');
  const packagePath = `verticals/${slug}`;
  const mutations: Mutation[] = [];
  for (const [relative, content] of Object.entries(baseFiles(slug, port)))
    mutations.push(
      await createMutation(resolveContainedPath(workspaceRoot, packagePath, relative), content),
    );
  const topologyPath = resolveContainedPath(workspaceRoot, 'topology/reference-topology.json');
  const topology = await readJson(topologyPath);
  const verticals = topology.value['verticals'];
  if (!Array.isArray(verticals)) throw new Error('reference topology verticals must be an array');
  if (verticals.some((value) => asJsonObject(value, 'topology vertical')['id'] === slug))
    throw new Error(`vertical ${slug} already exists`);
  if (verticals.some((value) => JSON.stringify(value).includes(`:${port}`)))
    throw new Error(`port ${port} is already assigned`);
  const shell = asJsonObject(topology.value['shell'], 'topology shell');
  const refs = shell['verticalRefs'];
  if (!Array.isArray(refs)) throw new Error('topology shell.verticalRefs must be an array');
  const shellModuleFederation = asJsonObject(
    shell['moduleFederation'],
    'topology shell.moduleFederation',
  );
  const remotes = shellModuleFederation['remotes'];
  if (!Array.isArray(remotes))
    throw new Error('topology shell.moduleFederation.remotes must be an array');
  pushUpdate(
    mutations,
    topologyPath,
    topology.content,
    json({
      ...topology.value,
      shell: {
        ...shell,
        verticalRefs: [...refs, slug],
        moduleFederation: {
          ...shellModuleFederation,
          remotes: [
            ...remotes,
            {
              id: slug,
              name: `vertical${title(slug)}`,
              manifestUrl: `http://localhost:${port}/mf-manifest.json`,
            },
          ],
        },
      },
      verticals: [...verticals, deployment(slug, port)],
    }),
  );
  const overlayPath = resolveContainedPath(
    workspaceRoot,
    'topology/local-overlays/development.json',
  );
  const overlay = await readJson(overlayPath);
  const upper = slug.replaceAll('-', '_').toUpperCase();
  const additions: Readonly<Record<string, JsonValue>> = {
    ports: port,
    manifests: `http://localhost:${port}/mf-manifest.json`,
    ontosModuleManifests: `http://localhost:${port}/.well-known/ontos-module-manifest.json`,
    apis: `http://localhost:${port}/${slug}-api`,
    serverExecution: {
      apiBaseUrl: `http://localhost:${port}/${slug}-api`,
      versionBoundary: 'web-and-api-same-build',
      deliveryUnit: { unitId: `app/${slug}`, buildMarker: 'workspace' },
      cloudflare: {
        kind: 'cloudflare-worker-snapshot',
        workerName: `app-${slug}`,
        publicUrlEnv: `ULTRAMODERN_PUBLIC_URL_${upper}`,
      },
      node: {
        kind: 'node-mf-runtime',
        adapterVersion: 'backend-mf-effect-v1',
        remoteName: `vertical${title(slug)}Backend`,
        manifestEnv: `VERTICAL_${upper}_BACKEND_MF_MANIFEST`,
        manifestUrl: `http://localhost:${port}/backend-mf-manifest.json`,
        containerEntry: `http://localhost:${port}/backendRemoteEntry.cjs`,
        remoteType: 'commonjs-module',
        expose: './effect-api',
        runtimePackage: '@modern-js/plugin-bff/effect',
        expected: { unitId: `app/${slug}`, buildMarker: 'workspace' },
      },
    },
  };
  const nextOverlay: Record<string, JsonValue> = { ...overlay.value };
  for (const [section, value] of Object.entries(additions))
    nextOverlay[section] = {
      ...asJsonObject(nextOverlay[section], `overlay ${section}`),
      [slug]: value,
    };
  pushUpdate(mutations, overlayPath, overlay.content, json(nextOverlay));
  const shellPackagePath = resolveContainedPath(workspaceRoot, 'apps/shell-super-app/package.json');
  const shellPackage = await readJson(shellPackagePath);
  const shellDependencies = asJsonObject(
    shellPackage.value['dependencies'],
    'shell package dependencies',
  );
  const shellZephyrDependencies = asJsonObject(
    shellPackage.value['zephyr:dependencies'],
    'shell package zephyr dependencies',
  );
  pushUpdate(
    mutations,
    shellPackagePath,
    shellPackage.content,
    json({
      ...shellPackage.value,
      dependencies: { ...shellDependencies, [`@app/${slug}`]: 'workspace:*' },
      'zephyr:dependencies': {
        ...shellZephyrDependencies,
        [slug]: `@app/${slug}@workspace:*`,
      },
    }),
  );
  const shellTsconfigPath = resolveContainedPath(
    workspaceRoot,
    'apps/shell-super-app/tsconfig.json',
  );
  const shellTsconfig = await readJson(shellTsconfigPath);
  const shellReferences = shellTsconfig.value['references'];
  if (!Array.isArray(shellReferences))
    throw new Error('shell tsconfig references must be an array');
  pushUpdate(
    mutations,
    shellTsconfigPath,
    shellTsconfig.content,
    json({
      ...shellTsconfig.value,
      references: [...shellReferences, { path: `../../${packagePath}` }],
    }),
  );
  const zeropsPath = resolveContainedPath(workspaceRoot, 'zerops.yaml');
  const zerops = await readFile(zeropsPath, 'utf8');
  const shellServiceMarker = "  - setup: 'shellsuperapp'";
  if (!zerops.includes(shellServiceMarker))
    throw new Error('zerops shellsuperapp service marker is missing');
  pushUpdate(
    mutations,
    zeropsPath,
    zerops,
    zerops.replace(shellServiceMarker, `${zeropsService(slug, port)}${shellServiceMarker}`),
  );
  const ownershipPath = resolveContainedPath(workspaceRoot, 'topology/ownership.json');
  const ownership = await readJson(ownershipPath);
  const owners = ownership.value['owners'];
  if (!Array.isArray(owners)) throw new Error('topology ownership owners must be an array');
  pushUpdate(
    mutations,
    ownershipPath,
    ownership.content,
    json({
      ...ownership.value,
      owners: [
        ...owners,
        {
          id: slug,
          package: `@app/${slug}`,
          path: packagePath,
          ownership: deployment(slug, port)['ownership'] ?? null,
        },
      ],
    }),
  );
  const tsconfigPath = resolveContainedPath(workspaceRoot, 'tsconfig.json');
  const tsconfig = await readJson(tsconfigPath);
  const references = tsconfig.value['references'];
  if (!Array.isArray(references)) throw new Error('root tsconfig references must be an array');
  pushUpdate(
    mutations,
    tsconfigPath,
    tsconfig.content,
    json({ ...tsconfig.value, references: [...references, { path: packagePath }] }),
  );
  ensureUniqueMutationPaths(mutations);
  return { mutations, result: { appId: slug, packagePath, port } };
};

export default createCodesmithGenerator(planMicroverticalScaffold);
