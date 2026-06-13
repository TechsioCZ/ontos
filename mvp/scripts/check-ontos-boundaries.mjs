import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const verticalIds = ['property-registry', 'accounting-core'];
const sourceRoots = ['apps', 'verticals', 'packages'];
const allowedRegistrationImportFiles = new Set([
  'apps/shell-super-app/src/verticals/installed.registry.ts',
]);

const walk = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(directory, entry.name);
    if (
      entry.name === 'node_modules' ||
      entry.name === 'dist' ||
      entry.name === '.modern' ||
      entry.name === '.modernjs'
    ) {
      return [];
    }

    if (entry.isDirectory()) {
      return walk(fullPath);
    }

    return /\.(?:mjs|ts|tsx)$/u.test(entry.name) ? [fullPath] : [];
  });

const files = sourceRoots
  .map((sourceRoot) => join(root, sourceRoot))
  .filter((path) => {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  })
  .flatMap(walk);

const violations = [];
const readSource = (file) => readFileSync(file, 'utf8');
const relativeFile = (file) => relative(root, file);

for (const file of files) {
  const source = readSource(file);
  const relativePath = relativeFile(file);

  for (const verticalId of verticalIds) {
    const directPrivateImportPatterns = [
      `@mvp/${verticalId}/src/`,
      `@mvp/${verticalId}/api/`,
      `@mvp/${verticalId}/shared/`,
      `verticals/${verticalId}/src/`,
      `verticals/${verticalId}/api/`,
      `verticals/${verticalId}/shared/`,
    ];

    for (const pattern of directPrivateImportPatterns) {
      if (source.includes(pattern)) {
        violations.push(`${relativePath} imports private ${verticalId} source through ${pattern}`);
      }
    }
  }

  const importsRegistration =
    /['"]@mvp\/(?:property-registry|accounting-core)\/vertical\.registration['"]/u.test(source);

  if (importsRegistration && !allowedRegistrationImportFiles.has(relativePath)) {
    violations.push(
      `${relativePath} imports vertical.registration outside the Shell/Core installed registry allowlist`,
    );
  }
}

const shellDiscovery = readSource(
  join(root, 'apps/shell-super-app/src/verticals/module-discovery.ts'),
);
const shellComponents = readSource(
  join(root, 'apps/shell-super-app/src/routes/vertical-components.tsx'),
);
const propertyMfConfig = readSource(
  join(root, 'verticals/property-registry/module-federation.config.ts'),
);
const accountingMfConfig = readSource(
  join(root, 'verticals/accounting-core/module-federation.config.ts'),
);

if (!shellDiscovery.includes('resolveVisibleVerticals')) {
  violations.push('Shell discovery must call resolveVisibleVerticals.');
}

if (!shellDiscovery.includes('getVerticalPublicComponentSpecifier')) {
  violations.push(
    'Shell discovery must expose descriptor-driven public component specifier resolution.',
  );
}

if (
  !shellComponents.includes('getVerticalPublicComponentSpecifier') ||
  !shellComponents.includes('loadRemote') ||
  !shellComponents.includes('data-mf-public-component')
) {
  violations.push(
    'Shell home must consume manifest-public components through Module Federation loaders.',
  );
}

if (!propertyMfConfig.includes("'./PropertyUnitCard'")) {
  violations.push(
    'property.registry must expose ./PropertyUnitCard for public component federation.',
  );
}

if (!accountingMfConfig.includes("'./AccountingDraftEntryCard'")) {
  violations.push(
    'accounting.core must expose ./AccountingDraftEntryCard for public component federation.',
  );
}

const crossMicroVerticalProof =
  shellComponents.includes('data-cross-microvertical-consumer="shell-super-app"') &&
  shellComponents.includes('data-cross-microvertical-provider') &&
  shellComponents.includes('propertyRegistry/PropertyUnitCard');

const accountingRemoteSource = readSource(
  join(root, 'verticals/accounting-core/src/components/remote-property-unit-card.tsx'),
);
const accountingConsumesProperty =
  accountingRemoteSource.includes("remote: 'propertyRegistry'") &&
  accountingRemoteSource.includes("exposedModule: './PropertyUnitCard'") &&
  accountingRemoteSource.includes('loadRemote');

if (!crossMicroVerticalProof && !accountingConsumesProperty) {
  violations.push(
    'No cross-MicroVertical public component consumption through Module Federation was proven.',
  );
}

if (violations.length > 0) {
  for (const violation of violations) {
    console.error(`OntOS boundary violation: ${violation}`);
  }
  process.exit(1);
}

console.log(
  'OntOS boundaries passed: registry allowlist, private import guard, and Module Federation public component proof are present.',
);
