#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

interface Vertical {
  readonly packageName?: string;
  readonly path: string;
  readonly slug: string;
}

const workspaceRoot = process.env.ULTRAMODERN_WORKSPACE_ROOT ?? process.cwd();
const failures: string[] = [];
const ignoredDirectories = new Set([
  '.git',
  '.modern',
  '.output',
  'coverage',
  'dist',
  'node_modules',
  'repos',
]);

const sourceFilePattern = /\.(?:[cm]?[jt]sx?)$/u;

const normalize = (filePath: string) => filePath.split(path.sep).join('/');

const relative = (filePath: string) => normalize(path.relative(workspaceRoot, filePath));

const absolute = (relativePath: string) => path.join(workspaceRoot, relativePath);

const exists = (relativePath: string) => fs.existsSync(absolute(relativePath));

const readText = (relativePath: string) => fs.readFileSync(absolute(relativePath), 'utf-8');

const fail = (message: string) => {
  failures.push(message);
};

const assert = (condition: boolean, message: string) => {
  if (!condition) {
    fail(message);
  }
};

const listDirectories = (startDirectory: string) => {
  const absoluteStart = absolute(startDirectory);
  if (!fs.existsSync(absoluteStart)) {
    return [];
  }

  return fs
    .readdirSync(absoluteStart, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !ignoredDirectories.has(entry.name))
    .map((entry) => path.posix.join(startDirectory, entry.name));
};

const listFiles = (startDirectory: string) => {
  const absoluteStart = absolute(startDirectory);
  if (!fs.existsSync(absoluteStart)) {
    return [];
  }

  const files: string[] = [];
  const visit = (directory: string) => {
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

const readPackageName = (verticalPath: string) => {
  const packageJsonPath = `${verticalPath}/package.json`;
  if (!exists(packageJsonPath)) {
    return;
  }

  const packageJson = JSON.parse(readText(packageJsonPath)) as { readonly name?: unknown };
  return typeof packageJson.name === 'string' ? packageJson.name : undefined;
};

const verticals: readonly Vertical[] = listDirectories('verticals')
  .filter((verticalPath) => exists(`${verticalPath}/src`))
  .map((verticalPath) => ({
    packageName: readPackageName(verticalPath),
    path: verticalPath,
    slug: path.posix.basename(verticalPath),
  }));

const importSpecifierPattern =
  /(?:\bimport\s+(?:type\s+)?(?:[^'"]*?\s+from\s*)?|\bexport\s+(?:type\s+)?(?:[^'"]*?\s+from\s*)?|\bimport\s*\(\s*)['"](?<specifier>[^'"]+)['"]/gu;

const collectImportSpecifiers = (source: string) =>
  [...source.matchAll(importSpecifierPattern)]
    .map((match) => match.groups?.specifier)
    .filter((specifier): specifier is string => specifier !== undefined);

const isWithinOtherVerticalPolicies = ({
  currentVertical,
  importer,
  specifier,
}: {
  readonly currentVertical: Vertical;
  readonly importer: string;
  readonly specifier: string;
}) => {
  const resolvedSpecifier = specifier.startsWith('.')
    ? path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier))
    : path.posix.normalize(specifier);

  return verticals.some((candidate) => {
    if (candidate.slug === currentVertical.slug) {
      return false;
    }

    const policySourcePath = `${candidate.path}/src/policies`;
    if (
      resolvedSpecifier === policySourcePath ||
      resolvedSpecifier.startsWith(`${policySourcePath}/`)
    ) {
      return true;
    }

    if (candidate.packageName === undefined || !specifier.startsWith(candidate.packageName)) {
      return false;
    }

    const packageSubpath = specifier.slice(candidate.packageName.length);
    return (
      packageSubpath === '/policies' ||
      packageSubpath.startsWith('/policies/') ||
      packageSubpath === '/src/policies' ||
      packageSubpath.startsWith('/src/policies/')
    );
  });
};

for (const currentVertical of verticals) {
  const sourceFiles = listFiles(`${currentVertical.path}/src`).filter((file) =>
    sourceFilePattern.test(file),
  );

  for (const sourceFile of sourceFiles) {
    const importSpecifiers = collectImportSpecifiers(readText(sourceFile));
    for (const specifier of importSpecifiers) {
      if (
        isWithinOtherVerticalPolicies({
          currentVertical,
          importer: sourceFile,
          specifier,
        })
      ) {
        fail(
          `${sourceFile}: must not import another microvertical's policies (${specifier}); use @app/core-runtime policies or ${currentVertical.slug} local policies instead.`,
        );
      }
    }
  }
}

if (exists('package.json')) {
  const rootPackageJson = JSON.parse(readText('package.json')) as {
    readonly scripts?: Record<string, string>;
  };
  assert(
    rootPackageJson.scripts?.['policy:boundaries'] === 'node ./scripts/check-policy-boundaries.mts',
    'Root package.json must expose policy:boundaries.',
  );
  assert(
    rootPackageJson.scripts?.check?.includes('pnpm policy:boundaries') === true,
    'Root check script must include pnpm policy:boundaries.',
  );
}

if (failures.length > 0) {
  console.error('Policy boundary check failed:');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log('Policy boundary check passed.');
