import { Effect, Equal, FileSystem, Schema, Predicate } from 'effect';

import { createCodesmithGenerator } from '../generator-adapter.mts';
import {
  MODULE_MANIFEST_COMPONENT_SLOT_END,
  MODULE_MANIFEST_COMPONENT_SLOT_START,
  MODULE_MANIFEST_IMPORT_SLOT_END,
  MODULE_MANIFEST_IMPORT_SLOT_START,
  MODULE_MANIFEST_SHELL_NAVIGATION_SLOT_END,
  MODULE_MANIFEST_SHELL_NAVIGATION_SLOT_START,
  MODULE_MANIFEST_SHELL_PAGE_SLOT_END,
  MODULE_MANIFEST_SHELL_PAGE_SLOT_START,
  MODULE_REGISTRATION_PAGE_SLOT_END,
  MODULE_REGISTRATION_PAGE_SLOT_START,
  asJsonObject,
  createMutationEffect as createSharedMutation,
  discoverOntosModuleEffect as discoverSharedModule,
  ensureUniqueMutationPaths,
  formatGeneratedMutationContent,
  generatedSlotContainsExactEntry,
  insertModuleFederationExposure,
  insertSortedSlot,
  isModuleManifestImport,
  moduleFederationExposureSource,
  maskNonCode,
  patchJsonObjectProperty,
  readJsonEffect as readSharedJson,
  readGeneratedSlotEntries,
  requireCanonicalSlug,
  requiredString,
  resolveContainedPath,
  toCamelCase,
  toPascalCase,
  updateMutation,
} from '../shared.mts';
import type {
  JsonObject,
  MutableJsonObject,
  Mutation,
  PageScaffoldConfig,
  PageScaffoldResult,
  ScaffoldPlan,
  OntosVerticalMetadata,
} from '../shared.mts';
import { tailwindPrefixForNamespace } from '../tailwind-prefix.mts';

interface PageVerticalMetadata extends OntosVerticalMetadata {
  readonly inlineLocales: boolean;
  readonly locales: readonly string[];
  readonly mfBoundaryId: string;
  readonly namespace: string;
  readonly tailwindPrefix: string;
}

interface PageRoute {
  readonly canonicalPath: string;
  readonly canonicalSegments: readonly string[];
  readonly filesystemSegments: readonly string[];
  readonly isDynamic: boolean;
  readonly parameterNames: readonly string[];
  readonly relativePath: string;
}

const namespacePattern = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u;
const moduleFederationNamePattern = /^[A-Za-z][A-Za-z0-9]*$/u;
const localePattern = /^[a-z]{2}(?:-[A-Z]{2})?$/u;
const routeLocalePrefixPattern = /^[a-z]{2}(?:-[a-z]{2})?$/u;
const staticRouteSegmentPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const parameterRouteSegmentPattern = /^:(?<name>[a-z][A-Za-z0-9]*)$/u;
const pageStarterLocales = new Set(['cs', 'en']);
const SHELL_APP_ID = 'shell-super-app';
const PAGE_FILE_NAME = 'page.tsx';
const ROUTE_METADATA_FILE_NAME = 'route.meta.ts';

class PageScaffoldError extends Schema.TaggedError<PageScaffoldError>()('PageScaffoldError', {
  cause: Schema.optionalKey(Schema.Unknown),
  message: Schema.String,
}) {}

const pageScaffoldFailure = (message: string, cause?: unknown): PageScaffoldError =>
  new PageScaffoldError(cause === undefined ? { message } : { cause, message });

const pageScaffoldFailureFromUnknown = (cause: unknown, fallback: string): PageScaffoldError =>
  Schema.is(PageScaffoldError)(cause)
    ? cause
    : pageScaffoldFailure(Predicate.isError(cause) ? cause.message : fallback, cause);

const discoverOntosModuleEffect = (workspaceRoot: string, requestedVertical: string) =>
  discoverSharedModule(workspaceRoot, requestedVertical).pipe(
    Effect.mapError((cause) =>
      pageScaffoldFailureFromUnknown(cause, `vertical ${requestedVertical} could not be discovered`),
    ),
  );

const readJsonEffect = (filePath: string, description: string, fallback: string) =>
  readSharedJson(filePath, description).pipe(
    Effect.mapError((cause) => pageScaffoldFailureFromUnknown(cause, fallback)),
  );

const createMutationEffect = (filePath: string, content: string, fallback: string) =>
  createSharedMutation(filePath, content).pipe(
    Effect.mapError((cause) => pageScaffoldFailureFromUnknown(cause, fallback)),
  );

const mapFileSystemError = <Value, Failure, Requirements>(
  operation: Effect.Effect<Value, Failure, Requirements>,
): Effect.Effect<Value, PageScaffoldError, Requirements> =>
  operation.pipe(
    Effect.mapError((cause) => pageScaffoldFailureFromUnknown(cause, 'page scaffold file-system operation failed')),
  );

interface DirectoryEntry {
  readonly isDirectory: boolean;
  readonly isFile: boolean;
  readonly name: string;
}

const readDirectoryEntries = (directory: string) =>
  Effect.gen(function* readDirectoryEntriesEffect() {
    const fileSystem = yield* FileSystem.FileSystem;
    const names = yield* mapFileSystemError(fileSystem.readDirectory(directory));
    return yield* Effect.all(
      names.map((name) =>
        mapFileSystemError(fileSystem.stat(resolveContainedPath(directory, name))).pipe(
          Effect.map((info): DirectoryEntry => ({
            isDirectory: info.type === 'Directory',
            isFile: info.type === 'File',
            name,
          })),
        ),
      ),
      { concurrency: 'unbounded' },
    );
  });

const readTextFile = (filePath: string) =>
  Effect.gen(function* readTextFileEffect() {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* mapFileSystemError(fileSystem.readFileString(filePath));
  });

const fileExists = (filePath: string) =>
  Effect.gen(function* fileExistsEffect() {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* mapFileSystemError(fileSystem.exists(filePath));
  });

const pageRouteIsInvalid = (
  canonicalPath: string,
  canonicalSegments: readonly string[],
  parameterNames: readonly string[],
  requestedUrl: string | undefined,
): boolean =>
  canonicalPath.length < 2 ||
  canonicalPath.length > 200 ||
  canonicalSegments.length === 0 ||
  canonicalSegments.some(
    (segment) => !staticRouteSegmentPattern.test(segment) && !parameterRouteSegmentPattern.test(segment),
  ) ||
  new Set(parameterNames).size !== parameterNames.length ||
  (requestedUrl === undefined && parameterNames.length > 0);

const resolvePageRoute = (
  vertical: PageVerticalMetadata,
  page: string,
  requestedUrl: string | undefined,
): Effect.Effect<PageRoute, PageScaffoldError> =>
  Effect.gen(function* resolvePageRouteEffect() {
    const canonicalPath = requestedUrl ?? `/${vertical.slug}/${page}`;
    const canonicalSegments = canonicalPath.startsWith('/') ? canonicalPath.slice(1).split('/') : [];
    const parameterNames = canonicalSegments.flatMap((segment) => {
      const name = parameterRouteSegmentPattern.exec(segment)?.groups?.['name'];
      return name === undefined ? [] : [name];
    });
    if (pageRouteIsInvalid(canonicalPath, canonicalSegments, parameterNames, requestedUrl)) {
      return yield* pageScaffoldFailure(
        '--url must be a root-relative path of lowercase kebab-case segments and unique named :parameters, with no locale, query, fragment, wildcard, optional/catch-all syntax, or trailing slash',
      );
    }
    if (requestedUrl !== undefined && routeLocalePrefixPattern.test(canonicalSegments[0] ?? '')) {
      return yield* pageScaffoldFailure('--url must not include a locale prefix; the localized router adds it');
    }
    const filesystemSegments = canonicalSegments.map((segment) => {
      const parameterName = parameterRouteSegmentPattern.exec(segment)?.groups?.['name'];
      return parameterName === undefined ? segment : `[${parameterName}]`;
    });
    return {
      canonicalPath,
      canonicalSegments,
      filesystemSegments,
      isDynamic: parameterNames.length > 0,
      parameterNames,
      relativePath: filesystemSegments.join('/'),
    };
  });

const relativeFromRoute = (route: PageRoute, target: string, extraLevels = 0): string =>
  `${'../'.repeat(route.filesystemSegments.length + extraLevels)}${target}`;

const renderRouteParameterSchemaFields = (componentName: string, route: PageRoute): string =>
  route.parameterNames
    .map(
      (name) => `  ${name}: Schema.String.pipe(Schema.brand('${componentName}${toPascalCase(name)}RouteParameter')),`,
    )
    .join('\n');

const validateLocale = (
  workspaceRoot: string,
  vertical: OntosVerticalMetadata,
  namespace: string,
  packageExports: JsonObject,
  locale: string,
  runtimeLocales: boolean,
): Effect.Effect<void, PageScaffoldError, FileSystem.FileSystem> =>
  Effect.gen(function* validateLocaleEffect() {
    const expectedExport = `./locales/${locale}/${namespace}.json`;
    const localeExport = packageExports[`./locales/${locale}`];
    if (localeExport !== expectedExport && !(localeExport === undefined && runtimeLocales)) {
      yield* pageScaffoldFailure(`vertical ${vertical.slug} is missing its generated ${locale} locale export`);
    }
    const localePath = resolveContainedPath(
      workspaceRoot,
      'verticals',
      vertical.slug,
      'locales',
      locale,
      `${namespace}.json`,
    );
    yield* readJsonEffect(
      localePath,
      `vertical ${vertical.slug} ${locale} locale catalog`,
      `vertical ${vertical.slug} ${locale} locale catalog is invalid`,
    );
  });

const discoverPageVertical = (
  workspaceRoot: string,
  requestedVertical: string,
): Effect.Effect<PageVerticalMetadata, PageScaffoldError, FileSystem.FileSystem> =>
  Effect.gen(function* discoverPageVerticalEffect() {
    const vertical = yield* discoverOntosModuleEffect(workspaceRoot, requestedVertical);
    const { topologyEntry } = vertical;
    const namespace = requiredString(topologyEntry['domain'], `vertical ${vertical.slug} namespace`);
    if (!namespacePattern.test(namespace)) {
      return yield* pageScaffoldFailure(`vertical ${vertical.slug} namespace is not a safe generated identifier`);
    }
    const moduleFederation = asJsonObject(
      topologyEntry['moduleFederation'],
      `vertical ${vertical.slug} Module Federation metadata`,
    );
    const mfBoundaryId = requiredString(
      moduleFederation['name'],
      `vertical ${vertical.slug} Module Federation boundary`,
    );
    if (!moduleFederationNamePattern.test(mfBoundaryId)) {
      return yield* pageScaffoldFailure(`vertical ${vertical.slug} Module Federation boundary is invalid`);
    }
    const localeRoot = resolveContainedPath(workspaceRoot, 'verticals', vertical.slug, 'locales');
    if (!(yield* fileExists(localeRoot))) {
      return yield* pageScaffoldFailure(`vertical ${vertical.slug} locale directory is missing`);
    }
    const localeEntries = yield* readDirectoryEntries(localeRoot);
    const locales = localeEntries
      .filter((entry) => entry.isDirectory)
      .map((entry) => entry.name)
      .toSorted();
    if (locales.length === 0 || locales.some((locale) => !localePattern.test(locale))) {
      return yield* pageScaffoldFailure(
        `vertical ${vertical.slug} must have one or more valid generated locale directories`,
      );
    }
    const unsupportedLocale = locales.find((locale) => !pageStarterLocales.has(locale));
    if (unsupportedLocale !== undefined) {
      return yield* pageScaffoldFailure(`page scaffold has no starter translation for locale ${unsupportedLocale}`);
    }
    const runtimePath = resolveContainedPath(vertical.directory, 'src', 'modern.runtime.ts');
    const runtimeSource = (yield* fileExists(runtimePath)) ? yield* readTextFile(runtimePath) : '';
    const runtimeStructure = maskNonCode(runtimeSource);
    const namespaceIdentifier = namespace.replaceAll('.', String.raw`\.`);
    const namespaceImport =
      /import\s*\{\s*ultramodernRouteNamespace\s*\}\s*from\s*['"]\.\/routes\/ultramodern-route-metadata['"]/u.exec(
        runtimeSource,
      );
    const namespaceImportIsCode =
      namespaceImport !== null && /^import\s*\{/u.test(runtimeStructure.slice(namespaceImport.index));
    const runtimeLocales =
      locales.every((locale) => {
        const importPattern = new RegExp(
          `import\\s+${locale}Resource\\s+from\\s+['"]\\.\\./locales/${locale}/${namespaceIdentifier}\\.json['"]`,
          'u',
        );
        const bindingPattern = new RegExp(
          `${locale}:\\s*\\{\\s*\\[ultramodernRouteNamespace\\]:\\s*${locale}Resource\\s*\\}`,
          'u',
        );
        const importMatch = importPattern.exec(runtimeSource);
        return (
          importMatch !== null &&
          /^import\s/u.test(runtimeStructure.slice(importMatch.index)) &&
          bindingPattern.test(runtimeStructure)
        );
      }) &&
      /defaultNS:\s*ultramodernRouteNamespace/u.test(runtimeStructure) &&
      namespaceImportIsCode;
    const packageExports = asJsonObject(vertical.packageJson['exports'], `vertical ${vertical.slug} package exports`);
    yield* Effect.all(
      locales.map((locale) =>
        validateLocale(workspaceRoot, vertical, namespace, packageExports, locale, runtimeLocales),
      ),
      { concurrency: 'unbounded' },
    );
    const routeHeadPath = resolveContainedPath(
      workspaceRoot,
      'verticals',
      vertical.slug,
      'src',
      'routes',
      'ultramodern-route-head.tsx',
    );
    if (!(yield* fileExists(routeHeadPath))) {
      return yield* pageScaffoldFailure(`vertical ${vertical.slug} generated UltramodernRouteHead is missing`);
    }
    const routeStylesPath = resolveContainedPath(
      workspaceRoot,
      'verticals',
      vertical.slug,
      'src',
      'routes',
      'index.css',
    );
    if (!(yield* fileExists(routeStylesPath))) {
      return yield* pageScaffoldFailure(`vertical ${vertical.slug} generated route stylesheet is missing`);
    }
    const resourcesName = `${toCamelCase(vertical.slug)}I18nResources`;
    const resourcesPath = resolveContainedPath(
      workspaceRoot,
      'verticals',
      vertical.slug,
      'src',
      'i18n',
      'resources.ts',
    );
    const resourcesExist = yield* fileExists(resourcesPath);
    if (!resourcesExist && !runtimeLocales) {
      return yield* pageScaffoldFailure(`vertical ${vertical.slug} generated i18n resources are missing`);
    }
    const resourcesContent = resourcesExist ? yield* readTextFile(resourcesPath) : '';
    if (resourcesExist && !resourcesContent.includes(`export const ${resourcesName} =`)) {
      return yield* pageScaffoldFailure(
        `vertical ${vertical.slug} generated i18n resources must export ${resourcesName}`,
      );
    }
    return {
      ...vertical,
      inlineLocales: !resourcesExist,
      locales,
      mfBoundaryId,
      namespace,
      tailwindPrefix: tailwindPrefixForNamespace(namespace),
    };
  });

const renderPage = (vertical: PageVerticalMetadata, page: string, route: PageRoute): string => {
  const componentName = `${toPascalCase(page)}Page`;
  const contentComponentName = `${componentName}Content`;
  const resourcesName = `${toCamelCase(vertical.slug)}I18nResources`;
  const resourceImports = vertical.inlineLocales
    ? vertical.locales
        .map((locale) => {
          const catalogPath = `../locales/${locale}/${vertical.namespace}.json`;
          return `import ${locale}Resource from '${relativeFromRoute(route, catalogPath, 2)}';`;
        })
        .join('\n')
    : `import { ${resourcesName} } from '${relativeFromRoute(route, 'i18n/resources', 2)}';`;
  const resourceBindings = vertical.locales
    .map((locale) => `  ${locale}: { '${vertical.namespace}': ${locale}Resource },`)
    .join('\n');
  const resourceDefinition = vertical.inlineLocales
    ? `const ${resourcesName} = {\n${resourceBindings}\n} as const;\n\n`
    : '';
  const keyRoot = `${vertical.namespace}.pages.${toCamelCase(page)}`;
  const prefix = vertical.tailwindPrefix;
  const schemaImport = route.isDynamic ? `import { Schema } from 'effect';\n` : '';
  const props = route.isDynamic
    ? `export const ${componentName}RouteParams = Schema.Struct({
${renderRouteParameterSchemaFields(componentName, route)}
});
export type ${componentName}RouteParams = typeof ${componentName}RouteParams.Type;
export const ${componentName}RouteParamsStandardSchema = Schema.toStandardSchemaV1(
  ${componentName}RouteParams,
);

interface ${componentName}Props {
  readonly routeParams: ${componentName}RouteParams;
}

`
    : '';
  const declaration = route.isDynamic
    ? `const ${contentComponentName} = ({ routeParams }: ${componentName}Props) => {
  void routeParams;`
    : `const ${contentComponentName} = () => {`;
  const ownerDeclaration = route.isDynamic
    ? `export const ${componentName} = ({ routeParams }: ${componentName}Props) => (`
    : `export const ${componentName} = () => (`;
  const content = route.isDynamic
    ? `<${contentComponentName} routeParams={routeParams} />`
    : `<${contentComponentName} />`;
  return `import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime';
${schemaImport}import { UltramodernRouteHead } from '${relativeFromRoute(route, 'ultramodern-route-head', 1)}';
${resourceImports}
import '${relativeFromRoute(route, 'index.css', 1)}';

${resourceDefinition}${props}${declaration}
  const { t } = useModernI18n();
  const headingId = '${page}-heading';

  return (
    <>
      <UltramodernRouteHead />
      <section
        aria-labelledby={headingId}
        className="${prefix}:mx-auto ${prefix}:w-full ${prefix}:max-w-5xl ${prefix}:px-4 ${prefix}:py-8 ${prefix}:sm:px-8 ${prefix}:lg:px-12"
      >
        <h1
          className="${prefix}:text-3xl ${prefix}:font-bold ${prefix}:text-(--color-page-fg) ${prefix}:sm:text-4xl"
          id={headingId}
        >
          {t('${keyRoot}.title')}
        </h1>
      </section>
    </>
  );
};

${ownerDeclaration}
  <FederatedI18nBoundary
    defaultNamespace="${vertical.namespace}"
    fallbackLanguage="en"
    resources={${resourcesName}}
    supportedLanguages={['en', 'cs']}
  >
    ${content}
  </FederatedI18nBoundary>
);

export default ${componentName};
`;
};

const renderReadAuthorization = (config: Pick<PageScaffoldConfig, 'authorization' | 'permission'>): string => {
  if (config.authorization === 'context_permission') {
    return `{ kind: 'context_permission', permission: '${config.permission ?? ''}' }`;
  }
  return `{ kind: '${config.authorization}' }`;
};

const validateReadAuthorization = (
  config: Pick<PageScaffoldConfig, 'authorization' | 'permission'>,
): Effect.Effect<void, PageScaffoldError, FileSystem.FileSystem> =>
  Effect.gen(function* validateReadAuthorizationEffect() {
    if (
      config.authorization === 'context_permission' &&
      (config.permission === undefined || !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u.test(config.permission))
    ) {
      yield* pageScaffoldFailure('context_permission authorization requires a stable --permission value');
    }
    if (config.authorization !== 'context_permission' && config.permission !== undefined) {
      yield* pageScaffoldFailure('--permission is valid only for context_permission authorization');
    }
  });

const pageWiring = (
  vertical: PageVerticalMetadata,
  page: string,
  route: PageRoute,
  config: Pick<PageScaffoldConfig, 'authorization' | 'permission'>,
) => {
  const componentName = `${toPascalCase(page)}Page`;
  const componentKey = `${vertical.moduleId}.page-${page}`;
  const contributionKey = `${vertical.moduleId}.page.${page}`;
  const entrypoint = `{ access: 'read', authorization: ${renderReadAuthorization(config)}, entrypointKey: '${contributionKey}', moduleKey: '${vertical.moduleId}', role: 'page', scope: 'tenant' }`;
  return {
    componentKey,
    componentName,
    contributionKey,
    manifestComponent: `'page-${page}': ${componentName},`,
    manifestImport: `import { ${componentName} } from './src/routes/[lang]/${route.relativePath}/page.tsx';`,
    manifestNavigation: route.isDynamic
      ? undefined
      : `navigationContribution({ contributionKey: '${vertical.moduleId}.navigation.${page}', entrypoint: ${entrypoint}, groupKey: 'shell.navigation.modules', order: 100, pageKey: '${contributionKey}' }),`,
    manifestPage: `pageContribution({ componentKey: '${componentKey}', contributionKey: '${contributionKey}', entrypoint: ${entrypoint}, expose: './Page${toPascalCase(page)}', routePath: '${route.canonicalPath}' }),`,
    registrationPage: `'page-${page}': () => import('./src/routes/[lang]/${route.relativePath}/page.tsx'),`,
  } as const;
};

interface PageOwnerWiring {
  readonly manifest: string;
  readonly registration: string;
}

const patchPageWiring = (
  vertical: PageVerticalMetadata,
  page: string,
  route: PageRoute,
  config: Pick<PageScaffoldConfig, 'authorization' | 'permission'>,
): PageOwnerWiring => {
  const wiring = pageWiring(vertical, page, route, config);
  let manifest = insertSortedSlot(
    vertical.manifestContent,
    MODULE_MANIFEST_IMPORT_SLOT_START,
    MODULE_MANIFEST_IMPORT_SLOT_END,
    [wiring.manifestImport],
    isModuleManifestImport,
  );
  manifest = insertSortedSlot(
    manifest,
    MODULE_MANIFEST_COMPONENT_SLOT_START,
    MODULE_MANIFEST_COMPONENT_SLOT_END,
    [wiring.manifestComponent],
    (candidate) => candidate.endsWith(','),
  );
  manifest = insertSortedSlot(
    manifest,
    MODULE_MANIFEST_SHELL_PAGE_SLOT_START,
    MODULE_MANIFEST_SHELL_PAGE_SLOT_END,
    [wiring.manifestPage],
    (candidate) => candidate.endsWith(','),
  );
  if (wiring.manifestNavigation !== undefined) {
    manifest = insertSortedSlot(
      manifest,
      MODULE_MANIFEST_SHELL_NAVIGATION_SLOT_START,
      MODULE_MANIFEST_SHELL_NAVIGATION_SLOT_END,
      [wiring.manifestNavigation],
      (candidate) => candidate.endsWith(','),
    );
  }
  const registration = insertSortedSlot(
    vertical.registrationContent,
    MODULE_REGISTRATION_PAGE_SLOT_START,
    MODULE_REGISTRATION_PAGE_SLOT_END,
    [wiring.registrationPage],
    (candidate) => candidate.endsWith(','),
  );
  return { manifest, registration };
};

const renderRouteMetadata = (
  vertical: PageVerticalMetadata,
  page: string,
  route: PageRoute,
  config: Pick<PageScaffoldConfig, 'authorization' | 'permission'>,
): string => {
  const keyRoot = `${vertical.namespace}.pages.${toCamelCase(page)}`;
  const localisedPaths = vertical.locales.map((locale) => `    ${locale}: '${route.canonicalPath}',`).join('\n');
  return `import { defineTenantModuleEntrypoint } from '@app/core-runtime/module-entrypoint';

const routeMeta = {
  canonicalPath: '${route.canonicalPath}',
  descriptionKey: '${keyRoot}.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: ${renderReadAuthorization(config)},
    entrypointKey: '${vertical.moduleId}.page.${page}',
    moduleKey: '${vertical.moduleId}',
    role: 'page',
  }),
  id: '${vertical.appId}-${page}',
  indexable: false,
  localisedPaths: {
${localisedPaths}
  },
  mfBoundaryId: '${vertical.mfBoundaryId}',
  moduleId: '${vertical.moduleId}',
  namespace: '${vertical.namespace}',
  ownerAppId: '${vertical.appId}',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: '${keyRoot}.title',
} as const;

export default routeMeta;
export { routeMeta };
`;
};

const localizedPageCopy = (locale: string): JsonObject => {
  if (locale === 'cs') {
    return {
      description: 'Tato stránka je připravena k implementaci.',
      title: 'Nová stránka',
    };
  }
  return {
    description: 'This page is ready for implementation.',
    title: 'New Page',
  };
};

const patchLocale = (
  workspaceRoot: string,
  vertical: PageVerticalMetadata,
  locale: string,
  page: string,
): Effect.Effect<Mutation, PageScaffoldError, FileSystem.FileSystem> =>
  Effect.gen(function* patchLocaleEffect() {
    const localePath = resolveContainedPath(
      workspaceRoot,
      'verticals',
      vertical.slug,
      'locales',
      locale,
      `${vertical.namespace}.json`,
    );
    const { content, value } = yield* readJsonEffect(
      localePath,
      `${locale} locale catalog`,
      `${locale} locale catalog is invalid`,
    );
    const namespaceValue = value[vertical.namespace];
    const namespace: MutableJsonObject = {
      ...asJsonObject(namespaceValue, `${locale} ${vertical.namespace} namespace`),
    };
    const pagesValue = namespace['pages'];
    const pages: MutableJsonObject =
      pagesValue === undefined ? {} : { ...asJsonObject(pagesValue, `${locale} pages catalog`) };
    const pageKey = toCamelCase(page);
    if (pages[pageKey] !== undefined) {
      return yield* pageScaffoldFailure(
        `locale key ${vertical.namespace}.pages.${pageKey} already exists in ${locale}`,
      );
    }
    pages[pageKey] = localizedPageCopy(locale);
    const sortedPages = Object.fromEntries(
      Object.entries(pages).toSorted(([left], [right]) => left.localeCompare(right)),
    );
    const patched = patchJsonObjectProperty(content, [vertical.namespace], 'pages', sortedPages);
    const mutation = updateMutation(localePath, content, patched);
    if (mutation === undefined) {
      return yield* pageScaffoldFailure(`locale patch unexpectedly made no change for ${locale}`);
    }
    return mutation;
  });

const GeneratedPageStateSchema = Schema.Literals(['current', 'invalid']);
type GeneratedPageState = typeof GeneratedPageStateSchema.Type;

interface OwnedPageRoute {
  readonly owner: string;
  readonly routePath: string;
}

const ownedPageRoute = (owner: string, candidate: string): Effect.Effect<OwnedPageRoute, PageScaffoldError> =>
  Effect.gen(function* ownedPageRouteEffect() {
    const matches = [...candidate.matchAll(/\broutePath:\s*'(?<routePath>\/[^']+)'/gu)];
    const routePath = matches[0]?.groups?.['routePath'];
    if (matches.length !== 1 || routePath === undefined) {
      return yield* pageScaffoldFailure(
        `generated owner slot contains unsupported developer content: ${MODULE_MANIFEST_SHELL_PAGE_SLOT_START}`,
      );
    }
    return { owner, routePath };
  });

const readOwnerRoutes = (
  verticalRoot: string,
  owner: string,
): Effect.Effect<readonly OwnedPageRoute[], PageScaffoldError, FileSystem.FileSystem> =>
  Effect.gen(function* readOwnerRoutesEffect() {
    const manifestPath = resolveContainedPath(verticalRoot, owner, 'vertical.manifest.ts');
    if (!(yield* fileExists(manifestPath))) {
      return [];
    }
    const manifest = yield* readTextFile(manifestPath);
    return yield* Effect.all(
      readGeneratedSlotEntries(
        manifest,
        MODULE_MANIFEST_SHELL_PAGE_SLOT_START,
        MODULE_MANIFEST_SHELL_PAGE_SLOT_END,
      ).map((candidate) => ownedPageRoute(owner, candidate)),
      { concurrency: 'unbounded' },
    );
  });

const ownedPageRoutes = (
  workspaceRoot: string,
): Effect.Effect<readonly OwnedPageRoute[], PageScaffoldError, FileSystem.FileSystem> =>
  Effect.gen(function* ownedPageRoutesEffect() {
    const verticalRoot = resolveContainedPath(workspaceRoot, 'verticals');
    const verticals = yield* readDirectoryEntries(verticalRoot);
    const ownedRoutes = yield* Effect.all(
      verticals.filter((entry) => entry.isDirectory).map((entry) => readOwnerRoutes(verticalRoot, entry.name)),
      { concurrency: 'unbounded' },
    );
    return ownedRoutes.flat();
  });

const isDynamicShellRouteSegment = (segment: string): boolean =>
  /^\[.+\]$/u.test(segment) || segment.startsWith('$') || segment.startsWith('*');

const routeCollisionIdentity = (routePath: string): string =>
  routePath
    .split('/')
    .map((segment) => (parameterRouteSegmentPattern.test(segment) ? ':parameter' : segment))
    .join('/');

const nativeShellRouteHasSuffix = (
  directory: string,
  index: number,
  route: PageRoute,
): Effect.Effect<boolean, PageScaffoldError, FileSystem.FileSystem> =>
  Effect.gen(function* nativeShellRouteHasSuffixEffect() {
    const segment = route.filesystemSegments[index];
    if (segment === undefined) {
      const markers = yield* Effect.all([
        fileExists(resolveContainedPath(directory, PAGE_FILE_NAME)),
        fileExists(resolveContainedPath(directory, ROUTE_METADATA_FILE_NAME)),
      ]);
      return markers.some(Boolean);
    }
    const entries = yield* readDirectoryEntries(directory);
    const matches = yield* Effect.all(
      entries
        .filter(
          (entry) =>
            entry.isDirectory &&
            (entry.name === segment || isDynamicShellRouteSegment(segment) || isDynamicShellRouteSegment(entry.name)),
        )
        .map((entry) => {
          const isCatchAll = entry.name === '$' || entry.name.startsWith('*') || entry.name.startsWith('[...');
          return nativeShellRouteHasSuffix(
            resolveContainedPath(directory, entry.name),
            isCatchAll ? route.filesystemSegments.length : index + 1,
            route,
          );
        }),
      { concurrency: 'unbounded' },
    );
    return matches.some(Boolean);
  });

const assertShellRouteSiblingsAreAvailable = (
  parent: string,
  entries: readonly DirectoryEntry[],
  segment: string,
  index: number,
  route: PageRoute,
  registeredDynamicPrefix: boolean,
) =>
  Effect.gen(function* assertShellRouteSiblingsAreAvailableEffect() {
    const desiredSegmentIsDynamic = isDynamicShellRouteSegment(segment);
    const siblingCollision = entries.find(
      (entry) =>
        entry.isDirectory &&
        (isDynamicShellRouteSegment(entry.name) || (desiredSegmentIsDynamic && !registeredDynamicPrefix)),
    );
    const suffixCollisions =
      siblingCollision === undefined && desiredSegmentIsDynamic && registeredDynamicPrefix
        ? yield* Effect.all(
            entries
              .filter((entry) => entry.isDirectory)
              .map((entry) =>
                nativeShellRouteHasSuffix(resolveContainedPath(parent, entry.name), index + 1, route).pipe(
                  Effect.map((matches) => (matches ? entry : undefined)),
                ),
              ),
            { concurrency: 'unbounded' },
          )
        : [];
    const collision = siblingCollision ?? suffixCollisions.find((entry) => entry !== undefined);
    if (collision !== undefined) {
      const collisionKind = isDynamicShellRouteSegment(collision.name) ? 'dynamic' : 'static';
      yield* pageScaffoldFailure(
        `Shell route ${route.canonicalPath} collides with ${collisionKind} route segment ${collision.name}`,
      );
    }
  });

const assertShellRouteSegmentIsAvailable = (
  parent: string,
  index: number,
  route: PageRoute,
  registeredRoutes: ReadonlySet<string>,
): Effect.Effect<void, PageScaffoldError, FileSystem.FileSystem> =>
  Effect.gen(function* assertShellRouteSegmentIsAvailableEffect() {
    const segment = route.filesystemSegments[index];
    if (segment === undefined || !(yield* fileExists(parent))) {
      return;
    }
    const directoryEntries = yield* readDirectoryEntries(parent);
    const entries = index === 0 ? directoryEntries.filter((entry) => entry.name !== '$') : directoryEntries;
    const childEntry = entries.find((entry) => entry.name === segment);
    const prefix = `/${route.canonicalSegments.slice(0, index + 1).join('/')}`;
    const ownsPrefix = registeredRoutes.has(routeCollisionIdentity(prefix));
    if (childEntry === undefined) {
      yield* assertShellRouteSiblingsAreAvailable(parent, entries, segment, index, route, ownsPrefix);
      return;
    }
    const child = resolveContainedPath(parent, segment);
    if (index === route.filesystemSegments.length - 1) {
      yield* pageScaffoldFailure(`Shell route already exists or collides with generated page: ${child}`);
    }
    if (!childEntry.isDirectory) {
      yield* pageScaffoldFailure(`Shell route ${route.canonicalPath} collides with reserved route content`);
    }
    const [pageRouteExists, routeMetadataExists] = yield* Effect.all(
      [
        fileExists(resolveContainedPath(child, PAGE_FILE_NAME)),
        fileExists(resolveContainedPath(child, ROUTE_METADATA_FILE_NAME)),
      ],
      { concurrency: 'unbounded' },
    );
    if (pageRouteExists || routeMetadataExists) {
      yield* pageScaffoldFailure(`Shell route ${route.canonicalPath} uses reserved route prefix ${prefix}`);
    }
    yield* assertShellRouteSegmentIsAvailable(child, index + 1, route, registeredRoutes);
  });

const assertShellRouteIsAvailable = (
  workspaceRoot: string,
  route: PageRoute,
  registeredRoutes: ReadonlySet<string>,
): Effect.Effect<void, PageScaffoldError, FileSystem.FileSystem> =>
  assertShellRouteSegmentIsAvailable(
    resolveContainedPath(workspaceRoot, 'apps', SHELL_APP_ID, 'src', 'routes', '[lang]'),
    0,
    route,
    registeredRoutes,
  );

const generatedWiringEntryMatches = (
  content: string,
  startMarker: string,
  endMarker: string,
  expectedEntry: string,
  identityPattern: RegExp,
): boolean =>
  generatedSlotContainsExactEntry(content, startMarker, endMarker, expectedEntry) &&
  readGeneratedSlotEntries(content, startMarker, endMarker).filter((entry) => {
    identityPattern.lastIndex = 0;
    return identityPattern.test(entry);
  }).length === 1;

const generatedFileMatches = (
  filePath: string,
  expected: string,
): Effect.Effect<boolean, PageScaffoldError, FileSystem.FileSystem> =>
  Effect.gen(function* generatedFileMatchesProgram() {
    if (!(yield* fileExists(filePath))) {
      return false;
    }
    const content = yield* readTextFile(filePath);
    const [actual, generated] = yield* Effect.all([
      formatGeneratedMutationContent(filePath, content),
      formatGeneratedMutationContent(filePath, expected),
    ]).pipe(Effect.mapError((cause) => pageScaffoldFailureFromUnknown(cause, 'generated page formatting failed')));
    return actual === generated;
  });

const generatedWiringContentMatches = (
  vertical: PageVerticalMetadata,
  page: string,
  wiring: ReturnType<typeof pageWiring>,
  navigationMatches: boolean,
): boolean =>
  generatedWiringEntryMatches(
    vertical.manifestContent,
    MODULE_MANIFEST_IMPORT_SLOT_START,
    MODULE_MANIFEST_IMPORT_SLOT_END,
    wiring.manifestImport,
    new RegExp(`\\b${wiring.componentName}\\b`, 'u'),
  ) &&
  generatedWiringEntryMatches(
    vertical.manifestContent,
    MODULE_MANIFEST_COMPONENT_SLOT_START,
    MODULE_MANIFEST_COMPONENT_SLOT_END,
    wiring.manifestComponent,
    new RegExp(`["']page-${page}["']\\s*:`, 'u'),
  ) &&
  navigationMatches &&
  generatedWiringEntryMatches(
    vertical.manifestContent,
    MODULE_MANIFEST_SHELL_PAGE_SLOT_START,
    MODULE_MANIFEST_SHELL_PAGE_SLOT_END,
    wiring.manifestPage,
    new RegExp(`\\bcontributionKey\\s*:\\s*["']${vertical.moduleId}\\.page\\.${page}["']`, 'u'),
  ) &&
  generatedWiringEntryMatches(
    vertical.registrationContent,
    MODULE_REGISTRATION_PAGE_SLOT_START,
    MODULE_REGISTRATION_PAGE_SLOT_END,
    wiring.registrationPage,
    new RegExp(`["']page-${page}["']\\s*:`, 'u'),
  );

const generatedWiringMatches = (
  vertical: PageVerticalMetadata,
  page: string,
  route: PageRoute,
  config: Pick<PageScaffoldConfig, 'authorization' | 'permission'>,
): Effect.Effect<boolean, PageScaffoldError, FileSystem.FileSystem> =>
  Effect.gen(function* generatedWiringMatchesEffect() {
    const wiring = pageWiring(vertical, page, route, config);
    const federationPath = resolveContainedPath(vertical.directory, 'module-federation.config.ts');
    const federation = yield* readTextFile(federationPath);
    const exposureKey = `./Page${toPascalCase(page)}`;
    const expectedExposureSource = `./src/routes/[lang]/${route.relativePath}/page.tsx`;
    const exposureSource = moduleFederationExposureSource(federation, exposureKey);
    const federationMatches = exposureSource === expectedExposureSource;
    const escapedModuleId = vertical.moduleId.replaceAll('.', String.raw`\.`);
    const navigationMatches =
      wiring.manifestNavigation === undefined
        ? readGeneratedSlotEntries(
            vertical.manifestContent,
            MODULE_MANIFEST_SHELL_NAVIGATION_SLOT_START,
            MODULE_MANIFEST_SHELL_NAVIGATION_SLOT_END,
          ).every(
            (entry) =>
              !new RegExp(`\\bcontributionKey\\s*:\\s*["']${escapedModuleId}\\.navigation\\.${page}["']`, 'u').test(
                entry,
              ),
          )
        : generatedWiringEntryMatches(
            vertical.manifestContent,
            MODULE_MANIFEST_SHELL_NAVIGATION_SLOT_START,
            MODULE_MANIFEST_SHELL_NAVIGATION_SLOT_END,
            wiring.manifestNavigation,
            new RegExp(`\\bcontributionKey\\s*:\\s*["']${vertical.moduleId}\\.navigation\\.${page}["']`, 'u'),
          );
    return generatedWiringContentMatches(vertical, page, wiring, navigationMatches) && federationMatches;
  });

const generatedLocaleState = (
  workspaceRoot: string,
  vertical: PageVerticalMetadata,
  locale: string,
  pageKey: string,
): Effect.Effect<GeneratedPageState, PageScaffoldError, FileSystem.FileSystem> =>
  Effect.gen(function* generatedLocaleStateEffect() {
    const localePath = resolveContainedPath(
      workspaceRoot,
      'verticals',
      vertical.slug,
      'locales',
      locale,
      `${vertical.namespace}.json`,
    );
    const { value } = yield* readJsonEffect(
      localePath,
      `${locale} locale catalog`,
      `${locale} locale catalog is invalid`,
    );
    const namespace = asJsonObject(value[vertical.namespace], `${locale} namespace`);
    const pages = asJsonObject(namespace['pages'], `${locale} pages catalog`);
    const copy = pages[pageKey];
    if (Equal.equals(copy, localizedPageCopy(locale))) {
      return 'current';
    }
    return 'invalid';
  });

const generatedPageState = (
  workspaceRoot: string,
  vertical: PageVerticalMetadata,
  page: string,
  route: PageRoute,
  routeDirectory: string,
  pagePath: string,
  routeMetadataPath: string,
  config: Pick<PageScaffoldConfig, 'authorization' | 'permission'>,
): Effect.Effect<GeneratedPageState, PageScaffoldError, FileSystem.FileSystem> =>
  Effect.gen(function* generatedPageStateEffect() {
    const entries = yield* readDirectoryEntries(routeDirectory);
    if (
      entries.length !== 2 ||
      !entries.every((entry) => entry.isFile) ||
      !entries.some((entry) => entry.name === PAGE_FILE_NAME) ||
      !entries.some((entry) => entry.name === ROUTE_METADATA_FILE_NAME)
    ) {
      return 'invalid';
    }
    const fileMatches = yield* Effect.all([
      generatedFileMatches(pagePath, renderPage(vertical, page, route)),
      generatedFileMatches(routeMetadataPath, renderRouteMetadata(vertical, page, route, config)),
    ]);
    if (!fileMatches.every(Boolean)) {
      return 'invalid';
    }
    const pageKey = toCamelCase(page);
    const localeStates = yield* Effect.all(
      vertical.locales.map((locale) => generatedLocaleState(workspaceRoot, vertical, locale, pageKey)),
      { concurrency: 'unbounded' },
    );
    if (!localeStates.every((state) => state === 'current')) {
      return 'invalid';
    }
    return (yield* generatedWiringMatches(vertical, page, route, config)) ? 'current' : 'invalid';
  });

const planPageScaffold = (
  workspaceRoot: string,
  config: PageScaffoldConfig,
): Effect.Effect<ScaffoldPlan<PageScaffoldResult>, PageScaffoldError, FileSystem.FileSystem> =>
  Effect.gen(function* planPageScaffoldEffect() {
    yield* validateReadAuthorization(config);
    const page = yield* Effect.try({
      catch: (cause) => pageScaffoldFailureFromUnknown(cause, 'page name is invalid'),
      try: () => requireCanonicalSlug(config.page, 'page'),
    });
    const vertical = yield* discoverPageVertical(workspaceRoot, config.vertical);
    const route = yield* resolvePageRoute(vertical, page, config.url);
    const routeDirectory = resolveContainedPath(
      workspaceRoot,
      'verticals',
      vertical.slug,
      'src',
      'routes',
      '[lang]',
      ...route.filesystemSegments,
    );
    const pagePath = resolveContainedPath(routeDirectory, PAGE_FILE_NAME);
    const routeMetadataPath = resolveContainedPath(routeDirectory, ROUTE_METADATA_FILE_NAME);
    if (yield* fileExists(routeDirectory)) {
      const state = yield* generatedPageState(
        workspaceRoot,
        vertical,
        page,
        route,
        routeDirectory,
        pagePath,
        routeMetadataPath,
        config,
      );
      if (state === 'current') {
        return {
          mutations: [],
          result: { appId: vertical.appId, pagePath, routeMetadataPath },
        };
      }
      return yield* pageScaffoldFailure(`page route already exists or collides with nested content: ${routeDirectory}`);
    }
    const identity = `${vertical.moduleId}.page.${page}`;
    const pageComponentIdentity = new RegExp(`["']page-${page}["']\\s*:`, 'u');
    const escapedModuleId = vertical.moduleId.replaceAll('.', String.raw`\.`);
    const pageContributionIdentity = new RegExp(`["']${escapedModuleId}\\.page\\.${page}["']`, 'u');
    if (
      pageComponentIdentity.test(vertical.manifestContent) ||
      pageContributionIdentity.test(vertical.manifestContent)
    ) {
      return yield* pageScaffoldFailure(`page identity ${identity} already exists at another URL`);
    }
    const registeredRoutes = yield* ownedPageRoutes(workspaceRoot);
    const existingRouteOwner = registeredRoutes.find(
      (registered) => routeCollisionIdentity(registered.routePath) === routeCollisionIdentity(route.canonicalPath),
    );
    if (existingRouteOwner !== undefined) {
      const reason =
        existingRouteOwner.routePath === route.canonicalPath
          ? `is already registered by ${existingRouteOwner.owner}`
          : `has a routing collision with ${existingRouteOwner.routePath} registered by ${existingRouteOwner.owner}`;
      return yield* pageScaffoldFailure(`page URL ${route.canonicalPath} ${reason}`);
    }
    yield* assertShellRouteIsAvailable(
      workspaceRoot,
      route,
      new Set(registeredRoutes.map((registered) => routeCollisionIdentity(registered.routePath))),
    );
    const federationPath = resolveContainedPath(vertical.directory, 'module-federation.config.ts');
    const [pageMutation, routeMutation, localeMutations, federationContent] = yield* Effect.all(
      [
        createMutationEffect(pagePath, renderPage(vertical, page, route), 'page route could not be created'),
        createMutationEffect(
          routeMetadataPath,
          renderRouteMetadata(vertical, page, route, config),
          'page route metadata could not be created',
        ),
        Effect.all(
          vertical.locales.map((locale) => patchLocale(workspaceRoot, vertical, locale, page)),
          { concurrency: 'unbounded' },
        ),
        readTextFile(federationPath),
      ],
      { concurrency: 'unbounded' },
    );
    const wiring = patchPageWiring(vertical, page, route, config);
    const manifestMutation = updateMutation(vertical.manifestPath, vertical.manifestContent, wiring.manifest);
    const registrationMutation = updateMutation(
      vertical.registrationPath,
      vertical.registrationContent,
      wiring.registration,
    );
    const federationMutation = updateMutation(
      federationPath,
      federationContent,
      insertModuleFederationExposure(
        federationContent,
        `./Page${toPascalCase(page)}`,
        `./src/routes/[lang]/${route.relativePath}/page.tsx`,
      ),
    );
    const mutations = [
      pageMutation,
      routeMutation,
      ...localeMutations,
      manifestMutation,
      registrationMutation,
      federationMutation,
    ].filter((mutation) => mutation !== undefined);
    ensureUniqueMutationPaths(mutations);
    return {
      mutations,
      result: { appId: vertical.appId, pagePath, routeMetadataPath },
    };
  });

export default createCodesmithGenerator<
  PageScaffoldConfig,
  PageScaffoldResult,
  PageScaffoldError,
  FileSystem.FileSystem
>(planPageScaffold);
