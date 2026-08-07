import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createCodesmithGenerator } from '../generator-adapter.mts';
import { tailwindPrefixForNamespace } from '../tailwind-prefix.mts';
import {
  asJsonObject,
  createMutation,
  discoverOntosModule,
  ensureUniqueMutationPaths,
  isMissingFileError,
  patchJsonObjectProperty,
  pathExists,
  readJson,
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

const namespacePattern = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u;
const moduleFederationNamePattern = /^[A-Za-z][A-Za-z0-9]*$/u;
const localePattern = /^[a-z]{2}(?:-[A-Z]{2})?$/u;
const pageStarterLocales = new Set(['cs', 'en']);

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
  return {
    ...vertical,
    locales,
    mfBoundaryId,
    namespace,
    tailwindPrefix: tailwindPrefixForNamespace(namespace),
  };
};

const renderPage = (vertical: PageVerticalMetadata, page: string): string => {
  const componentName = `${toPascalCase(page)}Page`;
  const keyRoot = `${vertical.namespace}.pages.${toCamelCase(page)}`;
  const prefix = vertical.tailwindPrefix;
  return `import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { UltramodernRouteHead } from '../../ultramodern-route-head';

export default function ${componentName}() {
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
}
`;
};

const renderRouteMetadata = (vertical: PageVerticalMetadata, page: string): string => {
  const keyRoot = `${vertical.namespace}.pages.${toCamelCase(page)}`;
  const localisedPaths = vertical.locales.map((locale) => `    ${locale}: '/${page}',`).join('\n');
  return `import { defineTenantModuleEntrypoint } from '@app/core-runtime';

const routeMeta = {
  canonicalPath: '/${page}',
  descriptionKey: '${keyRoot}.description',
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
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
      empty: 'Zatím zde není žádný obsah.',
      title: 'Nová stránka',
    };
  }
  return {
    description: 'This page is ready for implementation.',
    empty: 'No content has been added yet.',
    title: 'New Page',
  };
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

const isExactGeneratedPage = async (
  workspaceRoot: string,
  vertical: PageVerticalMetadata,
  page: string,
  routeDirectory: string,
  pagePath: string,
  routeMetadataPath: string,
): Promise<boolean> => {
  const entries = await readdir(routeDirectory, { withFileTypes: true });
  if (
    entries.length !== 2 ||
    !entries.every((entry) => entry.isFile()) ||
    !entries.some((entry) => entry.name === 'page.tsx') ||
    !entries.some((entry) => entry.name === 'route.meta.ts')
  ) {
    return false;
  }
  const [pageContent, routeMetadataContent] = await Promise.all([
    readFile(pagePath, 'utf-8'),
    readFile(routeMetadataPath, 'utf-8'),
  ]);
  if (
    pageContent !== renderPage(vertical, page) ||
    routeMetadataContent !== renderRouteMetadata(vertical, page)
  ) {
    return false;
  }
  const pageKey = toCamelCase(page);
  const localeMatches = await Promise.all(
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
      return JSON.stringify(pages[pageKey]) === JSON.stringify(localizedPageCopy(locale));
    }),
  );
  return localeMatches.every(Boolean);
};

export const planPageScaffold = async (
  workspaceRoot: string,
  config: PageScaffoldConfig,
): Promise<ScaffoldPlan<PageScaffoldResult>> => {
  const page = requireCanonicalSlug(config.page, 'page');
  const vertical = await discoverPageVertical(workspaceRoot, config.vertical);
  const routeDirectory = resolveContainedPath(
    workspaceRoot,
    'verticals',
    vertical.slug,
    'src',
    'routes',
    '[lang]',
    page,
  );
  const pagePath = path.join(routeDirectory, 'page.tsx');
  const routeMetadataPath = path.join(routeDirectory, 'route.meta.ts');
  if (await pathExists(routeDirectory)) {
    if (
      await isExactGeneratedPage(
        workspaceRoot,
        vertical,
        page,
        routeDirectory,
        pagePath,
        routeMetadataPath,
      )
    ) {
      return {
        mutations: [],
        result: { appId: vertical.appId, pagePath, routeMetadataPath },
      };
    }
    throw new Error(`page route already exists or collides with nested content: ${routeDirectory}`);
  }
  const pageMutation = await createMutation(pagePath, renderPage(vertical, page));
  const routeMutation = await createMutation(
    routeMetadataPath,
    renderRouteMetadata(vertical, page),
  );
  const localeMutations = await Promise.all(
    vertical.locales.map((locale) => patchLocale(workspaceRoot, vertical, locale, page)),
  );
  const mutations = [pageMutation, routeMutation, ...localeMutations];
  ensureUniqueMutationPaths(mutations);
  return {
    mutations,
    result: { appId: vertical.appId, pagePath, routeMetadataPath },
  };
};

export default createCodesmithGenerator(planPageScaffold);
