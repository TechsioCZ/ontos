#!/usr/bin/env node
/// <reference types="node" />

import { readdirSync, rmSync } from 'node:fs';
import path from 'node:path';

const workspaceRoot = path.resolve(import.meta.dirname, '..');
const dependencyDirectories = [path.join(workspaceRoot, 'node_modules')];

for (const scope of ['apps', 'packages', 'verticals']) {
  const scopeDirectory = path.join(workspaceRoot, scope);
  const entries = readdirSync(scopeDirectory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      dependencyDirectories.push(
        path.join(scopeDirectory, entry.name, 'node_modules')
      );
    }
  }
}

for (const directory of dependencyDirectories) {
  rmSync(directory, { force: true, recursive: true });
}

console.log(
  `Removed ${dependencyDirectories.length} workspace dependency directories`
);
