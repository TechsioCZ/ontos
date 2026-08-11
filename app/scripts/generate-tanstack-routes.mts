#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const createBin = process.env.ULTRAMODERN_CREATE_BIN;
const forwardedArgs = process.argv.slice(2);
const workspaceRoot =
  process.env.ULTRAMODERN_WORKSPACE_ROOT ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ultramodernArgs = ['ultramodern', 'routes-generate', ...[], ...forwardedArgs];
const result = createBin
  ? spawnSync(process.execPath, [createBin, ...ultramodernArgs], {
      env: { ...process.env, ULTRAMODERN_WORKSPACE_ROOT: workspaceRoot },
      stdio: 'inherit',
    })
  : spawnSync('modern-js-create', ultramodernArgs, {
      env: { ...process.env, ULTRAMODERN_WORKSPACE_ROOT: workspaceRoot },
      shell: process.platform === 'win32',
      stdio: 'inherit',
    });

const sortJsonValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortJsonValue(entry)]),
    );
  }
  return value;
};

const findRouteMetadataFiles = async (directory: string): Promise<string[]> => {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await findRouteMetadataFiles(entryPath)));
    } else if (entry.name === 'route.meta.ts') {
      files.push(entryPath);
    }
  }
  return files.sort();
};

interface RouteMetadata {
  readonly canonicalPath: string;
  readonly descriptionKey: string;
  readonly entrypoint: {
    readonly access: 'historical_read' | 'read';
    readonly entrypointKey: string;
    readonly moduleKey: string;
    readonly role: 'page';
    readonly scope: 'system' | 'tenant';
  };
  readonly id: string;
  readonly indexable: boolean;
  readonly localisedPaths: Readonly<Record<string, string>>;
  readonly jsonLd?: unknown;
  readonly namespace: string;
  readonly ownerAppId: string;
  readonly public: boolean;
  readonly titleKey: string;
}

const loadRouteMetadata = async (appDirectory: string, appId: string, moduleId: string) => {
  const routeDirectory = path.join(appDirectory, 'src/routes');
  const metadataFiles = await findRouteMetadataFiles(routeDirectory);
  const routes = await Promise.all(
    metadataFiles.map(async (metadataFile) => {
      const moduleUrl = `${pathToFileURL(metadataFile).href}?generated=${Date.now()}`;
      const module = (await import(moduleUrl)) as {
        readonly default?: RouteMetadata;
        readonly routeMeta?: RouteMetadata;
      };
      const route = module.routeMeta ?? module.default;
      if (route === undefined) {
        throw new Error(`${metadataFile} must export routeMeta or a default route metadata object`);
      }
      const expectedScope = appId.startsWith('shell-') ? 'system' : 'tenant';
      if (
        route.ownerAppId !== appId ||
        route.entrypoint?.moduleKey !== moduleId ||
        route.entrypoint?.role !== 'page' ||
        (route.entrypoint?.access !== 'read' && route.entrypoint?.access !== 'historical_read') ||
        route.entrypoint?.scope !== expectedScope ||
        !route.entrypoint.entrypointKey.startsWith(`${moduleId}.`)
      ) {
        throw new Error(
          `${metadataFile} must declare one governed ${expectedScope} page entrypoint owned by ${appId}`,
        );
      }
      return route;
    }),
  );
  return routes.sort((left, right) => left.canonicalPath.localeCompare(right.canonicalPath));
};

const createLocalisedUrls = (routes: readonly RouteMetadata[]) =>
  Object.fromEntries(
    routes.flatMap((route) => {
      if (route.canonicalPath === '/') {
        return [];
      }
      return [...new Set([route.canonicalPath, ...Object.values(route.localisedPaths)])].map(
        (pathname) => [pathname, route.localisedPaths],
      );
    }),
  );

const createPublicRoutes = (routes: readonly RouteMetadata[]) =>
  routes
    .filter((route) => route.public && route.indexable)
    .map((route) => ({
      canonicalPath: route.canonicalPath,
      descriptionKey: route.descriptionKey,
      id: route.id,
      ...(route.jsonLd === undefined ? {} : { jsonLd: route.jsonLd }),
      localisedPaths: route.localisedPaths,
      namespace: route.namespace,
      ownerAppId: route.ownerAppId,
      titleKey: route.titleKey,
    }));

const generateRouteMetadataManifest = async (
  appDirectory: string,
  appId: string,
  moduleId: string,
) => {
  const routes = await loadRouteMetadata(appDirectory, appId, moduleId);
  const namespace = routes[0]?.namespace;
  if (namespace === undefined) {
    return;
  }
  const localisedUrls = createLocalisedUrls(routes);
  const publicRoutes = createPublicRoutes(routes);
  const content = `// @generated by @modern-js/create.
// Author route metadata in colocated src/routes/**/route.meta.ts files.
// This compatibility manifest is regenerated from route-owned metadata.

export const ultramodernRouteNamespace = ${JSON.stringify(namespace)} as const;

export const ultramodernRouteMetadata = ${JSON.stringify(sortJsonValue(routes), null, 2)} as const;

export const ultramodernLocalisedUrls = ${JSON.stringify(sortJsonValue(localisedUrls), null, 2)} as const;

export const ultramodernPublicRoutes = ${JSON.stringify(sortJsonValue(publicRoutes), null, 2)} as const;

export const ultramodernRouteConfig = {
  authoring: 'colocated-route-meta',
  generatedManifest: true,
  localisedUrls: ultramodernLocalisedUrls,
  namespace: ultramodernRouteNamespace,
  publicRoutes: ultramodernPublicRoutes,
  routes: ultramodernRouteMetadata,
  source: 'route-owned',
} as const;
`;
  const manifestPath = path.join(appDirectory, 'src/routes/ultramodern-route-metadata.ts');
  await writeFile(manifestPath, content, 'utf8');
  const formatResult = spawnSync('pnpm', ['exec', 'oxfmt', manifestPath], {
    cwd: workspaceRoot,
    shell: process.platform === 'win32',
    stdio: 'inherit',
  });
  if (formatResult.error || formatResult.status !== 0) {
    throw new Error(
      `Failed to format generated route metadata at ${manifestPath}: ${
        formatResult.error?.message ?? `exit ${formatResult.status}`
      }`,
    );
  }
};

if (result.error) {
  const launchTarget = createBin
    ? process.execPath + ' with ULTRAMODERN_CREATE_BIN=' + createBin
    : 'modern-js-create from PATH';
  console.error(
    'Failed to launch ' +
      launchTarget +
      ' for UltraModern command "' +
      ultramodernArgs.slice(1).join(' ') +
      '": ' +
      result.error.message,
  );
  process.exit(1);
}

if ((result.status ?? 1) !== 0) {
  console.warn(
    '[ultramodern] Framework route-artifact generation failed; continuing with the repository compatibility manifest. The application build remains the authoritative route-artifact gate.',
  );
}
const ultramodernConfig = JSON.parse(
  await readFile(path.join(workspaceRoot, '.modernjs/ultramodern.json'), 'utf8'),
) as {
  readonly topology?: {
    readonly apps?: readonly { readonly id: string; readonly path: string }[];
  };
};
for (const app of ultramodernConfig.topology?.apps ?? []) {
  if (
    forwardedArgs.includes('--app') &&
    forwardedArgs[forwardedArgs.indexOf('--app') + 1] !== app.id
  ) {
    continue;
  }
  const packageJson = JSON.parse(
    await readFile(path.join(workspaceRoot, app.path, 'package.json'), 'utf8'),
  ) as { readonly modernjs?: { readonly ontosModule?: { readonly moduleId?: string } } };
  const moduleId = packageJson.modernjs?.ontosModule?.moduleId ?? app.id;
  await generateRouteMetadataManifest(path.join(workspaceRoot, app.path), app.id, moduleId);
  console.log(`[ultramodern] Route metadata manifest generated: ${app.id}`);
}

process.exit(0);
