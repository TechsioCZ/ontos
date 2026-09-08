import { Effect, Equal, FileSystem, Schema } from 'effect';

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
  createMutation,
  discoverOntosModule,
  ensureUniqueMutationPaths,
  generatedSlotContainsExactEntry,
  insertModuleFederationExposure,
  insertSortedSlot,
  isModuleManifestImport,
  moduleFederationExposureSource,
  patchJsonObjectProperty,
  readJson,
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
const SHELL_PAGE_CLIENT_SLOT_START =
  '// @ontos-codegen-start shell-page-clients';
const SHELL_PAGE_CLIENT_SLOT_END = '// @ontos-codegen-end shell-page-clients';
const SHELL_APP_ID = 'shell-super-app';
const PAGE_FILE_NAME = 'page.tsx';
const PAGE_LOADER_FILE_NAME = 'page.data.ts';
const ROUTE_METADATA_FILE_NAME = 'route.meta.ts';

class PageScaffoldError extends Schema.TaggedError<PageScaffoldError>()(
  'PageScaffoldError',
  {
    cause: Schema.optionalKey(Schema.Unknown),
    message: Schema.String,
  }
) {}

const pageScaffoldFailure = (
  message: string,
  cause?: unknown
): PageScaffoldError =>
  new PageScaffoldError(cause === undefined ? { message } : { cause, message });

const pageScaffoldFailureFromUnknown = (
  cause: unknown,
  fallback: string
): PageScaffoldError =>
  cause instanceof PageScaffoldError
    ? cause
    : pageScaffoldFailure(
        cause instanceof Error ? cause.message : fallback,
        cause
      );

const discoverOntosModuleEffect = (
  workspaceRoot: string,
  requestedVertical: string
): Effect.Effect<OntosVerticalMetadata, PageScaffoldError> =>
  Effect.tryPromise({
    catch: (cause) =>
      pageScaffoldFailureFromUnknown(
        cause,
        `vertical ${requestedVertical} could not be discovered`
      ),
    try: async () =>
      await discoverOntosModule(workspaceRoot, requestedVertical),
  });

const readJsonEffect = (
  filePath: string,
  description: string,
  fallback: string
): Effect.Effect<Awaited<ReturnType<typeof readJson>>, PageScaffoldError> =>
  Effect.tryPromise({
    catch: (cause) => pageScaffoldFailureFromUnknown(cause, fallback),
    try: async () => await readJson(filePath, description),
  });

const createMutationEffect = (
  filePath: string,
  content: string,
  fallback: string
): Effect.Effect<Mutation, PageScaffoldError> =>
  Effect.tryPromise({
    catch: (cause) => pageScaffoldFailureFromUnknown(cause, fallback),
    try: async () => await createMutation(filePath, content),
  });

const mapFileSystemError = <Value, Failure, Requirements>(
  operation: Effect.Effect<Value, Failure, Requirements>
): Effect.Effect<Value, PageScaffoldError, Requirements> =>
  operation.pipe(
    Effect.mapError((cause) =>
      pageScaffoldFailureFromUnknown(
        cause,
        'page scaffold file-system operation failed'
      )
    )
  );

interface DirectoryEntry {
  readonly isDirectory: boolean;
  readonly isFile: boolean;
  readonly name: string;
}

const readDirectoryEntries = (directory: string) =>
  Effect.gen(function* readDirectoryEntriesEffect() {
    const fileSystem = yield* FileSystem.FileSystem;
    const names = yield* mapFileSystemError(
      fileSystem.readDirectory(directory)
    );
    return yield* Effect.all(
      names.map((name) =>
        mapFileSystemError(
          fileSystem.stat(resolveContainedPath(directory, name))
        ).pipe(
          Effect.map((info): DirectoryEntry => ({
            isDirectory: info.type === 'Directory',
            isFile: info.type === 'File',
            name,
          }))
        )
      ),
      { concurrency: 'unbounded' }
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
  requestedUrl: string | undefined
): boolean =>
  canonicalPath.length < 2 ||
  canonicalPath.length > 200 ||
  canonicalSegments.length === 0 ||
  canonicalSegments.some(
    (segment) =>
      !staticRouteSegmentPattern.test(segment) &&
      !parameterRouteSegmentPattern.test(segment)
  ) ||
  new Set(parameterNames).size !== parameterNames.length ||
  (requestedUrl === undefined && parameterNames.length > 0);

const resolvePageRoute = (
  vertical: PageVerticalMetadata,
  page: string,
  requestedUrl: string | undefined
): Effect.Effect<PageRoute, PageScaffoldError> =>
  Effect.gen(function* resolvePageRouteEffect() {
    const canonicalPath = requestedUrl ?? `/${vertical.slug}/${page}`;
    const canonicalSegments = canonicalPath.startsWith('/')
      ? canonicalPath.slice(1).split('/')
      : [];
    const parameterNames = canonicalSegments.flatMap((segment) => {
      const name = parameterRouteSegmentPattern.exec(segment)?.groups?.['name'];
      return name === undefined ? [] : [name];
    });
    if (
      pageRouteIsInvalid(
        canonicalPath,
        canonicalSegments,
        parameterNames,
        requestedUrl
      )
    ) {
      return yield* pageScaffoldFailure(
        '--url must be a root-relative path of lowercase kebab-case segments and unique named :parameters, with no locale, query, fragment, wildcard, optional/catch-all syntax, or trailing slash'
      );
    }
    if (
      requestedUrl !== undefined &&
      routeLocalePrefixPattern.test(canonicalSegments[0] ?? '')
    ) {
      return yield* pageScaffoldFailure(
        '--url must not include a locale prefix; the localized router adds it'
      );
    }
    const filesystemSegments = canonicalSegments.map((segment) => {
      const parameterName =
        parameterRouteSegmentPattern.exec(segment)?.groups?.['name'];
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

const relativeFromRoute = (
  route: PageRoute,
  target: string,
  extraLevels = 0
): string =>
  `${'../'.repeat(route.filesystemSegments.length + extraLevels)}${target}`;

const renderRouteParameterSchemaFields = (
  componentName: string,
  route: PageRoute
): string =>
  route.parameterNames
    .map(
      (name) =>
        `  ${name}: Schema.String.pipe(Schema.brand('${componentName}${toPascalCase(name)}RouteParameter')),`
    )
    .join('\n');

const validateLocale = (
  workspaceRoot: string,
  vertical: OntosVerticalMetadata,
  namespace: string,
  packageExports: JsonObject,
  locale: string
): Effect.Effect<void, PageScaffoldError> =>
  Effect.gen(function* validateLocaleEffect() {
    const expectedExport = `./locales/${locale}/${namespace}.json`;
    if (packageExports[`./locales/${locale}`] !== expectedExport) {
      yield* pageScaffoldFailure(
        `vertical ${vertical.slug} is missing its generated ${locale} locale export`
      );
    }
    const localePath = resolveContainedPath(
      workspaceRoot,
      'verticals',
      vertical.slug,
      'locales',
      locale,
      `${namespace}.json`
    );
    yield* readJsonEffect(
      localePath,
      `vertical ${vertical.slug} ${locale} locale catalog`,
      `vertical ${vertical.slug} ${locale} locale catalog is invalid`
    );
  });

const discoverPageVertical = (
  workspaceRoot: string,
  requestedVertical: string
): Effect.Effect<
  PageVerticalMetadata,
  PageScaffoldError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* discoverPageVerticalEffect() {
    const vertical = yield* discoverOntosModuleEffect(
      workspaceRoot,
      requestedVertical
    );
    const { topologyEntry } = vertical;
    const namespace = requiredString(
      topologyEntry['domain'],
      `vertical ${vertical.slug} namespace`
    );
    if (!namespacePattern.test(namespace)) {
      return yield* pageScaffoldFailure(
        `vertical ${vertical.slug} namespace is not a safe generated identifier`
      );
    }
    const moduleFederation = asJsonObject(
      topologyEntry['moduleFederation'],
      `vertical ${vertical.slug} Module Federation metadata`
    );
    const mfBoundaryId = requiredString(
      moduleFederation['name'],
      `vertical ${vertical.slug} Module Federation boundary`
    );
    if (!moduleFederationNamePattern.test(mfBoundaryId)) {
      return yield* pageScaffoldFailure(
        `vertical ${vertical.slug} Module Federation boundary is invalid`
      );
    }
    const localeRoot = resolveContainedPath(
      workspaceRoot,
      'verticals',
      vertical.slug,
      'locales'
    );
    if (!(yield* fileExists(localeRoot))) {
      return yield* pageScaffoldFailure(
        `vertical ${vertical.slug} locale directory is missing`
      );
    }
    const localeEntries = yield* readDirectoryEntries(localeRoot);
    const locales = localeEntries
      .filter((entry) => entry.isDirectory)
      .map((entry) => entry.name)
      .toSorted();
    if (
      locales.length === 0 ||
      locales.some((locale) => !localePattern.test(locale))
    ) {
      return yield* pageScaffoldFailure(
        `vertical ${vertical.slug} must have one or more valid generated locale directories`
      );
    }
    const unsupportedLocale = locales.find(
      (locale) => !pageStarterLocales.has(locale)
    );
    if (unsupportedLocale !== undefined) {
      return yield* pageScaffoldFailure(
        `page scaffold has no starter translation for locale ${unsupportedLocale}`
      );
    }
    const packageExports = asJsonObject(
      vertical.packageJson['exports'],
      `vertical ${vertical.slug} package exports`
    );
    yield* Effect.all(
      locales.map((locale) =>
        validateLocale(
          workspaceRoot,
          vertical,
          namespace,
          packageExports,
          locale
        )
      ),
      { concurrency: 'unbounded' }
    );
    const routeHeadPath = resolveContainedPath(
      workspaceRoot,
      'verticals',
      vertical.slug,
      'src',
      'routes',
      'ultramodern-route-head.tsx'
    );
    if (!(yield* fileExists(routeHeadPath))) {
      return yield* pageScaffoldFailure(
        `vertical ${vertical.slug} generated UltramodernRouteHead is missing`
      );
    }
    const resourcesName = `${toCamelCase(vertical.slug)}I18nResources`;
    const resourcesPath = resolveContainedPath(
      workspaceRoot,
      'verticals',
      vertical.slug,
      'src',
      'i18n',
      'resources.ts'
    );
    if (!(yield* fileExists(resourcesPath))) {
      return yield* pageScaffoldFailure(
        `vertical ${vertical.slug} generated i18n resources are missing`
      );
    }
    const resourcesContent = yield* readTextFile(resourcesPath);
    if (!resourcesContent.includes(`export const ${resourcesName} =`)) {
      return yield* pageScaffoldFailure(
        `vertical ${vertical.slug} generated i18n resources must export ${resourcesName}`
      );
    }
    return {
      ...vertical,
      locales,
      mfBoundaryId,
      namespace,
      tailwindPrefix: tailwindPrefixForNamespace(namespace),
    };
  });

const renderPage = (
  vertical: PageVerticalMetadata,
  page: string,
  route: PageRoute
): string => {
  const componentName = `${toPascalCase(page)}Page`;
  const keyRoot = `${vertical.namespace}.pages.${toCamelCase(page)}`;
  const prefix = vertical.tailwindPrefix;
  const schemaImport = route.isDynamic
    ? `import { Schema } from 'effect';\n`
    : '';
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
    ? `export const ${componentName} = ({ routeParams }: ${componentName}Props) => {
  void routeParams;`
    : `export const ${componentName} = () => {`;
  return `import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
${schemaImport}import { UltramodernRouteHead } from '${relativeFromRoute(route, 'ultramodern-route-head', 1)}';

${props}${declaration}
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

export default ${componentName};
`;
};

const renderReadAuthorization = (
  config: Pick<PageScaffoldConfig, 'authorization' | 'permission'>
): string => {
  if (config.authorization === 'context_permission') {
    return `{ kind: 'context_permission', permission: '${config.permission ?? ''}' }`;
  }
  return `{ kind: '${config.authorization}' }`;
};

const validateReadAuthorization = (
  config: Pick<PageScaffoldConfig, 'authorization' | 'permission'>
): Effect.Effect<void, PageScaffoldError> =>
  Effect.gen(function* validateReadAuthorizationEffect() {
    if (
      config.authorization === 'context_permission' &&
      (config.permission === undefined ||
        !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u.test(config.permission))
    ) {
      yield* pageScaffoldFailure(
        'context_permission authorization requires a stable --permission value'
      );
    }
    if (
      config.authorization !== 'context_permission' &&
      config.permission !== undefined
    ) {
      yield* pageScaffoldFailure(
        '--permission is valid only for context_permission authorization'
      );
    }
  });

const pageWiring = (
  vertical: PageVerticalMetadata,
  page: string,
  route: PageRoute,
  config: Pick<PageScaffoldConfig, 'authorization' | 'permission'>
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
    manifestPage: `pageContribution({ componentKey: '${componentKey}', contributionKey: '${contributionKey}', entrypoint: ${entrypoint}, routePath: '${route.canonicalPath}' }),`,
    registrationPage: `'page-${page}': () => import('./src/routes/[lang]/${route.relativePath}/page.tsx'),`,
    shellClient: `{ appId: '${vertical.appId}', componentKey: '${componentKey}', load: () => import('${toCamelCase(vertical.appId)}/Page${toPascalCase(page)}') },`,
  } as const;
};

const renderFederatedPage = (
  vertical: PageVerticalMetadata,
  page: string,
  route: PageRoute
): string => {
  const componentName = `${toPascalCase(page)}Page`;
  const federatedComponentName = `${toPascalCase(page)}FederatedPage`;
  const resourcesName = `${toCamelCase(vertical.slug)}I18nResources`;
  const props = route.isDynamic
    ? `interface ${federatedComponentName}Props {
  readonly routeParams: ${componentName}RouteParams;
}

`
    : '';
  const declaration = route.isDynamic
    ? `const ${federatedComponentName} = ({ routeParams }: ${federatedComponentName}Props) => (`
    : `const ${federatedComponentName} = () => (`;
  const ownerPage = route.isDynamic
    ? `<${componentName} routeParams={routeParams} />`
    : `<${componentName} />`;
  const ownerPageImport = route.isDynamic
    ? `import {
  ${componentName},
  type ${componentName}RouteParams,
} from '../routes/[lang]/${route.relativePath}/page';`
    : `import { ${componentName} } from '../routes/[lang]/${route.relativePath}/page';`;
  return `import { FederatedI18nBoundary } from '@modern-js/plugin-i18n/runtime';
import { ${resourcesName} } from '../i18n/resources';
${ownerPageImport}

${props}${declaration}
  <FederatedI18nBoundary
    defaultNamespace="${vertical.namespace}"
    fallbackLanguage="en"
    resources={${resourcesName}}
    supportedLanguages={['en', 'cs']}
  >
    ${ownerPage}
  </FederatedI18nBoundary>
);

export default ${federatedComponentName};
`;
};

interface PageOwnerWiring {
  readonly manifest: string;
  readonly registration: string;
}

const patchPageWiring = (
  vertical: PageVerticalMetadata,
  page: string,
  route: PageRoute,
  config: Pick<PageScaffoldConfig, 'authorization' | 'permission'>
): PageOwnerWiring => {
  const wiring = pageWiring(vertical, page, route, config);
  let manifest = insertSortedSlot(
    vertical.manifestContent,
    MODULE_MANIFEST_IMPORT_SLOT_START,
    MODULE_MANIFEST_IMPORT_SLOT_END,
    [wiring.manifestImport],
    isModuleManifestImport
  );
  manifest = insertSortedSlot(
    manifest,
    MODULE_MANIFEST_COMPONENT_SLOT_START,
    MODULE_MANIFEST_COMPONENT_SLOT_END,
    [wiring.manifestComponent],
    (candidate) => candidate.endsWith(',')
  );
  manifest = insertSortedSlot(
    manifest,
    MODULE_MANIFEST_SHELL_PAGE_SLOT_START,
    MODULE_MANIFEST_SHELL_PAGE_SLOT_END,
    [wiring.manifestPage],
    (candidate) => candidate.endsWith(',')
  );
  if (wiring.manifestNavigation !== undefined) {
    manifest = insertSortedSlot(
      manifest,
      MODULE_MANIFEST_SHELL_NAVIGATION_SLOT_START,
      MODULE_MANIFEST_SHELL_NAVIGATION_SLOT_END,
      [wiring.manifestNavigation],
      (candidate) => candidate.endsWith(',')
    );
  }
  const registration = insertSortedSlot(
    vertical.registrationContent,
    MODULE_REGISTRATION_PAGE_SLOT_START,
    MODULE_REGISTRATION_PAGE_SLOT_END,
    [wiring.registrationPage],
    (candidate) => candidate.endsWith(',')
  );
  return { manifest, registration };
};

const renderRouteMetadata = (
  vertical: PageVerticalMetadata,
  page: string,
  route: PageRoute,
  config: Pick<PageScaffoldConfig, 'authorization' | 'permission'>
): string => {
  const keyRoot = `${vertical.namespace}.pages.${toCamelCase(page)}`;
  const localisedPaths = vertical.locales
    .map((locale) => `    ${locale}: '${route.canonicalPath}',`)
    .join('\n');
  return `import { defineTenantModuleEntrypoint } from '@app/core-runtime';

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

const renderShellConnectorPage = (route: PageRoute): string =>
  `export { default } from '${relativeFromRoute(route, 'modules/[moduleId]/page.tsx')}';
`;

const renderShellConnectorLoader = (
  vertical: PageVerticalMetadata,
  page: string,
  route: PageRoute
): string => {
  const loaderImport = route.isDynamic
    ? `{
  loader as loadModuleTarget,
  selectRouteParams,
}`
    : '{ loader as loadModuleTarget }';
  const parameterNames = route.parameterNames
    .map((name) => `'${name}'`)
    .join(', ');
  const loaderArguments = route.isDynamic
    ? `interface ShellPageLoaderArguments {
  readonly params: Readonly<Record<string, string | undefined>>;
  readonly request: Request;
}

const routeParameterNames = [${parameterNames}] as const;

export const loader = ({ params, request }: ShellPageLoaderArguments) =>
  loadModuleTarget({
    params: {
      entrypointKey: '${vertical.moduleId}.page.${page}',
      moduleId: '${vertical.moduleId}',
    },
    request,
    routeParams: selectRouteParams(params, routeParameterNames),
  });`
    : `interface ShellPageLoaderArguments {
  readonly request: Request;
}

export const loader = ({ request }: ShellPageLoaderArguments) =>
  loadModuleTarget({
    params: {
      entrypointKey: '${vertical.moduleId}.page.${page}',
      moduleId: '${vertical.moduleId}',
    },
    request,
  });`;
  return `import ${loaderImport} from '${relativeFromRoute(route, 'modules/[moduleId]/page.data.ts')}';

${loaderArguments}
`;
};

const renderShellConnectorMetadata = (
  vertical: PageVerticalMetadata,
  page: string,
  route: PageRoute,
  config: Pick<PageScaffoldConfig, 'authorization' | 'permission'>
): string => {
  const localisedPaths = vertical.locales
    .map((locale) => `    ${locale}: '${route.canonicalPath}',`)
    .join('\n');
  return `import { defineSystemModuleEntrypoint } from '@app/core-runtime';

const routeMeta = {
  canonicalPath: '${route.canonicalPath}',
  descriptionKey: 'shell.moduleTarget.seoDescription',
  entrypoint: defineSystemModuleEntrypoint({
    access: 'read',
    authorization: ${renderReadAuthorization(config)},
    entrypointKey: 'shell-super-app.page.${vertical.appId}-${page}',
    moduleKey: 'shell-super-app',
    role: 'page',
  }),
  id: 'shell-${vertical.appId}-${page}',
  indexable: false,
  localisedPaths: {
${localisedPaths}
  },
  mfBoundaryId: 'shellSuperApp',
  namespace: 'shell',
  ownerAppId: 'shell-super-app',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'shell.moduleTarget.title',
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
  page: string
): Effect.Effect<Mutation, PageScaffoldError> =>
  Effect.gen(function* patchLocaleEffect() {
    const localePath = resolveContainedPath(
      workspaceRoot,
      'verticals',
      vertical.slug,
      'locales',
      locale,
      `${vertical.namespace}.json`
    );
    const { content, value } = yield* readJsonEffect(
      localePath,
      `${locale} locale catalog`,
      `${locale} locale catalog is invalid`
    );
    const namespaceValue = value[vertical.namespace];
    const namespace: MutableJsonObject = {
      ...asJsonObject(
        namespaceValue,
        `${locale} ${vertical.namespace} namespace`
      ),
    };
    const pagesValue = namespace['pages'];
    const pages: MutableJsonObject =
      pagesValue === undefined
        ? {}
        : { ...asJsonObject(pagesValue, `${locale} pages catalog`) };
    const pageKey = toCamelCase(page);
    if (pages[pageKey] !== undefined) {
      return yield* pageScaffoldFailure(
        `locale key ${vertical.namespace}.pages.${pageKey} already exists in ${locale}`
      );
    }
    pages[pageKey] = localizedPageCopy(locale);
    const sortedPages = Object.fromEntries(
      Object.entries(pages).toSorted(([left], [right]) =>
        left.localeCompare(right)
      )
    );
    const patched = patchJsonObjectProperty(
      content,
      [vertical.namespace],
      'pages',
      sortedPages
    );
    const mutation = updateMutation(localePath, content, patched);
    if (mutation === undefined) {
      return yield* pageScaffoldFailure(
        `locale patch unexpectedly made no change for ${locale}`
      );
    }
    return mutation;
  });

const GeneratedPageStateSchema = Schema.Literals(['current', 'invalid']);
type GeneratedPageState = typeof GeneratedPageStateSchema.Type;

interface OwnedPageRoute {
  readonly owner: string;
  readonly routePath: string;
}

const ownedPageRoute = (
  owner: string,
  candidate: string
): Effect.Effect<OwnedPageRoute, PageScaffoldError> =>
  Effect.gen(function* ownedPageRouteEffect() {
    const matches = [
      ...candidate.matchAll(/\broutePath:\s*'(?<routePath>\/[^']+)'/gu),
    ];
    const routePath = matches[0]?.groups?.['routePath'];
    if (matches.length !== 1 || routePath === undefined) {
      return yield* pageScaffoldFailure(
        `generated owner slot contains unsupported developer content: ${MODULE_MANIFEST_SHELL_PAGE_SLOT_START}`
      );
    }
    return { owner, routePath };
  });

const readOwnerRoutes = (
  verticalRoot: string,
  owner: string
): Effect.Effect<
  readonly OwnedPageRoute[],
  PageScaffoldError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* readOwnerRoutesEffect() {
    const manifestPath = resolveContainedPath(
      verticalRoot,
      owner,
      'vertical.manifest.ts'
    );
    if (!(yield* fileExists(manifestPath))) {
      return [];
    }
    const manifest = yield* readTextFile(manifestPath);
    return yield* Effect.all(
      readGeneratedSlotEntries(
        manifest,
        MODULE_MANIFEST_SHELL_PAGE_SLOT_START,
        MODULE_MANIFEST_SHELL_PAGE_SLOT_END
      ).map((candidate) => ownedPageRoute(owner, candidate)),
      { concurrency: 'unbounded' }
    );
  });

const ownedPageRoutes = (
  workspaceRoot: string
): Effect.Effect<
  readonly OwnedPageRoute[],
  PageScaffoldError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* ownedPageRoutesEffect() {
    const verticalRoot = resolveContainedPath(workspaceRoot, 'verticals');
    const verticals = yield* readDirectoryEntries(verticalRoot);
    const ownedRoutes = yield* Effect.all(
      verticals
        .filter((entry) => entry.isDirectory)
        .map((entry) => readOwnerRoutes(verticalRoot, entry.name)),
      { concurrency: 'unbounded' }
    );
    return ownedRoutes.flat();
  });

const isDynamicShellRouteSegment = (segment: string): boolean =>
  /^\[.+\]$/u.test(segment) ||
  segment.startsWith('$') ||
  segment.startsWith('*');

const routeCollisionIdentity = (routePath: string): string =>
  routePath
    .split('/')
    .map((segment) =>
      parameterRouteSegmentPattern.test(segment) ? ':parameter' : segment
    )
    .join('/');

const assertShellRouteSiblingsAreAvailable = (
  entries: readonly DirectoryEntry[],
  segment: string,
  route: PageRoute
) =>
  Effect.gen(function* assertShellRouteSiblingsAreAvailableEffect() {
    const desiredSegmentIsDynamic = isDynamicShellRouteSegment(segment);
    const siblingCollision = entries.find(
      (entry) =>
        entry.isDirectory &&
        (desiredSegmentIsDynamic || isDynamicShellRouteSegment(entry.name))
    );
    if (siblingCollision !== undefined) {
      const collisionKind = isDynamicShellRouteSegment(siblingCollision.name)
        ? 'dynamic'
        : 'static';
      yield* pageScaffoldFailure(
        `Shell route ${route.canonicalPath} collides with ${collisionKind} route segment ${siblingCollision.name}`
      );
    }
  });

const assertShellRouteSegmentIsAvailable = (
  parent: string,
  index: number,
  route: PageRoute,
  registeredRoutes: ReadonlySet<string>
): Effect.Effect<void, PageScaffoldError, FileSystem.FileSystem> =>
  Effect.gen(function* assertShellRouteSegmentIsAvailableEffect() {
    const segment = route.filesystemSegments[index];
    if (segment === undefined || !(yield* fileExists(parent))) {
      return;
    }
    const entries = yield* readDirectoryEntries(parent);
    const childEntry = entries.find((entry) => entry.name === segment);
    if (childEntry === undefined) {
      yield* assertShellRouteSiblingsAreAvailable(entries, segment, route);
      return;
    }
    const child = resolveContainedPath(parent, segment);
    if (index === route.filesystemSegments.length - 1) {
      yield* pageScaffoldFailure(
        `Shell route already exists or collides with generated page: ${child}`
      );
    }
    if (!childEntry.isDirectory) {
      yield* pageScaffoldFailure(
        `Shell route ${route.canonicalPath} collides with reserved route content`
      );
    }
    const prefix = `/${route.canonicalSegments.slice(0, index + 1).join('/')}`;
    const ownsPrefix = registeredRoutes.has(prefix);
    const [pageRouteExists, routeMetadataExists] = yield* Effect.all(
      [
        fileExists(resolveContainedPath(child, PAGE_FILE_NAME)),
        fileExists(resolveContainedPath(child, ROUTE_METADATA_FILE_NAME)),
      ],
      { concurrency: 'unbounded' }
    );
    if ((pageRouteExists || routeMetadataExists) && !ownsPrefix) {
      yield* pageScaffoldFailure(
        `Shell route ${route.canonicalPath} uses reserved route prefix ${prefix}`
      );
    }
    yield* assertShellRouteSegmentIsAvailable(
      child,
      index + 1,
      route,
      registeredRoutes
    );
  });

const assertShellRouteIsAvailable = (
  workspaceRoot: string,
  route: PageRoute,
  registeredRoutes: ReadonlySet<string>
): Effect.Effect<void, PageScaffoldError, FileSystem.FileSystem> =>
  assertShellRouteSegmentIsAvailable(
    resolveContainedPath(
      workspaceRoot,
      'apps',
      SHELL_APP_ID,
      'src',
      'routes',
      '[lang]'
    ),
    0,
    route,
    registeredRoutes
  );

const resolveGeneratedPageContentState = (
  pageContent: string,
  vertical: PageVerticalMetadata,
  page: string,
  route: PageRoute
): GeneratedPageState => {
  if (pageContent === renderPage(vertical, page, route)) {
    return 'current';
  }
  return 'invalid';
};

const generatedWiringEntryMatches = (
  content: string,
  startMarker: string,
  endMarker: string,
  expectedEntry: string,
  identityPattern: RegExp
): boolean =>
  generatedSlotContainsExactEntry(
    content,
    startMarker,
    endMarker,
    expectedEntry
  ) &&
  readGeneratedSlotEntries(content, startMarker, endMarker).filter((entry) => {
    identityPattern.lastIndex = 0;
    return identityPattern.test(entry);
  }).length === 1;

const generatedFileMatches = (
  filePath: string,
  expected: string
): Effect.Effect<boolean, PageScaffoldError, FileSystem.FileSystem> =>
  fileExists(filePath).pipe(
    Effect.flatMap((exists) =>
      exists
        ? readTextFile(filePath).pipe(
            Effect.map((content) => content === expected)
          )
        : Effect.succeed(false)
    )
  );

const generatedWiringContentMatches = (
  vertical: PageVerticalMetadata,
  page: string,
  wiring: ReturnType<typeof pageWiring>,
  shellClients: string,
  navigationMatches: boolean
): boolean =>
  generatedWiringEntryMatches(
    vertical.manifestContent,
    MODULE_MANIFEST_IMPORT_SLOT_START,
    MODULE_MANIFEST_IMPORT_SLOT_END,
    wiring.manifestImport,
    new RegExp(`\\b${wiring.componentName}\\b`, 'u')
  ) &&
  generatedWiringEntryMatches(
    vertical.manifestContent,
    MODULE_MANIFEST_COMPONENT_SLOT_START,
    MODULE_MANIFEST_COMPONENT_SLOT_END,
    wiring.manifestComponent,
    new RegExp(`["']page-${page}["']\\s*:`, 'u')
  ) &&
  navigationMatches &&
  generatedWiringEntryMatches(
    vertical.manifestContent,
    MODULE_MANIFEST_SHELL_PAGE_SLOT_START,
    MODULE_MANIFEST_SHELL_PAGE_SLOT_END,
    wiring.manifestPage,
    new RegExp(
      `\\bcontributionKey\\s*:\\s*["']${vertical.moduleId}\\.page\\.${page}["']`,
      'u'
    )
  ) &&
  generatedWiringEntryMatches(
    vertical.registrationContent,
    MODULE_REGISTRATION_PAGE_SLOT_START,
    MODULE_REGISTRATION_PAGE_SLOT_END,
    wiring.registrationPage,
    new RegExp(`["']page-${page}["']\\s*:`, 'u')
  ) &&
  generatedWiringEntryMatches(
    shellClients,
    SHELL_PAGE_CLIENT_SLOT_START,
    SHELL_PAGE_CLIENT_SLOT_END,
    wiring.shellClient,
    new RegExp(
      `\\bcomponentKey\\s*:\\s*["']${vertical.moduleId}\\.page-${page}["']`,
      'u'
    )
  );

const generatedWiringMatches = (
  workspaceRoot: string,
  vertical: PageVerticalMetadata,
  page: string,
  route: PageRoute,
  config: Pick<PageScaffoldConfig, 'authorization' | 'permission'>
): Effect.Effect<boolean, PageScaffoldError, FileSystem.FileSystem> =>
  Effect.gen(function* generatedWiringMatchesEffect() {
    const wiring = pageWiring(vertical, page, route, config);
    const federationPath = resolveContainedPath(
      vertical.directory,
      'module-federation.config.ts'
    );
    const [federation, shellClients] = yield* Effect.all(
      [
        readTextFile(federationPath),
        readTextFile(
          resolveContainedPath(
            workspaceRoot,
            'apps',
            SHELL_APP_ID,
            'src',
            'api',
            'vertical-clients.ts'
          )
        ),
      ],
      { concurrency: 'unbounded' }
    );
    const shellRouteDirectory = resolveContainedPath(
      workspaceRoot,
      'apps',
      SHELL_APP_ID,
      'src',
      'routes',
      '[lang]',
      ...route.filesystemSegments
    );
    const expectedShellFiles = [
      [PAGE_FILE_NAME, renderShellConnectorPage(route)],
      [
        PAGE_LOADER_FILE_NAME,
        renderShellConnectorLoader(vertical, page, route),
      ],
      [
        ROUTE_METADATA_FILE_NAME,
        renderShellConnectorMetadata(vertical, page, route, config),
      ],
    ] as const;
    const shellRouteMatches = yield* Effect.all(
      expectedShellFiles.map(([fileName, expected]) =>
        generatedFileMatches(
          resolveContainedPath(shellRouteDirectory, fileName),
          expected
        )
      ),
      { concurrency: 'unbounded' }
    );
    const shellRouteEntries = yield* readDirectoryEntries(shellRouteDirectory);
    const shellRouteInventoryMatches =
      shellRouteEntries.length === expectedShellFiles.length &&
      shellRouteEntries.every(
        (entry) =>
          entry.isFile &&
          expectedShellFiles.some(
            ([expectedName]) => expectedName === entry.name
          )
      );
    const exposureKey = `./Page${toPascalCase(page)}`;
    const expectedExposureSource = `./src/federation/page-${page}.tsx`;
    const exposureSource = moduleFederationExposureSource(
      federation,
      exposureKey
    );
    const federatedPagePath = resolveContainedPath(
      vertical.directory,
      expectedExposureSource
    );
    const federatedPageExists = yield* fileExists(federatedPagePath);
    const federationMatches =
      exposureSource === expectedExposureSource &&
      federatedPageExists &&
      (yield* readTextFile(federatedPagePath)) ===
        renderFederatedPage(vertical, page, route);
    const escapedModuleId = vertical.moduleId.replaceAll('.', String.raw`\.`);
    const navigationMatches =
      wiring.manifestNavigation === undefined
        ? readGeneratedSlotEntries(
            vertical.manifestContent,
            MODULE_MANIFEST_SHELL_NAVIGATION_SLOT_START,
            MODULE_MANIFEST_SHELL_NAVIGATION_SLOT_END
          ).every(
            (entry) =>
              !new RegExp(
                `\\bcontributionKey\\s*:\\s*["']${escapedModuleId}\\.navigation\\.${page}["']`,
                'u'
              ).test(entry)
          )
        : generatedWiringEntryMatches(
            vertical.manifestContent,
            MODULE_MANIFEST_SHELL_NAVIGATION_SLOT_START,
            MODULE_MANIFEST_SHELL_NAVIGATION_SLOT_END,
            wiring.manifestNavigation,
            new RegExp(
              `\\bcontributionKey\\s*:\\s*["']${vertical.moduleId}\\.navigation\\.${page}["']`,
              'u'
            )
          );
    return (
      generatedWiringContentMatches(
        vertical,
        page,
        wiring,
        shellClients,
        navigationMatches
      ) &&
      federationMatches &&
      shellRouteMatches.every(Boolean) &&
      shellRouteInventoryMatches
    );
  });

const generatedLocaleState = (
  workspaceRoot: string,
  vertical: PageVerticalMetadata,
  locale: string,
  pageKey: string
): Effect.Effect<GeneratedPageState, PageScaffoldError> =>
  Effect.gen(function* generatedLocaleStateEffect() {
    const localePath = resolveContainedPath(
      workspaceRoot,
      'verticals',
      vertical.slug,
      'locales',
      locale,
      `${vertical.namespace}.json`
    );
    const { value } = yield* readJsonEffect(
      localePath,
      `${locale} locale catalog`,
      `${locale} locale catalog is invalid`
    );
    const namespace = asJsonObject(
      value[vertical.namespace],
      `${locale} namespace`
    );
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
  config: Pick<PageScaffoldConfig, 'authorization' | 'permission'>
): Effect.Effect<
  GeneratedPageState,
  PageScaffoldError,
  FileSystem.FileSystem
> =>
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
    const [pageContent, routeMetadataContent] = yield* Effect.all(
      [readTextFile(pagePath), readTextFile(routeMetadataPath)],
      { concurrency: 'unbounded' }
    );
    const expectedMetadata = renderRouteMetadata(vertical, page, route, config);
    if (routeMetadataContent !== expectedMetadata) {
      return 'invalid';
    }
    const pageState = resolveGeneratedPageContentState(
      pageContent,
      vertical,
      page,
      route
    );
    if (pageState === 'invalid') {
      return 'invalid';
    }
    const pageKey = toCamelCase(page);
    const localeStates = yield* Effect.all(
      vertical.locales.map((locale) =>
        generatedLocaleState(workspaceRoot, vertical, locale, pageKey)
      ),
      { concurrency: 'unbounded' }
    );
    if (!localeStates.every((state) => state === pageState)) {
      return 'invalid';
    }
    return (yield* generatedWiringMatches(
      workspaceRoot,
      vertical,
      page,
      route,
      config
    ))
      ? pageState
      : 'invalid';
  });

const planPageScaffold = (
  workspaceRoot: string,
  config: PageScaffoldConfig
): Effect.Effect<
  ScaffoldPlan<PageScaffoldResult>,
  PageScaffoldError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* planPageScaffoldEffect() {
    yield* validateReadAuthorization(config);
    const page = yield* Effect.try({
      catch: (cause) =>
        pageScaffoldFailureFromUnknown(cause, 'page name is invalid'),
      try: () => requireCanonicalSlug(config.page, 'page'),
    });
    const vertical = yield* discoverPageVertical(
      workspaceRoot,
      config.vertical
    );
    const route = yield* resolvePageRoute(vertical, page, config.url);
    const routeDirectory = resolveContainedPath(
      workspaceRoot,
      'verticals',
      vertical.slug,
      'src',
      'routes',
      '[lang]',
      ...route.filesystemSegments
    );
    const pagePath = resolveContainedPath(routeDirectory, PAGE_FILE_NAME);
    const routeMetadataPath = resolveContainedPath(
      routeDirectory,
      ROUTE_METADATA_FILE_NAME
    );
    const shellRouteDirectory = resolveContainedPath(
      workspaceRoot,
      'apps',
      SHELL_APP_ID,
      'src',
      'routes',
      '[lang]',
      ...route.filesystemSegments
    );
    if (yield* fileExists(routeDirectory)) {
      const state = yield* generatedPageState(
        workspaceRoot,
        vertical,
        page,
        route,
        routeDirectory,
        pagePath,
        routeMetadataPath,
        config
      );
      if (state === 'current') {
        return {
          mutations: [],
          result: { appId: vertical.appId, pagePath, routeMetadataPath },
        };
      }
      return yield* pageScaffoldFailure(
        `page route already exists or collides with nested content: ${routeDirectory}`
      );
    }
    const identity = `${vertical.moduleId}.page.${page}`;
    const pageComponentIdentity = new RegExp(`["']page-${page}["']\\s*:`, 'u');
    const escapedModuleId = vertical.moduleId.replaceAll('.', String.raw`\.`);
    const pageContributionIdentity = new RegExp(
      `["']${escapedModuleId}\\.page\\.${page}["']`,
      'u'
    );
    if (
      pageComponentIdentity.test(vertical.manifestContent) ||
      pageContributionIdentity.test(vertical.manifestContent)
    ) {
      return yield* pageScaffoldFailure(
        `page identity ${identity} already exists at another URL`
      );
    }
    const registeredRoutes = yield* ownedPageRoutes(workspaceRoot);
    const existingRouteOwner = registeredRoutes.find(
      (registered) =>
        routeCollisionIdentity(registered.routePath) ===
        routeCollisionIdentity(route.canonicalPath)
    );
    if (existingRouteOwner !== undefined) {
      const reason =
        existingRouteOwner.routePath === route.canonicalPath
          ? `is already registered by ${existingRouteOwner.owner}`
          : `has a routing collision with ${existingRouteOwner.routePath} registered by ${existingRouteOwner.owner}`;
      return yield* pageScaffoldFailure(
        `page URL ${route.canonicalPath} ${reason}`
      );
    }
    yield* assertShellRouteIsAvailable(
      workspaceRoot,
      route,
      new Set(registeredRoutes.map((registered) => registered.routePath))
    );
    const federationPath = resolveContainedPath(
      vertical.directory,
      'module-federation.config.ts'
    );
    const federatedPagePath = resolveContainedPath(
      vertical.directory,
      'src',
      'federation',
      `page-${page}.tsx`
    );
    const shellClientsPath = resolveContainedPath(
      workspaceRoot,
      'apps',
      SHELL_APP_ID,
      'src',
      'api',
      'vertical-clients.ts'
    );
    const [
      pageMutation,
      routeMutation,
      localeMutations,
      federationContent,
      shellClientsContent,
    ] = yield* Effect.all(
      [
        createMutationEffect(
          pagePath,
          renderPage(vertical, page, route),
          'page route could not be created'
        ),
        createMutationEffect(
          routeMetadataPath,
          renderRouteMetadata(vertical, page, route, config),
          'page route metadata could not be created'
        ),
        Effect.all(
          vertical.locales.map((locale) =>
            patchLocale(workspaceRoot, vertical, locale, page)
          ),
          { concurrency: 'unbounded' }
        ),
        readTextFile(federationPath),
        readTextFile(shellClientsPath),
      ],
      { concurrency: 'unbounded' }
    );
    const wiring = patchPageWiring(vertical, page, route, config);
    const manifestMutation = updateMutation(
      vertical.manifestPath,
      vertical.manifestContent,
      wiring.manifest
    );
    const registrationMutation = updateMutation(
      vertical.registrationPath,
      vertical.registrationContent,
      wiring.registration
    );
    const federatedPageMutation = yield* createMutationEffect(
      federatedPagePath,
      renderFederatedPage(vertical, page, route),
      'federated page could not be created'
    );
    const federationMutation = updateMutation(
      federationPath,
      federationContent,
      insertModuleFederationExposure(
        federationContent,
        `./Page${toPascalCase(page)}`,
        `./src/federation/page-${page}.tsx`
      )
    );
    const shellClientsMutation = updateMutation(
      shellClientsPath,
      shellClientsContent,
      insertSortedSlot(
        shellClientsContent,
        SHELL_PAGE_CLIENT_SLOT_START,
        SHELL_PAGE_CLIENT_SLOT_END,
        [pageWiring(vertical, page, route, config).shellClient],
        (candidate) => candidate.endsWith(',')
      )
    );
    const [shellPageMutation, shellLoaderMutation, shellRouteMetadataMutation] =
      yield* Effect.all(
        [
          createMutationEffect(
            resolveContainedPath(shellRouteDirectory, PAGE_FILE_NAME),
            renderShellConnectorPage(route),
            'Shell page connector could not be created'
          ),
          createMutationEffect(
            resolveContainedPath(shellRouteDirectory, PAGE_LOADER_FILE_NAME),
            renderShellConnectorLoader(vertical, page, route),
            'Shell page loader could not be created'
          ),
          createMutationEffect(
            resolveContainedPath(shellRouteDirectory, ROUTE_METADATA_FILE_NAME),
            renderShellConnectorMetadata(vertical, page, route, config),
            'Shell route metadata could not be created'
          ),
        ],
        { concurrency: 'unbounded' }
      );
    const mutations = [
      pageMutation,
      routeMutation,
      ...localeMutations,
      manifestMutation,
      registrationMutation,
      federatedPageMutation,
      federationMutation,
      shellClientsMutation,
      shellPageMutation,
      shellLoaderMutation,
      shellRouteMetadataMutation,
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
