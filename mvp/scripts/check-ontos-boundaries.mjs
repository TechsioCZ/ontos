#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const sourceRoots = ['apps', 'verticals', 'packages'];
const sourceExtensions = new Set(['.js', '.jsx', '.mjs', '.ts', '.tsx']);
const verticalPackageByFolder = new Map([
  ['property-registry', '@mvp/property-registry'],
  ['accounting-core', '@mvp/accounting-core'],
]);

const failures = [];

const addFailure = (filePath, message) => {
  failures.push(`${path.relative(root, filePath)}: ${message}`);
};

const walk = (directory) => {
  if (!fs.existsSync(directory)) {
    return [];
  }

  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === 'node_modules' ? [] : walk(entryPath);
    }
    return sourceExtensions.has(path.extname(entry.name)) ? [entryPath] : [];
  });
};

const importSpecifiers = (source) =>
  [
    ...source.matchAll(/\bimport\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/gu),
    ...source.matchAll(/\bexport\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/gu),
  ].map((match) => match[1]);

const verticalForPath = (filePath) => {
  const relativePath = path.relative(root, filePath);
  const [rootFolder, verticalFolder] = relativePath.split(path.sep);
  if (rootFolder !== 'verticals' || verticalFolder === undefined) {
    return;
  }
  return {
    folder: verticalFolder,
    packageName: verticalPackageByFolder.get(verticalFolder),
  };
};

const isInstalledRegistry = (filePath) =>
  path.relative(root, filePath) ===
  path.join('apps', 'shell-super-app', 'src', 'verticals', 'installed.registry.ts');

const isPublicManifest = (filePath) => filePath.endsWith('vertical.manifest.ts');

execFileSync('node', ['./scripts/check-ultramodern-i18n-boundaries.mjs'], {
  cwd: root,
  stdio: 'inherit',
});

for (const filePath of sourceRoots.flatMap((sourceRoot) => walk(path.join(root, sourceRoot)))) {
  const source = fs.readFileSync(filePath, 'utf-8');
  const imports = importSpecifiers(source);
  const vertical = verticalForPath(filePath);

  if (isPublicManifest(filePath)) {
    for (const specifier of imports) {
      if (
        specifier.includes('handler') ||
        specifier.includes('vertical.registration') ||
        specifier.includes('migration')
      ) {
        addFailure(
          filePath,
          `public manifest imports private implementation specifier "${specifier}"`,
        );
      }
    }
  }

  for (const specifier of imports) {
    if (
      specifier.endsWith('/registration') &&
      specifier.startsWith('@mvp/') &&
      !isInstalledRegistry(filePath)
    ) {
      addFailure(
        filePath,
        `only the Shell installed registry may import Vertical Runtime Registration "${specifier}"`,
      );
    }

    if (
      specifier.includes('vertical.registration') &&
      !isInstalledRegistry(filePath) &&
      !filePath.endsWith('vertical.registration.ts')
    ) {
      addFailure(
        filePath,
        `only Shell/Core registry code may import private registration "${specifier}"`,
      );
    }

    if (vertical?.packageName !== undefined) {
      const crossVerticalPackage = [...verticalPackageByFolder.values()].find(
        (packageName) => packageName !== vertical.packageName && specifier.startsWith(packageName),
      );
      if (crossVerticalPackage !== undefined) {
        addFailure(
          filePath,
          `MicroVerticals must not import another MicroVertical package directly: "${specifier}"`,
        );
      }
    }
  }
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(failure);
  }
  process.exitCode = 1;
} else {
  console.log('OntOS boundary guardrails validated');
}
