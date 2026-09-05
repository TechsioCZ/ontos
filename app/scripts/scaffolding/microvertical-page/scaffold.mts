import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createCodesmithGenerator } from '../generator-adapter.mts';
import { tailwindPrefixForNamespace } from '../tailwind-prefix.mts';
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
  isMissingFileError,
  moduleFederationExposureSource,
  patchJsonObjectProperty,
  pathExists,
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

interface PageVerticalMetadata extends OntosVerticalMetadata {
  readonly locales: readonly string[];
  readonly mfBoundaryId: string;
  readonly namespace: string;
  readonly tailwindPrefix: string;
}

interface PageRoute {
  readonly canonicalSegments: readonly string[];
  readonly canonicalPath: string;
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
const SHELL_PAGE_CLIENT_SLOT_START = '// @ontos-codegen-start shell-page-clients';
const SHELL_PAGE_CLIENT_SLOT_END = '// @ontos-codegen-end shell-page-clients';

const resolvePageRoute = (
  vertical: PageVerticalMetadata,
  page: string,
  requestedUrl: string | undefined,
): PageRoute => {
  const canonicalPath = requestedUrl ?? `/${vertical.slug}/${page}`;
  const canonicalSegments = canonicalPath.startsWith('/') ? canonicalPath.slice(1).split('/') : [];
  const parameterNames = canonicalSegments.flatMap((segment) => {
    const name = parameterRouteSegmentPattern.exec(segment)?.groups?.['name'];
    return name === undefined ? [] : [name];
  });
  if (
    canonicalPath.length < 2 ||
    canonicalPath.length > 200 ||
    canonicalSegments.length === 0 ||
    canonicalSegments.some(
      (segment) =>
        !staticRouteSegmentPattern.test(segment) && !parameterRouteSegmentPattern.test(segment),
    ) ||
    new Set(parameterNames).size !== parameterNames.length ||
    (requestedUrl === undefined && parameterNames.length > 0)
  ) {
    throw new Error(
      '--url must be a root-relative path of lowercase kebab-case segments and unique named :parameters, with no locale, query, fragment, wildcard, optional/catch-all syntax, or trailing slash',
    );
  }
  if (requestedUrl !== undefined && routeLocalePrefixPattern.test(canonicalSegments[0] ?? '')) {
    throw new Error('--url must not include a locale prefix; the localized router adds it');
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
};

const relativeFromRoute = (route: PageRoute, target: string, extraLevels = 0): string =>
  `${'../'.repeat(route.filesystemSegments.length + extraLevels)}${target}`;

const renderRouteParameterType = (route: PageRoute): string =>
  route.parameterNames.map((name) => `'${name}'`).join(' | ');

const discoverPageVertical = async (
  workspaceRoot: string,
  requestedVertical: string,
): Promise<PageVerticalMetadata> => {
  const vertical = await discoverOntosModule(workspaceRoot, requestedVertical);
  const { topologyEntry } = vertical;
  const namespace = requiredString(topologyEntry['domain'], `vertical ${vertical.slug} namespace`);
  if (!namespacePattern.test(namespace)) {
    throw new Error(`vertical ${vertical.slug} namespace is not a safe generated identifier`);
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
    throw new Error(`vertical ${vertical.slug} Module Federation boundary is invalid`);
  }
  const localeRoot = resolveContainedPath(workspaceRoot, 'verticals', vertical.slug, 'locales');
  let localeEntries;
  try {
    localeEntries = await readdir(localeRoot, { withFileTypes: true });
  } catch (error) {
    if (isMissingFileError(error)) {
      throw new Error(`vertical ${vertical.slug} locale directory is missing`, { cause: error });
    }
    throw error;
  }
  const locales = localeEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted();
  if (locales.length === 0 || locales.some((locale) => !localePattern.test(locale))) {
    throw new Error(
      `vertical ${vertical.slug} must have one or more valid generated locale directories`,
    );
  }
  const unsupportedLocale = locales.find((locale) => !pageStarterLocales.has(locale));
  if (unsupportedLocale !== undefined) {
    throw new Error(`page scaffold has no starter translation for locale ${unsupportedLocale}`);
  }
  const packageExports = asJsonObject(
    vertical.packageJson['exports'],
    `vertical ${vertical.slug} package exports`,
  );
  await Promise.all(
    locales.map(async (locale) => {
      const expectedExport = `./locales/${locale}/${namespace}.json`;
      if (packageExports[`./locales/${locale}`] !== expectedExport) {
        throw new Error(
          `vertical ${vertical.slug} is missing its generated ${locale} locale export`,
        );
      }
      await readJson(
        resolveContainedPath(
          workspaceRoot,
          'verticals',
          vertical.slug,
          'locales',
          locale,
          `${namespace}.json`,
        ),
        `vertical ${vertical.slug} ${locale} locale catalog`,
      );
    }),
  );
  const routeHeadPath = resolveContainedPath(
    workspaceRoot,
    'verticals',
    vertical.slug,
    'src',
    'routes',
    'ultramodern-route-head.tsx',
  );
  if (!(await pathExists(routeHeadPath))) {
    throw new Error(`vertical ${vertical.slug} generated UltramodernRouteHead is missing`);
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
  if (!(await pathExists(resourcesPath))) {
    throw new Error(`vertical ${vertical.slug} generated i18n resources are missing`);
  }
  const resourcesContent = await readFile(resourcesPath, 'utf-8');
  if (!resourcesContent.includes(`export const ${resourcesName} =`)) {
    throw new Error(
      `vertical ${vertical.slug} generated i18n resources must export ${resourcesName}`,
    );
  }
  return {
    ...vertical,
    locales,
    mfBoundaryId,
    namespace,
    tailwindPrefix: tailwindPrefixForNamespace(namespace),
  };
};

const renderPage = (vertical: PageVerticalMetadata, page: string, route: PageRoute): string => {
  const componentName = `${toPascalCase(page)}Page`;
  const keyRoot = `${vertical.namespace}.pages.${toCamelCase(page)}`;
  const prefix = vertical.tailwindPrefix;
  const routeParameterType = renderRouteParameterType(route);
  const props = route.isDynamic
    ? `type ${componentName}RouteParams = Readonly<Partial<Record<${routeParameterType}, string>>>;

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
import { UltramodernRouteHead } from '${relativeFromRoute(route, 'ultramodern-route-head', 1)}';

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

const renderLegacyPage = (
  vertical: PageVerticalMetadata,
  page: string,
  route: PageRoute,
): string => {
  const componentName = `${toPascalCase(page)}Page`;
  const keyRoot = `${vertical.namespace}.pages.${toCamelCase(page)}`;
  const prefix = vertical.tailwindPrefix;
  return `import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { UltramodernRouteHead } from '${relativeFromRoute(route, 'ultramodern-route-head', 1)}';

export const ${componentName} = () => {
  const { t } = useModernI18n();
  const headingId = '${page}-heading';

  return (
    <>
      <UltramodernRouteHead />
      <main className="${prefix}:min-h-screen ${prefix}:bg-(--color-page-bg) ${prefix}:px-4 ${prefix}:py-8 ${prefix}:text-(--color-page-fg) ${prefix}:sm:px-8 ${prefix}:lg:px-12">
        <div className="${prefix}:mx-auto ${prefix}:flex ${prefix}:max-w-5xl ${prefix}:flex-col ${prefix}:gap-8">
          <header className="${prefix}:space-y-3">
            <h1
              className="${prefix}:text-3xl ${prefix}:font-bold ${prefix}:sm:text-4xl"
              id={headingId}
            >
              {t('${keyRoot}.title')}
            </h1>
            <p className="${prefix}:max-w-2xl ${prefix}:text-base ${prefix}:sm:text-lg">
              {t('${keyRoot}.description')}
            </p>
          </header>
          <section
            aria-labelledby={headingId}
            className="${prefix}:bg-(--color-surface) ${prefix}:p-6 ${prefix}:sm:p-8"
          >
            <p>{t('${keyRoot}.empty')}</p>
          </section>
        </div>
      </main>
    </>
  );
};

export default ${componentName};
`;
};

const renderFormattedLegacyPage = (
  vertical: PageVerticalMetadata,
  page: string,
  route: PageRoute,
): string =>
  renderLegacyPage(vertical, page, route).replace(
    `            <h1
              className="${vertical.tailwindPrefix}:text-3xl ${vertical.tailwindPrefix}:font-bold ${vertical.tailwindPrefix}:sm:text-4xl"
              id={headingId}
            >`,
    `            <h1 className="${vertical.tailwindPrefix}:text-3xl ${vertical.tailwindPrefix}:font-bold ${vertical.tailwindPrefix}:sm:text-4xl" id={headingId}>`,
  );

const renderReadAuthorization = (
  config: Pick<PageScaffoldConfig, 'authorization' | 'permission'>,
): string => {
  if (config.authorization === 'context_permission') {
    if (
      config.permission === undefined ||
      !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u.test(config.permission)
    ) {
      throw new Error('context_permission authorization requires a stable --permission value');
    }
    return `{ kind: 'context_permission', permission: '${config.permission}' }`;
  }
  if (config.permission !== undefined) {
    throw new Error('--permission is valid only for context_permission authorization');
  }
  return `{ kind: '${config.authorization}' }`;
};

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
      : `{ contributionKey: '${vertical.moduleId}.navigation.${page}', entrypoint: ${entrypoint}, groupKey: 'shell.navigation.modules', order: 100, pageKey: '${contributionKey}' },`,
    manifestPage: `{ componentKey: '${componentKey}', contributionKey: '${contributionKey}', entrypoint: ${entrypoint}, routePath: '${route.canonicalPath}' },`,
    registrationPage: `'page-${page}': () => import('./src/routes/[lang]/${route.relativePath}/page.tsx'),`,
    shellClient: `{ appId: '${vertical.appId}', componentKey: '${componentKey}', load: () => import('${toCamelCase(vertical.appId)}/Page${toPascalCase(page)}') },`,
  } as const;
};

const renderFederatedPage = (
  vertical: PageVerticalMetadata,
  page: string,
  route: PageRoute,
): string => {
  const componentName = `${toPascalCase(page)}Page`;
  const federatedComponentName = `${toPascalCase(page)}FederatedPage`;
  const resourcesName = `${toCamelCase(vertical.slug)}I18nResources`;
  const routeParameterType = renderRouteParameterType(route);
  const props = route.isDynamic
    ? `type ${federatedComponentName}RouteParams = Readonly<Partial<Record<${routeParameterType}, string>>>;

interface ${federatedComponentName}Props {
  readonly routeParams: ${federatedComponentName}RouteParams;
}

`
    : '';
  const declaration = route.isDynamic
    ? `const ${federatedComponentName} = ({ routeParams }: ${federatedComponentName}Props) => (`
    : `const ${federatedComponentName} = () => (`;
  const ownerPage = route.isDynamic
    ? `<${componentName} routeParams={routeParams} />`
    : `<${componentName} />`;
  return `import { FederatedI18nBoundary } from '@modern-js/plugin-i18n/runtime';
import { ${resourcesName} } from '../i18n/resources';
import { ${componentName} } from '../routes/[lang]/${route.relativePath}/page';

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
  route: PageRoute,
): string => {
  const loaderImport = route.isDynamic
    ? `{
  loader as loadModuleTarget,
  selectRouteParams,
}`
    : '{ loader as loadModuleTarget }';
  const parameterNames = route.parameterNames.map((name) => `'${name}'`).join(', ');
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

const renderLegacyShellConnectorLoader = (
  vertical: PageVerticalMetadata,
  route: PageRoute,
): string =>
  `import { loader as loadModuleTarget } from '${relativeFromRoute(route, 'modules/[moduleId]/page.data.ts')}';

interface ShellPageLoaderArguments {
  readonly request: Request;
}

export const loader = ({ request }: ShellPageLoaderArguments) =>
  loadModuleTarget({ params: { moduleId: '${vertical.moduleId}' }, request });
`;

const renderShellConnectorMetadata = (
  vertical: PageVerticalMetadata,
  page: string,
  route: PageRoute,
  config: Pick<PageScaffoldConfig, 'authorization' | 'permission'>,
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

const localizedLegacyPageCopy = (locale: string): JsonObject =>
  locale === 'cs'
    ? {
        description: 'Tato stránka je připravena k implementaci.',
        empty: 'Zatím zde není žádný obsah.',
        title: 'Nová stránka',
      }
    : {
        description: 'This page is ready for implementation.',
        empty: 'No content has been added yet.',
        title: 'New Page',
      };

const patchLocale = async (
  workspaceRoot: string,
  vertical: PageVerticalMetadata,
  locale: string,
  page: string,
): Promise<Mutation> => {
  const localePath = resolveContainedPath(
    workspaceRoot,
    'verticals',
    vertical.slug,
    'locales',
    locale,
    `${vertical.namespace}.json`,
  );
  const { content, value } = await readJson(localePath, `${locale} locale catalog`);
  const namespaceValue = value[vertical.namespace];
  const namespace = {
    ...asJsonObject(namespaceValue, `${locale} ${vertical.namespace} namespace`),
  };
  const pagesValue = namespace['pages'];
  const pages: MutableJsonObject =
    pagesValue === undefined ? {} : { ...asJsonObject(pagesValue, `${locale} pages catalog`) };
  const pageKey = toCamelCase(page);
  if (pages[pageKey] !== undefined) {
    throw new Error(
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
    throw new Error(`locale patch unexpectedly made no change for ${locale}`);
  }
  return mutation;
};

const migrateLegacyLocale = async (
  workspaceRoot: string,
  vertical: PageVerticalMetadata,
  locale: string,
  page: string,
): Promise<Mutation> => {
  const localePath = resolveContainedPath(
    workspaceRoot,
    'verticals',
    vertical.slug,
    'locales',
    locale,
    `${vertical.namespace}.json`,
  );
  const { content, value } = await readJson(localePath, `${locale} locale catalog`);
  const namespace = asJsonObject(value[vertical.namespace], `${locale} namespace`);
  const pages = { ...asJsonObject(namespace['pages'], `${locale} pages catalog`) };
  const pageKey = toCamelCase(page);
  if (JSON.stringify(pages[pageKey]) !== JSON.stringify(localizedLegacyPageCopy(locale))) {
    throw new Error(`legacy locale key ${vertical.namespace}.pages.${pageKey} was modified`);
  }
  pages[pageKey] = localizedPageCopy(locale);
  const sortedPages = Object.fromEntries(
    Object.entries(pages).toSorted(([left], [right]) => left.localeCompare(right)),
  );
  const patched = patchJsonObjectProperty(content, [vertical.namespace], 'pages', sortedPages);
  const mutation = updateMutation(localePath, content, patched);
  if (mutation === undefined) {
    throw new Error(`legacy locale migration unexpectedly made no change for ${locale}`);
  }
  return mutation;
};

type GeneratedPageState = 'current' | 'legacy' | 'invalid';

interface OwnedPageRoute {
  readonly owner: string;
  readonly routePath: string;
}

const ownedPageRoutes = async (workspaceRoot: string): Promise<readonly OwnedPageRoute[]> => {
  const verticalRoot = resolveContainedPath(workspaceRoot, 'verticals');
  const verticals = await readdir(verticalRoot, { withFileTypes: true });
  const ownedRoutes = await Promise.all(
    verticals
      .filter((entry) => entry.isDirectory())
      .map(async (entry): Promise<readonly OwnedPageRoute[]> => {
        const manifestPath = resolveContainedPath(verticalRoot, entry.name, 'vertical.manifest.ts');
        if (!(await pathExists(manifestPath))) {
          return [];
        }
        const manifest = await readFile(manifestPath, 'utf-8');
        return readGeneratedSlotEntries(
          manifest,
          MODULE_MANIFEST_SHELL_PAGE_SLOT_START,
          MODULE_MANIFEST_SHELL_PAGE_SLOT_END,
        ).map((candidate) => {
          const matches = [...candidate.matchAll(/\broutePath:\s*'(?<routePath>\/[^']+)'/gu)];
          const routePath = matches[0]?.groups?.['routePath'];
          if (matches.length !== 1 || routePath === undefined) {
            throw new Error(
              `generated owner slot contains unsupported developer content: ${MODULE_MANIFEST_SHELL_PAGE_SLOT_START}`,
            );
          }
          return { owner: entry.name, routePath };
        });
      }),
  );
  return ownedRoutes.flat();
};

const isDynamicShellRouteSegment = (segment: string): boolean =>
  /^\[.+\]$/u.test(segment) || segment.startsWith('$') || segment.startsWith('*');

const routeCollisionIdentity = (routePath: string): string =>
  routePath
    .split('/')
    .map((segment) => (parameterRouteSegmentPattern.test(segment) ? ':parameter' : segment))
    .join('/');

const assertShellRouteIsAvailable = async (
  workspaceRoot: string,
  route: PageRoute,
  registeredRoutes: ReadonlySet<string>,
): Promise<void> => {
  let parent = resolveContainedPath(
    workspaceRoot,
    'apps',
    'shell-super-app',
    'src',
    'routes',
    '[lang]',
  );
  for (const [index, segment] of route.filesystemSegments.entries()) {
    let entries;
    try {
      // eslint-disable-next-line no-await-in-loop -- Each segment depends on the resolved parent.
      entries = await readdir(parent, { withFileTypes: true });
    } catch (error) {
      if (isMissingFileError(error)) {
        return;
      }
      throw error;
    }
    const childEntry = entries.find((entry) => entry.name === segment);
    if (childEntry === undefined) {
      const desiredSegmentIsDynamic = isDynamicShellRouteSegment(segment);
      const siblingCollision = entries.find(
        (entry) =>
          entry.isDirectory() &&
          (desiredSegmentIsDynamic || isDynamicShellRouteSegment(entry.name)),
      );
      if (siblingCollision !== undefined) {
        const collisionKind = isDynamicShellRouteSegment(siblingCollision.name)
          ? 'dynamic'
          : 'static';
        throw new Error(
          `Shell route ${route.canonicalPath} collides with ${collisionKind} route segment ${siblingCollision.name}`,
        );
      }
      return;
    }
    const child = path.join(parent, segment);
    if (index === route.filesystemSegments.length - 1) {
      throw new Error(`Shell route already exists or collides with generated page: ${child}`);
    }
    if (!childEntry.isDirectory()) {
      throw new Error(`Shell route ${route.canonicalPath} collides with reserved route content`);
    }
    const prefix = `/${route.canonicalSegments.slice(0, index + 1).join('/')}`;
    const ownsPrefix = registeredRoutes.has(prefix);
    // eslint-disable-next-line no-await-in-loop -- Reserved-prefix checks follow the route hierarchy.
    const pageRouteExists = await pathExists(path.join(child, 'page.tsx'));
    // eslint-disable-next-line no-await-in-loop -- Reserved-prefix checks follow the route hierarchy.
    const routeMetadataExists = await pathExists(path.join(child, 'route.meta.ts'));
    const prefixIsRoute = pageRouteExists || routeMetadataExists;
    if (prefixIsRoute && !ownsPrefix) {
      throw new Error(`Shell route ${route.canonicalPath} uses reserved route prefix ${prefix}`);
    }
    parent = child;
  }
};

const resolveGeneratedPageContentState = (
  pageContent: string,
  vertical: PageVerticalMetadata,
  page: string,
  route: PageRoute,
): GeneratedPageState => {
  if (pageContent === renderPage(vertical, page, route)) {
    return 'current';
  }
  if (
    pageContent === renderLegacyPage(vertical, page, route) ||
    pageContent === renderFormattedLegacyPage(vertical, page, route)
  ) {
    return 'legacy';
  }
  return 'invalid';
};

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

const generatedWiringMatches = async (
  workspaceRoot: string,
  vertical: PageVerticalMetadata,
  page: string,
  route: PageRoute,
  pageState: Exclude<GeneratedPageState, 'invalid'>,
  config: Pick<PageScaffoldConfig, 'authorization' | 'permission'>,
): Promise<boolean> => {
  const wiring = pageWiring(vertical, page, route, config);
  const federationPath = resolveContainedPath(vertical.directory, 'module-federation.config.ts');
  const federation = await readFile(federationPath, 'utf-8');
  const shellClients = await readFile(
    resolveContainedPath(
      workspaceRoot,
      'apps',
      'shell-super-app',
      'src',
      'api',
      'vertical-clients.ts',
    ),
    'utf-8',
  );
  const shellRouteDirectory = resolveContainedPath(
    workspaceRoot,
    'apps',
    'shell-super-app',
    'src',
    'routes',
    '[lang]',
    ...route.filesystemSegments,
  );
  const expectedShellFiles = [
    ['page.tsx', renderShellConnectorPage(route)],
    [
      'page.data.ts',
      pageState === 'current'
        ? renderShellConnectorLoader(vertical, page, route)
        : renderLegacyShellConnectorLoader(vertical, route),
    ],
    ['route.meta.ts', renderShellConnectorMetadata(vertical, page, route, config)],
  ] as const;
  const shellRouteMatches = await Promise.all(
    expectedShellFiles.map(async ([fileName, expected]) => {
      const filePath = path.join(shellRouteDirectory, fileName);
      return (await pathExists(filePath)) && (await readFile(filePath, 'utf-8')) === expected;
    }),
  );
  const shellRouteEntries = await readdir(shellRouteDirectory, { withFileTypes: true });
  const shellRouteInventoryMatches =
    shellRouteEntries.length === expectedShellFiles.length &&
    shellRouteEntries.every(
      (entry) =>
        entry.isFile() && expectedShellFiles.some(([expectedName]) => expectedName === entry.name),
    );
  const exposureKey = `./Page${toPascalCase(page)}`;
  const expectedExposureSource = `./src/federation/page-${page}.tsx`;
  const exposureSource = moduleFederationExposureSource(federation, exposureKey);
  const federatedPagePath = resolveContainedPath(vertical.directory, expectedExposureSource);
  const federationMatches =
    exposureSource === expectedExposureSource &&
    (await pathExists(federatedPagePath)) &&
    (await readFile(federatedPagePath, 'utf-8')) === renderFederatedPage(vertical, page, route);
  const navigationMatches =
    wiring.manifestNavigation === undefined
      ? readGeneratedSlotEntries(
          vertical.manifestContent,
          MODULE_MANIFEST_SHELL_NAVIGATION_SLOT_START,
          MODULE_MANIFEST_SHELL_NAVIGATION_SLOT_END,
        ).every(
          (entry) =>
            !new RegExp(
              `\\bcontributionKey\\s*:\\s*["']${vertical.moduleId.replaceAll('.', '\\.')}\\.navigation\\.${page}["']`,
              'u',
            ).test(entry),
        )
      : generatedWiringEntryMatches(
          vertical.manifestContent,
          MODULE_MANIFEST_SHELL_NAVIGATION_SLOT_START,
          MODULE_MANIFEST_SHELL_NAVIGATION_SLOT_END,
          wiring.manifestNavigation,
          new RegExp(
            `\\bcontributionKey\\s*:\\s*["']${vertical.moduleId}\\.navigation\\.${page}["']`,
            'u',
          ),
        );
  return (
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
    ) &&
    federationMatches &&
    generatedWiringEntryMatches(
      shellClients,
      SHELL_PAGE_CLIENT_SLOT_START,
      SHELL_PAGE_CLIENT_SLOT_END,
      wiring.shellClient,
      new RegExp(`\\bcomponentKey\\s*:\\s*["']${vertical.moduleId}\\.page-${page}["']`, 'u'),
    ) &&
    shellRouteMatches.every(Boolean) &&
    shellRouteInventoryMatches
  );
};

const generatedPageState = async (
  workspaceRoot: string,
  vertical: PageVerticalMetadata,
  page: string,
  route: PageRoute,
  routeDirectory: string,
  pagePath: string,
  routeMetadataPath: string,
  config: Pick<PageScaffoldConfig, 'authorization' | 'permission'>,
): Promise<GeneratedPageState> => {
  const entries = await readdir(routeDirectory, { withFileTypes: true });
  if (
    entries.length !== 2 ||
    !entries.every((entry) => entry.isFile()) ||
    !entries.some((entry) => entry.name === 'page.tsx') ||
    !entries.some((entry) => entry.name === 'route.meta.ts')
  ) {
    return 'invalid';
  }
  const [pageContent, routeMetadataContent] = await Promise.all([
    readFile(pagePath, 'utf-8'),
    readFile(routeMetadataPath, 'utf-8'),
  ]);
  const expectedMetadata = renderRouteMetadata(vertical, page, route, config);
  if (routeMetadataContent !== expectedMetadata) {
    return 'invalid';
  }
  const pageState = resolveGeneratedPageContentState(pageContent, vertical, page, route);
  if (pageState === 'invalid') {
    return 'invalid';
  }
  const pageKey = toCamelCase(page);
  const localeStates = await Promise.all(
    vertical.locales.map(async (locale) => {
      const localePath = resolveContainedPath(
        workspaceRoot,
        'verticals',
        vertical.slug,
        'locales',
        locale,
        `${vertical.namespace}.json`,
      );
      const { value } = await readJson(localePath, `${locale} locale catalog`);
      const namespace = asJsonObject(value[vertical.namespace], `${locale} namespace`);
      const pages = asJsonObject(namespace['pages'], `${locale} pages catalog`);
      const copy = JSON.stringify(pages[pageKey]);
      if (copy === JSON.stringify(localizedPageCopy(locale))) {
        return 'current' as const;
      }
      if (copy === JSON.stringify(localizedLegacyPageCopy(locale))) {
        return 'legacy' as const;
      }
      return 'invalid' as const;
    }),
  );
  if (!localeStates.every((state) => state === pageState)) {
    return 'invalid';
  }
  return (await generatedWiringMatches(workspaceRoot, vertical, page, route, pageState, config))
    ? pageState
    : 'invalid';
};

export const planPageScaffold = async (
  workspaceRoot: string,
  config: PageScaffoldConfig,
): Promise<ScaffoldPlan<PageScaffoldResult>> => {
  const page = requireCanonicalSlug(config.page, 'page');
  const vertical = await discoverPageVertical(workspaceRoot, config.vertical);
  const route = resolvePageRoute(vertical, page, config.url);
  const routeDirectory = resolveContainedPath(
    workspaceRoot,
    'verticals',
    vertical.slug,
    'src',
    'routes',
    '[lang]',
    ...route.filesystemSegments,
  );
  const pagePath = path.join(routeDirectory, 'page.tsx');
  const routeMetadataPath = path.join(routeDirectory, 'route.meta.ts');
  const shellRouteDirectory = resolveContainedPath(
    workspaceRoot,
    'apps',
    'shell-super-app',
    'src',
    'routes',
    '[lang]',
    ...route.filesystemSegments,
  );
  if (await pathExists(routeDirectory)) {
    const state = await generatedPageState(
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
    if (state === 'legacy') {
      const pageContent = await readFile(pagePath, 'utf-8');
      const shellLoaderPath = path.join(shellRouteDirectory, 'page.data.ts');
      const shellLoaderContent = await readFile(shellLoaderPath, 'utf-8');
      const mutations = [
        updateMutation(pagePath, pageContent, renderPage(vertical, page, route)),
        ...(await Promise.all(
          vertical.locales.map((locale) =>
            migrateLegacyLocale(workspaceRoot, vertical, locale, page),
          ),
        )),
        updateMutation(
          shellLoaderPath,
          shellLoaderContent,
          renderShellConnectorLoader(vertical, page, route),
        ),
      ].filter((mutation) => mutation !== undefined);
      ensureUniqueMutationPaths(mutations);
      return {
        mutations,
        result: { appId: vertical.appId, pagePath, routeMetadataPath },
      };
    }
    throw new Error(`page route already exists or collides with nested content: ${routeDirectory}`);
  }
  const identity = `${vertical.moduleId}.page.${page}`;
  const pageComponentIdentity = new RegExp(`["']page-${page}["']\\s*:`, 'u');
  const pageContributionIdentity = new RegExp(
    `["']${vertical.moduleId.replaceAll('.', '\\.')}\\.page\\.${page}["']`,
    'u',
  );
  if (
    pageComponentIdentity.test(vertical.manifestContent) ||
    pageContributionIdentity.test(vertical.manifestContent)
  ) {
    throw new Error(`page identity ${identity} already exists at another URL`);
  }
  const registeredRoutes = await ownedPageRoutes(workspaceRoot);
  const existingRouteOwner = registeredRoutes.find(
    (registered) =>
      routeCollisionIdentity(registered.routePath) === routeCollisionIdentity(route.canonicalPath),
  );
  if (existingRouteOwner !== undefined) {
    const reason =
      existingRouteOwner.routePath === route.canonicalPath
        ? `is already registered by ${existingRouteOwner.owner}`
        : `has a routing collision with ${existingRouteOwner.routePath} registered by ${existingRouteOwner.owner}`;
    throw new Error(`page URL ${route.canonicalPath} ${reason}`);
  }
  await assertShellRouteIsAvailable(
    workspaceRoot,
    route,
    new Set(registeredRoutes.map((registered) => registered.routePath)),
  );
  const pageMutation = await createMutation(pagePath, renderPage(vertical, page, route));
  const routeMutation = await createMutation(
    routeMetadataPath,
    renderRouteMetadata(vertical, page, route, config),
  );
  const localeMutations = await Promise.all(
    vertical.locales.map((locale) => patchLocale(workspaceRoot, vertical, locale, page)),
  );
  const wiring = patchPageWiring(vertical, page, route, config);
  const manifestMutation = updateMutation(
    vertical.manifestPath,
    vertical.manifestContent,
    wiring.manifest,
  );
  const registrationMutation = updateMutation(
    vertical.registrationPath,
    vertical.registrationContent,
    wiring.registration,
  );
  const federationPath = resolveContainedPath(vertical.directory, 'module-federation.config.ts');
  const federationContent = await readFile(federationPath, 'utf-8');
  const federatedPagePath = resolveContainedPath(
    vertical.directory,
    'src',
    'federation',
    `page-${page}.tsx`,
  );
  const federatedPageMutation = await createMutation(
    federatedPagePath,
    renderFederatedPage(vertical, page, route),
  );
  const federationMutation = updateMutation(
    federationPath,
    federationContent,
    insertModuleFederationExposure(
      federationContent,
      `./Page${toPascalCase(page)}`,
      `./src/federation/page-${page}.tsx`,
    ),
  );
  const shellClientsPath = resolveContainedPath(
    workspaceRoot,
    'apps',
    'shell-super-app',
    'src',
    'api',
    'vertical-clients.ts',
  );
  const shellClientsContent = await readFile(shellClientsPath, 'utf-8');
  const shellClientsMutation = updateMutation(
    shellClientsPath,
    shellClientsContent,
    insertSortedSlot(
      shellClientsContent,
      SHELL_PAGE_CLIENT_SLOT_START,
      SHELL_PAGE_CLIENT_SLOT_END,
      [pageWiring(vertical, page, route, config).shellClient],
      (candidate) => candidate.endsWith(','),
    ),
  );
  const shellPageMutation = await createMutation(
    path.join(shellRouteDirectory, 'page.tsx'),
    renderShellConnectorPage(route),
  );
  const shellLoaderMutation = await createMutation(
    path.join(shellRouteDirectory, 'page.data.ts'),
    renderShellConnectorLoader(vertical, page, route),
  );
  const shellRouteMetadataMutation = await createMutation(
    path.join(shellRouteDirectory, 'route.meta.ts'),
    renderShellConnectorMetadata(vertical, page, route, config),
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
};

export default createCodesmithGenerator(planPageScaffold);
