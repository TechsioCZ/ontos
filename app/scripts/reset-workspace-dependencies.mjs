#!/usr/bin/env node

import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';

const workspaceRoot = path.resolve(import.meta.dirname, '..');
const dependencyDirectories = [path.join(workspaceRoot, 'node_modules')];

for (const scope of ['apps', 'packages', 'verticals']) {
  const scopeDirectory = path.join(workspaceRoot, scope);
  const entries = await readdir(scopeDirectory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      dependencyDirectories.push(path.join(scopeDirectory, entry.name, 'node_modules'));
    }
  }
}

await Promise.all(
  dependencyDirectories.map((directory) => rm(directory, { force: true, recursive: true })),
);

console.log(`Removed ${dependencyDirectories.length} workspace dependency directories`);
