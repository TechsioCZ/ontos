const fs = require('node:fs/promises');
const path = require('node:path');

const supportedLocales = ['en', 'cs'];

const readText = (workspaceRoot, relativePath) =>
  fs.readFile(path.join(workspaceRoot, relativePath), 'utf8');

const writeText = async (workspaceRoot, relativePath, content, options = {}) => {
  assertWritableSourcePath(relativePath, options);
  const absolutePath = path.join(workspaceRoot, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, content, 'utf8');
};

const readJson = async (workspaceRoot, relativePath) =>
  JSON.parse(await readText(workspaceRoot, relativePath));

const writeJson = (workspaceRoot, relativePath, value) =>
  writeText(workspaceRoot, relativePath, `${JSON.stringify(value, null, 2)}\n`);

const assertWritableSourcePath = (relativePath, { allowGenerated = false } = {}) => {
  const normalised = relativePath.split(path.sep).join('/');
  if (
    normalised.includes('/node_modules/') ||
    normalised.startsWith('node_modules/') ||
    normalised.includes('/@mf-types/')
  ) {
    throw new Error(`Refusing to write dependency or Module Federation type path: ${relativePath}`);
  }

  if (
    !allowGenerated &&
    (normalised.includes('/modern-tanstack/') ||
      normalised.endsWith('.gen.ts') ||
      normalised.endsWith('.gen.d.ts'))
  ) {
    throw new Error(`Refusing to write generated path without explicit opt-in: ${relativePath}`);
  }
};

const normaliseKebab = (value, label) => {
  const kebab = value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();

  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(kebab)) {
    throw new Error(`${label} must resolve to a non-empty kebab-case slug.`);
  }

  return kebab;
};

const toWords = (value) => normaliseKebab(value, 'value').split('-');

const toPascalCase = (value) =>
  toWords(value)
    .map((word) => `${word[0].toUpperCase()}${word.slice(1)}`)
    .join('');

const toCamelCase = (value) => {
  const pascal = toPascalCase(value);
  return `${pascal[0].toLowerCase()}${pascal.slice(1)}`;
};

const toTitleCase = (value) =>
  toWords(value)
    .map((word) => `${word[0].toUpperCase()}${word.slice(1)}`)
    .join(' ');

const normaliseRoutePath = ({ pageSlug, routePath, verticalSlug }) => {
  const rawPath =
    typeof routePath === 'string' && routePath.trim().length > 0
      ? routePath.trim()
      : `/${verticalSlug}/${pageSlug}`;
  const normalised = rawPath.replaceAll(/\/+/g, '/').replace(/\/+$/g, '');
  const withLeadingSlash = normalised.startsWith('/') ? normalised : `/${normalised}`;

  if (withLeadingSlash === '/' || withLeadingSlash.includes('..')) {
    throw new Error(`Invalid route path: ${routePath}`);
  }

  return withLeadingSlash;
};

const relativeImport = (fromFile, targetWithoutExtension) => {
  const relative = path
    .relative(path.dirname(fromFile), targetWithoutExtension)
    .replaceAll(path.sep, '/');
  return relative.startsWith('.') ? relative : `./${relative}`;
};

const createVerticalPageExperienceModule = ({
  componentName,
  localeKey,
  verticalSlug,
}) => `import { useModernI18n } from '@modern-js/plugin-i18n/runtime';

export default function ${componentName}() {
  const { t } = useModernI18n();

  return (
    <section
      className="${verticalSlug}:rounded-2xl ${verticalSlug}:bg-white/90 ${verticalSlug}:p-5 ${verticalSlug}:shadow-xl ${verticalSlug}:shadow-stone-900/10"
    >
      <p className="${verticalSlug}:text-sm ${verticalSlug}:font-bold ${verticalSlug}:uppercase ${verticalSlug}:tracking-normal ${verticalSlug}:text-stone-500">
        {t('${verticalSlug}.pages.${localeKey}.eyebrow')}
      </p>
      <h2 className="${verticalSlug}:mt-2 ${verticalSlug}:text-2xl ${verticalSlug}:font-black">
        {t('${verticalSlug}.pages.${localeKey}.title')}
      </h2>
      <p className="${verticalSlug}:mt-2 ${verticalSlug}:text-stone-600">
        {t('${verticalSlug}.pages.${localeKey}.body')}
      </p>
    </section>
  );
}
`;

const createVerticalPageModule = ({
  componentName,
  experienceComponentName,
  experiencePath,
  exposeKey,
  fromFile,
  mfBoundaryId,
}) => `import ${experienceComponentName} from '${relativeImport(fromFile, experiencePath)}';

export default function ${componentName}() {
  return (
    <div data-modern-boundary-id="${mfBoundaryId}" data-modern-mf-expose="${exposeKey}">
      <${experienceComponentName} />
    </div>
  );
}
`;

const createShellRoutePage = ({
  componentName,
  entrypointKey,
  fromFile,
  moduleEntrypointsPath,
  protectedRemotePagePath,
  shellFramePath,
  title,
}) => `import { ProtectedShellRemotePage } from '${relativeImport(fromFile, protectedRemotePagePath)}';
import { shellModuleEntrypoints } from '${relativeImport(fromFile, moduleEntrypointsPath)}';
import ShellFrame from '${relativeImport(fromFile, shellFramePath)}';

const entrypoint = shellModuleEntrypoints.${entrypointKey};

export default function ${componentName}ShellPage() {
  return (
    <ShellFrame>
      <section className="shell:mx-auto shell:mt-8 shell:max-w-7xl">
        <ProtectedShellRemotePage entrypoint={entrypoint} loadingLabel={${JSON.stringify(title)}} />
      </section>
    </ShellFrame>
  );
}
`;

const createRouteMeta = ({
  descriptionKey,
  id,
  mfBoundaryId,
  routePath,
  titleKey,
  verticalSlug,
}) => `const routeMeta = {
  canonicalPath: '${routePath}',
  descriptionKey: '${descriptionKey}',
  id: '${id}',
  indexable: false,
  localisedPaths: {
    cs: '${routePath}',
    en: '${routePath}',
  },
  mfBoundaryId: '${mfBoundaryId}',
  namespace: '${verticalSlug}',
  ownerAppId: '${verticalSlug}',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: '${titleKey}',
} as const;

export default routeMeta;
export { routeMeta };
`;

const upsertJsonPath = (target, keys, value) => {
  let cursor = target;
  for (const key of keys.slice(0, -1)) {
    const current = cursor[key];
    if (current === undefined) {
      cursor[key] = {};
    } else if (typeof current !== 'object' || current === null || Array.isArray(current)) {
      throw new Error(`Cannot create locale key through non-object segment "${key}".`);
    }
    cursor = cursor[key];
  }
  cursor[keys[keys.length - 1]] = value;
};

const updateLocaleFile = async ({
  body,
  description,
  eyebrow,
  localeKey,
  relativePath,
  title,
  verticalSlug,
  workspaceRoot,
}) => {
  const locale = await readJson(workspaceRoot, relativePath);
  upsertJsonPath(locale, [verticalSlug, 'pages', localeKey], {
    body,
    eyebrow,
    seo: {
      description,
    },
    title,
  });
  await writeJson(workspaceRoot, relativePath, locale);
};

const updateModuleFederationExposes = async ({
  exposeKey,
  exposePath,
  relativePath,
  workspaceRoot,
}) => {
  const source = await readText(workspaceRoot, relativePath);
  if (
    source.includes(`${JSON.stringify(exposeKey).slice(1, -1)}':`) ||
    source.includes(`"${exposeKey}":`)
  ) {
    return;
  }

  const match = source.match(/(exposes:\s*\{\n)([\s\S]*?)(\n\s*\},\n\s*filename:)/);
  if (match === null) {
    throw new Error(`Could not find exposes object in ${relativePath}.`);
  }

  const entry = `      '${exposeKey}': '${exposePath}',\n`;
  await writeText(
    workspaceRoot,
    relativePath,
    source.replace(match[0], `${match[1]}${match[2]}${entry}${match[3]}`),
  );
};

const updateShellEntrypoints = async ({
  entrypointId,
  entrypointKey,
  moduleKey,
  relativePath,
  remoteSpecifier,
  workspaceRoot,
}) => {
  const source = await readText(workspaceRoot, relativePath);
  if (source.includes(`${entrypointKey}:`)) {
    return;
  }

  const closing = '\n} as const satisfies Record<string, ShellModuleEntrypoint>;';
  if (!source.includes(closing)) {
    throw new Error(`Could not find shellModuleEntrypoints closing marker in ${relativePath}.`);
  }

  const entry = `  ${entrypointKey}: {
    accessKind: 'load',
    id: '${entrypointId}',
    kind: 'page',
    moduleKey: '${moduleKey}',
    remoteSpecifier: '${remoteSpecifier}',
  },
`;
  const objectStart = source.indexOf('export const shellModuleEntrypoints = {');
  const objectEnd = source.indexOf(closing);
  if (objectStart === -1 || objectEnd === -1) {
    throw new Error(`Could not find shellModuleEntrypoints object in ${relativePath}.`);
  }

  const beforeObject = source.slice(0, objectStart);
  const objectSource = source.slice(objectStart, objectEnd);
  const afterObject = source.slice(objectEnd);
  const keyMatches = [...objectSource.matchAll(/\n  ([a-zA-Z_$][\w$]*):\s*\{/g)];
  const nextKey = keyMatches.map((match) => match[1]).find((key) => key > entrypointKey);

  if (nextKey === undefined) {
    await writeText(workspaceRoot, relativePath, source.replace(closing, `\n${entry}${closing}`));
    return;
  }

  const insertIndex = objectStart + objectSource.indexOf(`\n  ${nextKey}: {`) + 1;
  await writeText(
    workspaceRoot,
    relativePath,
    `${source.slice(0, insertIndex)}${entry}${source.slice(insertIndex)}`,
  );
};

const createGeneratedRouteName = (routePath) =>
  `route__lang_${routePath
    .split('/')
    .filter(Boolean)
    .map((segment) => segment.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, ''))
    .filter(Boolean)
    .join('_')}_page`;

const updateShellGeneratedRouter = async ({ routePath, routePagePath, workspaceRoot }) => {
  const relativePath = 'apps/shell-super-app/src/modern-tanstack/index/router.gen.ts';
  const source = await readText(workspaceRoot, relativePath);
  const generatedPath = `$lang${routePath}`;

  if (source.includes(`path: "${generatedPath}"`)) {
    return;
  }

  const componentIndexes = [...source.matchAll(/import component_(\d+) from/g)].map((match) =>
    Number(match[1]),
  );
  const nextComponentIndex = Math.max(...componentIndexes) + 1;
  const importPath = relativeImport(relativePath, routePagePath.replace(/\.tsx$/u, ''));
  const routeName = createGeneratedRouteName(routePath);
  const modernRouteId = `(lang)${routePath}/page`;
  const importLine = `import component_${nextComponentIndex} from "${importPath}";\n`;
  const routeBlock = `const ${routeName} = createRoute({
  getParentRoute: () => rootRoute,
  component: component_${nextComponentIndex},
  path: "${generatedPath}",
  staticData: createRouteStaticData({
    modernRouteId: "${modernRouteId}",
  }),
});

`;

  let nextSource = source.replace(
    /(import component_\d+ from "[^"]+";\n)(\nexport const rootRoute)/,
    `$1${importLine}$2`,
  );
  nextSource = nextSource.replace(
    /(export const routeTree = rootRoute\.addChildren\(\[)([^\]]*)(\]\);)/,
    (_, prefix, children, suffix) => {
      const trimmedChildren = String(children).trim();
      const nextChildren =
        trimmedChildren.length > 0 ? `${trimmedChildren}, ${routeName}` : routeName;
      return `${routeBlock}${prefix}${nextChildren}${suffix}`;
    },
  );

  if (nextSource === source) {
    throw new Error(`Could not update generated router in ${relativePath}.`);
  }

  await writeText(workspaceRoot, relativePath, nextSource, { allowGenerated: true });
};

const updateShellGeneratedRegister = async ({ routePath, workspaceRoot }) => {
  const relativePath = 'apps/shell-super-app/src/modern-tanstack/register.gen.d.ts';
  const source = await readText(workspaceRoot, relativePath);
  if (source.includes(`'${routePath}': Record<string, never>;`)) {
    return;
  }

  const marker = '  }\n}';
  const entry = `    '${routePath}': Record<string, never>;\n`;
  const lastMarkerIndex = source.lastIndexOf(marker);
  if (lastMarkerIndex === -1) {
    throw new Error(`Could not find canonical route declaration block in ${relativePath}.`);
  }

  const nextSource = `${source.slice(0, lastMarkerIndex)}${entry}${source.slice(lastMarkerIndex)}`;
  await writeText(workspaceRoot, relativePath, nextSource, { allowGenerated: true });
};

const updatePackageExports = async ({ exportKey, exportPath, relativePath, workspaceRoot }) => {
  const packageJson = await readJson(workspaceRoot, relativePath);
  if (typeof packageJson.exports !== 'object' || packageJson.exports === null) {
    packageJson.exports = {};
  }
  packageJson.exports[exportKey] = exportPath;
  await writeJson(workspaceRoot, relativePath, packageJson);
};

const assertVerticalIsInstalledModule = async ({ verticalSlug, workspaceRoot }) => {
  const moduleState = await readText(
    workspaceRoot,
    'packages/shared-contracts/src/module-state.ts',
  );
  const match = moduleState.match(/installedModuleKeys\s*=\s*\[([\s\S]*?)\]\s*as const/);
  if (match === null || !match[1].includes(`'${verticalSlug}'`)) {
    throw new Error(
      `Module "${verticalSlug}" is not listed in packages/shared-contracts/src/module-state.ts. Add the module before generating gated pages.`,
    );
  }
};

const readVerticalMfBoundaryId = async ({ verticalSlug, workspaceRoot }) => {
  const source = await readText(
    workspaceRoot,
    `verticals/${verticalSlug}/module-federation.config.ts`,
  );
  const match = source.match(/name:\s*['"]([^'"]+)['"]/);
  return match?.[1] ?? `vertical${toPascalCase(verticalSlug)}`;
};

module.exports = async function microverticalPageGenerator(context, generator) {
  const workspaceRoot = context.materials.default.basePath;
  const config = context.config;
  const verticalSlug = normaliseKebab(String(config.vertical ?? ''), 'vertical');
  const pageSlug = normaliseKebab(String(config.page ?? ''), 'page');
  const routePath = normaliseRoutePath({
    pageSlug,
    routePath: typeof config.routePath === 'string' ? config.routePath : undefined,
    verticalSlug,
  });

  await fs.access(path.join(workspaceRoot, `verticals/${verticalSlug}/package.json`));
  await assertVerticalIsInstalledModule({ verticalSlug, workspaceRoot });

  const pagePascal = toPascalCase(pageSlug);
  const verticalPascal = toPascalCase(verticalSlug);
  const localeKey = toCamelCase(pageSlug);
  const componentName = `${verticalPascal}${pagePascal}Page`;
  const experienceComponentName = `${verticalPascal}${pagePascal}Experience`;
  const entrypointKey = `${toCamelCase(verticalSlug)}${pagePascal}Page`;
  const entrypointId = `${verticalSlug}.pages.${pageSlug}`;
  const exposeKey = `./pages/${pagePascal}Page`;
  const exposePath = `./src/pages/${pageSlug}-page.tsx`;
  const remoteSpecifier = `${verticalSlug}/pages/${pagePascal}Page`;
  const exportKey = `./pages/${pageSlug}`;
  const title =
    typeof config.title === 'string' ? config.title : `${verticalPascal} ${toTitleCase(pageSlug)}`;
  const description =
    typeof config.description === 'string'
      ? config.description
      : `${title} page owned by the ${verticalSlug} microvertical.`;
  const csTitle = typeof config.csTitle === 'string' ? config.csTitle : title;
  const csDescription =
    typeof config.csDescription === 'string' ? config.csDescription : description;
  const mfBoundaryId = await readVerticalMfBoundaryId({ verticalSlug, workspaceRoot });

  const verticalPagePath = `verticals/${verticalSlug}/src/pages/${pageSlug}-page.tsx`;
  const verticalPageExperiencePath = `verticals/${verticalSlug}/src/pages/${pageSlug}-experience.tsx`;
  const shellRouteSegments = routePath.split('/').filter(Boolean);
  const shellRoutePagePath = path.join(
    'apps/shell-super-app/src/routes/[lang]',
    ...shellRouteSegments,
    'page.tsx',
  );
  const shellRouteMetaPath = path.join(
    'apps/shell-super-app/src/routes/[lang]',
    ...shellRouteSegments,
    'route.meta.ts',
  );

  await writeText(
    workspaceRoot,
    verticalPageExperiencePath,
    createVerticalPageExperienceModule({
      componentName: experienceComponentName,
      localeKey,
      verticalSlug,
    }),
  );
  await writeText(
    workspaceRoot,
    verticalPagePath,
    createVerticalPageModule({
      componentName,
      experienceComponentName,
      experiencePath: verticalPageExperiencePath.replace(/\.tsx$/u, ''),
      exposeKey,
      fromFile: verticalPagePath,
      mfBoundaryId,
    }),
  );

  await updateModuleFederationExposes({
    exposeKey,
    exposePath,
    relativePath: `verticals/${verticalSlug}/module-federation.config.ts`,
    workspaceRoot,
  });
  await updatePackageExports({
    exportKey,
    exportPath: exposePath,
    relativePath: `verticals/${verticalSlug}/package.json`,
    workspaceRoot,
  });
  await updateShellEntrypoints({
    entrypointId,
    entrypointKey,
    moduleKey: verticalSlug,
    relativePath: 'apps/shell-super-app/src/module-entrypoints.ts',
    remoteSpecifier,
    workspaceRoot,
  });

  const shellRoutePagePathForImports = shellRoutePagePath.split(path.sep).join('/');
  await writeText(
    workspaceRoot,
    shellRoutePagePath,
    createShellRoutePage({
      componentName,
      entrypointKey,
      fromFile: shellRoutePagePathForImports,
      moduleEntrypointsPath: 'apps/shell-super-app/src/module-entrypoints',
      protectedRemotePagePath: 'apps/shell-super-app/src/routes/protected-remote-page',
      shellFramePath: 'apps/shell-super-app/src/routes/shell-frame',
      title,
    }),
  );
  await writeText(
    workspaceRoot,
    shellRouteMetaPath,
    createRouteMeta({
      descriptionKey: `${verticalSlug}.pages.${localeKey}.seo.description`,
      id: `${verticalSlug}-${pageSlug}`,
      mfBoundaryId,
      routePath,
      titleKey: `${verticalSlug}.pages.${localeKey}.title`,
      verticalSlug,
    }),
  );
  await updateShellGeneratedRouter({
    routePath,
    routePagePath: shellRoutePagePathForImports,
    workspaceRoot,
  });
  await updateShellGeneratedRegister({
    routePath,
    workspaceRoot,
  });

  for (const locale of supportedLocales) {
    const localeTitle = locale === 'cs' ? csTitle : title;
    const localeDescription = locale === 'cs' ? csDescription : description;
    const values = {
      body: localeDescription,
      description: localeDescription,
      eyebrow: toTitleCase(verticalSlug),
      localeKey,
      title: localeTitle,
      verticalSlug,
      workspaceRoot,
    };
    await updateLocaleFile({
      ...values,
      relativePath: `verticals/${verticalSlug}/locales/${locale}/${verticalSlug}.json`,
    });
    await updateLocaleFile({
      ...values,
      relativePath: `verticals/${verticalSlug}/locales/${locale}/translation.json`,
    });
    await updateLocaleFile({
      ...values,
      relativePath: `apps/shell-super-app/locales/${locale}/shell.json`,
    });
    await updateLocaleFile({
      ...values,
      relativePath: `apps/shell-super-app/locales/${locale}/translation.json`,
    });
  }

  generator.logger.info(`Generated gated ${verticalSlug} page at ${routePath}.`);
};
