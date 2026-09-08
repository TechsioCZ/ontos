#!/usr/bin/env node
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import {
  Array as EffectArray,
  Console,
  Effect,
  FileSystem,
  Layer,
  Order,
  Path,
  Random,
  Schema,
} from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import { launchUltramodern, resolveUltramodernInvocation } from './shared/ultramodern-command.mts';
import { ModuleEntrypointSchema } from '../packages/core-runtime/src/modules/module-entrypoint.ts';

const RouteMetadataIdentifierSchema = Schema.String.pipe(Schema.brand('RouteMetadataIdentifier'));
const JsonPrimitiveSchema = Schema.Union([
  Schema.Null,
  Schema.Number,
  Schema.Boolean,
  Schema.String,
]);
const RouteMetadataValueSchema = Schema.Tree(JsonPrimitiveSchema);
const RouteMetadataFieldsSchema = Schema.Record(Schema.String, RouteMetadataValueSchema);

const RouteEntrypointSchema = Schema.StructWithRest(ModuleEntrypointSchema, [
  RouteMetadataFieldsSchema,
]);

const RouteMetadataSchema = Schema.StructWithRest(
  Schema.Struct({
    canonicalPath: Schema.String,
    descriptionKey: RouteMetadataIdentifierSchema,
    entrypoint: RouteEntrypointSchema,
    id: Schema.String,
    indexable: Schema.Boolean,
    jsonLd: Schema.optionalKey(RouteMetadataValueSchema),
    localisedPaths: Schema.Record(Schema.String, Schema.String),
    namespace: Schema.String,
    ownerAppId: RouteMetadataIdentifierSchema,
    public: Schema.Boolean,
    titleKey: RouteMetadataIdentifierSchema,
  }),
  [RouteMetadataFieldsSchema],
);
type RouteMetadata = typeof RouteMetadataSchema.Type;

const RouteMetadataModuleSchema = Schema.Struct({
  default: Schema.optionalKey(RouteMetadataSchema),
  routeMeta: Schema.optionalKey(RouteMetadataSchema),
});

const UltramodernConfigSchema = Schema.Struct({
  topology: Schema.optionalKey(
    Schema.Struct({
      apps: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            id: Schema.String,
            path: Schema.String,
          }),
        ),
      ),
    }),
  ),
});

const PackageConfigSchema = Schema.Struct({
  modernjs: Schema.optionalKey(
    Schema.Struct({
      ontosModule: Schema.optionalKey(
        Schema.Struct({
          moduleId: Schema.optionalKey(RouteMetadataIdentifierSchema),
        }),
      ),
    }),
  ),
});

class RouteGenerationError extends Schema.TaggedError<RouteGenerationError>()(
  'RouteGenerationError',
  { reason: Schema.String },
) {}

const failure = (reason: string): RouteGenerationError => new RouteGenerationError({ reason });

const decodeUltramodernConfig = Schema.decodeUnknownEffect(
  Schema.fromJsonString(UltramodernConfigSchema),
);
const decodePackageConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(PackageConfigSchema));
const encodeJsonString = Schema.encodeEffect(Schema.fromJsonString(Schema.String));
const encodeJson = Schema.encodeEffect(
  Schema.fromJsonString(RouteMetadataValueSchema, { space: 2 }),
);
const isJsonArray = Schema.is(Schema.Array(RouteMetadataValueSchema));
const isJsonObject = Schema.is(RouteMetadataFieldsSchema);

const sortJsonValue = (
  value: typeof RouteMetadataValueSchema.Type,
): typeof RouteMetadataValueSchema.Type => {
  if (isJsonArray(value)) {
    return value.map(sortJsonValue);
  }
  if (isJsonObject(value)) {
    const sortedEntries = EffectArray.sortWith(Object.entries(value), ([key]) => key, Order.String);
    return Object.fromEntries(sortedEntries.map(([key, entry]) => [key, sortJsonValue(entry)]));
  }
  return value;
};

const findRouteMetadataFiles = (
  directory: string,
): Effect.Effect<string[], RouteGenerationError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* findRouteMetadataFilesEffect() {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const entries = yield* fileSystem.readDirectory(directory, { recursive: true });
    const routeFiles = entries
      .filter((entry) => path.basename(entry) === 'route.meta.ts')
      .map((entry) => path.resolve(directory, entry));
    return EffectArray.sort(routeFiles, Order.String);
  }).pipe(Effect.mapError(() => failure(`Unable to discover route metadata beneath ${directory}`)));

const isGovernedPageEntrypoint = (
  route: RouteMetadata,
  appId: string,
  moduleId: string,
  expectedScope: 'system' | 'tenant',
): boolean =>
  route.ownerAppId === appId &&
  route.entrypoint.moduleKey === moduleId &&
  route.entrypoint.role === 'page' &&
  (route.entrypoint.access === 'read' || route.entrypoint.access === 'historical_read') &&
  route.entrypoint.scope === expectedScope &&
  route.entrypoint.entrypointKey.startsWith(`${moduleId}.`);

const loadRouteMetadataFile = (
  metadataFile: string,
  appId: string,
  moduleId: string,
): Effect.Effect<RouteMetadata, RouteGenerationError, Path.Path> =>
  Effect.gen(function* loadRouteMetadataFileEffect() {
    const path = yield* Path.Path;
    const moduleFileUrl = yield* path
      .toFileUrl(metadataFile)
      .pipe(Effect.mapError(() => failure(`Unable to resolve ${metadataFile}`)));
    const cacheNonce = yield* Random.nextInt;
    const moduleUrl = `${moduleFileUrl.href}?generated=${cacheNonce}`;
    const routeModule = yield* Effect.tryPromise({
      catch: () => failure(`Unable to import route metadata from ${metadataFile}`),
      try: async () =>
        await Schema.decodeUnknownPromise(RouteMetadataModuleSchema)(await import(moduleUrl)),
    });
    const route = routeModule.routeMeta ?? routeModule.default;
    if (route === undefined) {
      return yield* Effect.fail(
        failure(`${metadataFile} must export routeMeta or a default route metadata object`),
      );
    }
    const expectedScope = appId.startsWith('shell-') ? 'system' : 'tenant';
    if (!isGovernedPageEntrypoint(route, appId, moduleId, expectedScope)) {
      return yield* Effect.fail(
        failure(
          `${metadataFile} must declare one governed ${expectedScope} page entrypoint owned by ${appId}`,
        ),
      );
    }
    return route;
  });

const loadRouteMetadata = (appDirectory: string, appId: string, moduleId: string) =>
  Effect.gen(function* loadRouteMetadataEffect() {
    const path = yield* Path.Path;
    const routeDirectory = path.join(appDirectory, 'src/routes');
    const metadataFiles = yield* findRouteMetadataFiles(routeDirectory);
    const routes = yield* Effect.forEach(
      metadataFiles,
      (metadataFile) => loadRouteMetadataFile(metadataFile, appId, moduleId),
      { concurrency: 'unbounded' },
    );
    return EffectArray.sortWith(routes, (route) => route.canonicalPath, Order.String);
  });

const createLocalisedUrls = (
  routes: readonly RouteMetadata[],
): Readonly<Record<string, Readonly<Record<string, string>>>> =>
  Object.fromEntries(
    routes.flatMap((route) => {
      if (route.canonicalPath === '/') {
        return [];
      }
      return EffectArray.sort(
        [...new Set([route.canonicalPath, ...Object.values(route.localisedPaths)])],
        Order.String,
      ).map((pathname) => [pathname, route.localisedPaths]);
    }),
  );

const runCommand = (
  executable: string,
  args: readonly string[],
  options: ChildProcess.CommandOptions,
) =>
  Effect.gen(function* runCommandEffect() {
    const processSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const exitCode = yield* processSpawner.exitCode(ChildProcess.make(executable, args, options));
    return Number(exitCode);
  });

const generateRouteMetadataManifest = (
  appDirectory: string,
  appId: string,
  moduleId: string,
  workspaceRoot: string,
) =>
  Effect.gen(function* generateRouteMetadataManifestEffect() {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const routes = yield* loadRouteMetadata(appDirectory, appId, moduleId);
    const namespace = routes[0]?.namespace;
    if (namespace === undefined) {
      return;
    }
    const localisedUrls = createLocalisedUrls(routes);
    const encodedNamespace = yield* encodeJsonString(namespace).pipe(
      Effect.mapError(() => failure(`Unable to encode the route namespace for ${appId}`)),
    );
    const encodedRoutes = yield* encodeJson(sortJsonValue(routes)).pipe(
      Effect.mapError(() => failure(`Unable to encode route metadata for ${appId}`)),
    );
    const encodedLocalisedUrls = yield* encodeJson(sortJsonValue(localisedUrls)).pipe(
      Effect.mapError(() => failure(`Unable to encode localised URLs for ${appId}`)),
    );
    const content = `// @generated by @modern-js/create.
// Author route metadata in colocated src/routes/**/route.meta.ts files.
// This compatibility manifest is regenerated from route-owned metadata.

export const ultramodernRouteNamespace = ${encodedNamespace} as const;

export const ultramodernRouteMetadata = ${encodedRoutes} as const;

export const ultramodernLocalisedUrls = ${encodedLocalisedUrls} as const;

`;
    const manifestPath = path.join(appDirectory, 'src/routes/ultramodern-route-metadata.ts');
    yield* fileSystem
      .writeFileString(manifestPath, content)
      .pipe(Effect.mapError(() => failure(`Unable to write ${manifestPath}`)));
    const formatStatus = yield* runCommand('pnpm', ['exec', 'oxfmt', manifestPath], {
      cwd: workspaceRoot,
      shell: path.sep === '\\',
      stderr: 'inherit',
      stdin: 'inherit',
      stdout: 'inherit',
    }).pipe(Effect.mapError(() => failure(`Unable to launch the formatter for ${manifestPath}`)));
    if (formatStatus !== 0) {
      yield* Effect.fail(
        failure(
          `Failed to format generated route metadata at ${manifestPath}: exit ${formatStatus}`,
        ),
      );
    }
  });

const program = Effect.gen(function* generateTanstackRoutesEffect() {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const invocation = yield* resolveUltramodernInvocation({
    command: 'routes-generate',
    directoryFailure: 'Unable to resolve the route generator directory',
    failure,
    launchErrorDetail: () => '',
    moduleUrl: import.meta.url,
  });
  const { forwardedArgs, workspaceRoot } = invocation;
  const generationStatus = yield* launchUltramodern(invocation);
  if (generationStatus !== 0) {
    yield* Console.warn(
      '[ultramodern] Framework route-artifact generation failed; continuing with the repository compatibility manifest. The application build remains the authoritative route-artifact gate.',
    );
  }

  const ultramodernConfigPath = path.join(workspaceRoot, '.modernjs/ultramodern.json');
  const ultramodernConfigText = yield* fileSystem
    .readFileString(ultramodernConfigPath)
    .pipe(Effect.mapError(() => failure(`Unable to read ${ultramodernConfigPath}`)));
  const ultramodernConfig = yield* decodeUltramodernConfig(ultramodernConfigText).pipe(
    Effect.mapError(() => failure(`${ultramodernConfigPath} is invalid`)),
  );
  const appFlagIndex = forwardedArgs.indexOf('--app');
  const selectedAppId = appFlagIndex === -1 ? undefined : forwardedArgs[appFlagIndex + 1];
  const selectedApps = (ultramodernConfig.topology?.apps ?? []).filter(
    (app) => selectedAppId === undefined || selectedAppId === app.id,
  );

  yield* Effect.forEach(
    selectedApps,
    (app) =>
      Effect.gen(function* generateAppRouteMetadataEffect() {
        const packageConfigPath = path.join(workspaceRoot, app.path, 'package.json');
        const packageConfigText = yield* fileSystem
          .readFileString(packageConfigPath)
          .pipe(Effect.mapError(() => failure(`Unable to read ${packageConfigPath}`)));
        const packageConfig = yield* decodePackageConfig(packageConfigText).pipe(
          Effect.mapError(() => failure(`${packageConfigPath} is invalid`)),
        );
        const moduleId = packageConfig.modernjs?.ontosModule?.moduleId ?? app.id;
        yield* generateRouteMetadataManifest(
          path.join(workspaceRoot, app.path),
          app.id,
          moduleId,
          workspaceRoot,
        );
        yield* Console.log(`[ultramodern] Route metadata manifest generated: ${app.id}`);
      }),
    { concurrency: 1, discard: true },
  );
});

const reportFailure = (error: RouteGenerationError) => Console.error(error.reason);
const MainLayer = Layer.effectDiscard(program.pipe(Effect.tapError(reportFailure))).pipe(
  Layer.provide(NodeServices.layer),
);

NodeRuntime.runMain(Effect.scoped(Layer.build(MainLayer)), { disableErrorReporting: true });
