const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const readText = (workspaceRoot, relativePath) =>
  fs.readFile(path.join(workspaceRoot, relativePath), 'utf-8');

const pathExists = async (absolutePath) => {
  try {
    await fs.access(absolutePath);
    return true;
  } catch {
    return false;
  }
};

const writeText = async (workspaceRoot, relativePath, content) => {
  assertWritableSourcePath(relativePath);
  const absolutePath = path.join(workspaceRoot, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, content, 'utf-8');
};

const formatFiles = (workspaceRoot, relativePaths) => {
  const oxfmtBin = path.join(
    workspaceRoot,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'oxfmt.cmd' : 'oxfmt',
  );
  const result = spawnSync(oxfmtBin, relativePaths, {
    cwd: workspaceRoot,
    encoding: 'utf-8',
  });

  if (result.error !== undefined) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'oxfmt failed for generated policy files.');
  }
};

const assertWritableSourcePath = (relativePath) => {
  const normalised = relativePath.split(path.sep).join('/');
  if (
    normalised.includes('/node_modules/') ||
    normalised.startsWith('node_modules/') ||
    normalised.includes('/dist/') ||
    normalised.includes('/@mf-types/')
  ) {
    throw new Error(`Refusing to write generated/dependency path: ${relativePath}`);
  }
};

const normaliseKebab = (value, label) => {
  const kebab = value
    .trim()
    .replaceAll(/(?<lower>[a-z0-9])(?<upper>[A-Z])/gu, '$<lower>-$<upper>')
    .replaceAll(/[^a-zA-Z0-9]+/gu, '-')
    .replaceAll(/^-+|-+$/gu, '')
    .toLowerCase();

  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(kebab)) {
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

const assertScope = (scope) => {
  if (scope !== 'global' && scope !== 'microvertical') {
    throw new Error('scope must be one of: global, microvertical.');
  }
};

const assertNoDuplicate = async ({ duplicateMessage, workspaceRoot, relativePath }) => {
  if (await pathExists(path.join(workspaceRoot, relativePath))) {
    throw new Error(`${duplicateMessage}: ${relativePath}`);
  }
};

const createGlobalPolicySource = ({
  policyCamel,
  policyKey,
}) => `// @effect-diagnostics asyncFunction:off
import { allowPolicy } from '../policy.ts';
import type { PolicyCheck } from '../policy.ts';

export interface TInput {}

export const ${policyCamel}: PolicyCheck<TInput> = async () =>
  allowPolicy({
    policyKey: '${policyKey}',
    reason: 'Policy placeholder allows by default until implemented.',
  });
`;

const createMicroverticalPolicySource = ({
  policyCamel,
  policyKey,
}) => `// @effect-diagnostics asyncFunction:off
import { allowPolicy } from '@app/core-runtime';
import type { PolicyCheck } from '@app/core-runtime';

export interface TInput {}

export const ${policyCamel}: PolicyCheck<TInput> = async () =>
  allowPolicy({
    policyKey: '${policyKey}',
    reason: 'Policy placeholder allows by default until implemented.',
  });
`;

const createPolicyIndex = ({
  importPath,
  namespace,
  policyCamel,
}) => `import { ${policyCamel} } from '${importPath}';

export const ${namespace} = {
  ${policyCamel},
} as const;
`;

const createEmptyIndexSource = ({ importPath, namespace, policyCamel }) =>
  createPolicyIndex({
    importPath,
    namespace,
    policyCamel,
  });

const preparePolicyIndex = async ({
  importPath,
  namespace,
  policyCamel,
  relativePath,
  workspaceRoot,
}) => {
  if (!(await pathExists(path.join(workspaceRoot, relativePath)))) {
    return createEmptyIndexSource({
      importPath,
      namespace,
      policyCamel,
    });
  }

  const source = await readText(workspaceRoot, relativePath);
  if (source.includes(policyCamel)) {
    throw new Error(`Policy export already exists in ${relativePath}: ${policyCamel}`);
  }

  const importLine = `import { ${policyCamel} } from '${importPath}';\n`;
  if (source.trim() === `export const ${namespace} = {} as const;`) {
    return `${importLine}\nexport const ${namespace} = {\n  ${policyCamel},\n} as const;\n`;
  }

  if (!new RegExp(`export\\s+const\\s+${namespace}\\s*=\\s*\\{`, 'u').test(source)) {
    throw new Error(`Could not safely update ${relativePath}.`);
  }

  const withImport = source.startsWith(importLine) ? source : `${importLine}${source}`;
  const withPolicy = withImport.replace(
    new RegExp(`(export\\s+const\\s+${namespace}\\s*=\\s*\\{\\n)`, 'u'),
    `$1  ${policyCamel},\n`,
  );
  if (withPolicy === withImport) {
    throw new Error(`Could not safely update ${relativePath}.`);
  }

  return withPolicy;
};

const generateGlobalPolicy = async ({ policyCamel, policyFile, workspaceRoot }) => {
  const policyPath = `packages/core-runtime/src/policies/${policyFile}.ts`;
  const indexPath = 'packages/core-runtime/src/policies/index.ts';
  await assertNoDuplicate({
    duplicateMessage: 'Global policy already exists',
    relativePath: policyPath,
    workspaceRoot,
  });
  const nextIndexSource = await preparePolicyIndex({
    importPath: `./${policyFile}.ts`,
    namespace: 'corePolicies',
    policyCamel,
    relativePath: indexPath,
    workspaceRoot,
  });

  await writeText(
    workspaceRoot,
    policyPath,
    createGlobalPolicySource({
      policyCamel,
      policyKey: `core.${policyCamel}`,
    }),
  );
  await writeText(workspaceRoot, indexPath, nextIndexSource);

  return [policyPath, indexPath];
};

const generateMicroverticalPolicy = async ({
  policyCamel,
  policyFile,
  verticalSlug,
  workspaceRoot,
}) => {
  if (verticalSlug === undefined) {
    throw new Error('vertical is required for microvertical policy generation.');
  }

  const verticalPackage = `verticals/${verticalSlug}/package.json`;
  if (!(await pathExists(path.join(workspaceRoot, verticalPackage)))) {
    throw new Error(`Microvertical does not exist: ${verticalSlug}`);
  }

  const policyPath = `verticals/${verticalSlug}/src/policies/${policyFile}.ts`;
  const indexPath = `verticals/${verticalSlug}/src/policies/index.ts`;
  await assertNoDuplicate({
    duplicateMessage: 'Microvertical policy already exists',
    relativePath: policyPath,
    workspaceRoot,
  });
  const nextIndexSource = await preparePolicyIndex({
    importPath: `./${policyFile}`,
    namespace: `${toCamelCase(verticalSlug)}Policies`,
    policyCamel,
    relativePath: indexPath,
    workspaceRoot,
  });

  await writeText(
    workspaceRoot,
    policyPath,
    createMicroverticalPolicySource({
      policyCamel,
      policyKey: `${verticalSlug}.${policyCamel}`,
    }),
  );
  await writeText(workspaceRoot, indexPath, nextIndexSource);

  return [policyPath, indexPath];
};

module.exports = async function policyGenerator(context, generator) {
  const workspaceRoot = context.materials.default.basePath;
  const { config } = context;
  const scope = String(config.scope ?? '').trim();
  assertScope(scope);

  const policySlug = normaliseKebab(String(config.policy ?? ''), 'policy');
  const policyCamel = toCamelCase(policySlug);
  const verticalSlug =
    typeof config.vertical === 'string' && config.vertical.trim().length > 0
      ? normaliseKebab(config.vertical, 'vertical')
      : undefined;

  if (scope === 'global' && verticalSlug !== undefined) {
    throw new Error('vertical is only supported for microvertical policy generation.');
  }

  const generatedFiles =
    scope === 'global'
      ? await generateGlobalPolicy({
          policyCamel,
          policyFile: policySlug,
          workspaceRoot,
        })
      : await generateMicroverticalPolicy({
          policyCamel,
          policyFile: policySlug,
          verticalSlug,
          workspaceRoot,
        });

  formatFiles(workspaceRoot, generatedFiles);

  generator.logger.info(
    scope === 'global'
      ? `Generated global policy ${policyCamel}.`
      : `Generated microvertical policy ${verticalSlug}.${policyCamel}.`,
  );
};
