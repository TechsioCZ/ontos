#!/usr/bin/env node
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { generateOntosModuleContract } from './generate-ontos-module-contract.mts';

const vertical = process.argv[2];
if (vertical === undefined || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(vertical)) {
  throw new Error('Usage: prepare-dev-module-contract <vertical>');
}

const workspaceRoot = path.resolve(import.meta.dirname, '..');
const generated = await generateOntosModuleContract({
  target: 'dist',
  vertical,
  workspaceRoot,
});
const publicDirectory = path.join(workspaceRoot, 'verticals', vertical, '.dev-public');
const contractDirectory = path.join(publicDirectory, '.well-known');
await mkdir(contractDirectory, { recursive: true });
await copyFile(generated.path, path.join(contractDirectory, 'ontos-module-manifest.json'));
await writeFile(
  path.join(publicDirectory, '_headers'),
  await readFile(path.join(path.dirname(path.dirname(generated.path)), '_headers'), 'utf-8'),
  'utf-8',
);

console.log(`Prepared the ${vertical} development module contract in ${publicDirectory}`);
