#!/usr/bin/env node
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const uiKitPackage = '@techsio/ui-kit';
const uiKitVersion = '0.19.3';

const createBin = process.env.ULTRAMODERN_CREATE_BIN;
const forwardedArgs = process.argv.slice(2);
const workspaceRoot =
  process.env.ULTRAMODERN_WORKSPACE_ROOT ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ultramodernArgs = ['ultramodern', 'validate', ...[], ...forwardedArgs];
const result = createBin
  ? spawnSync(process.execPath, [createBin, ...ultramodernArgs], {
      env: { ...process.env, ULTRAMODERN_WORKSPACE_ROOT: workspaceRoot },
      stdio: 'inherit',
    })
  : spawnSync('modern-js-create', ultramodernArgs, {
      env: { ...process.env, ULTRAMODERN_WORKSPACE_ROOT: workspaceRoot },
      shell: process.platform === 'win32',
      stdio: 'inherit',
    });

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

if ((result.status ?? 1) !== 0) {
  process.exit(result.status ?? 1);
}

const readJson = (filePath: string) =>
  JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;

const packageDirs = ['apps', 'verticals']
  .map((workspaceDir) => path.join(workspaceRoot, workspaceDir))
  .filter((workspaceDir) => fs.existsSync(workspaceDir))
  .flatMap((workspaceDir) =>
    fs
      .readdirSync(workspaceDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(workspaceDir, entry.name)),
  )
  .filter((packageDir) => fs.existsSync(path.join(packageDir, 'package.json')));

const listSourceFiles = (dir: string): string[] => {
  if (!fs.existsSync(dir)) {
    return [];
  }

  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return listSourceFiles(entryPath);
    }
    return /\.(?:[cm]?[jt]sx?|css)$/u.test(entry.name) ? [entryPath] : [];
  });
};

const errors: string[] = [];

for (const packageDir of packageDirs) {
  const relativePackageDir = path.relative(workspaceRoot, packageDir);
  const packageJson = readJson(path.join(packageDir, 'package.json'));
  const dependencies = packageJson.dependencies as Record<string, string> | undefined;
  const uiKitDependency = dependencies?.[uiKitPackage];

  if (uiKitDependency !== uiKitVersion) {
    errors.push(`${relativePackageDir} must depend on ${uiKitPackage}@${uiKitVersion}`);
  }

  const routeCssPath = path.join(packageDir, 'src/routes/index.css');
  if (!fs.existsSync(routeCssPath)) {
    errors.push(`${relativePackageDir} must define src/routes/index.css for UI kit styles`);
    continue;
  }

  const routeCss = fs.readFileSync(routeCssPath, 'utf8');
  const requiredCssLines = [
    "@import 'tailwindcss' source(none);",
    "@source '..';",
    "@source '../../node_modules/@techsio/ui-kit/dist';",
    "@import '@techsio/ui-kit/tokens';",
    "@import '@techsio/ui-kit/theme.css';",
  ];

  for (const requiredLine of requiredCssLines) {
    if (!routeCss.includes(requiredLine)) {
      errors.push(`${relativePackageDir}/src/routes/index.css must include ${requiredLine}`);
    }
  }

  if (routeCss.includes('prefix(')) {
    errors.push(`${relativePackageDir}/src/routes/index.css must not use Tailwind prefixes`);
  }

  for (const sourceFile of listSourceFiles(path.join(packageDir, 'src'))) {
    const source = fs.readFileSync(sourceFile, 'utf8');
    if (/from\s+['"]@techsio\/ui-kit['"]/u.test(source)) {
      errors.push(
        `${path.relative(workspaceRoot, sourceFile)} must import UI kit components from explicit subpaths`,
      );
    }
  }
}

if (errors.length > 0) {
  console.error(
    ['Local UI kit contract validation failed:', ...errors.map((error) => `- ${error}`)].join('\n'),
  );
  process.exit(1);
}

process.exit(0);
