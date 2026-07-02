#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const createBin = process.env.ULTRAMODERN_CREATE_BIN;
const forwardedArgs = process.argv.slice(2);
const workspaceRoot =
  process.env.ULTRAMODERN_WORKSPACE_ROOT ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ultramodernArgs = ['ultramodern', 'performance-readiness', ...[], ...forwardedArgs];
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

process.exit(result.status ?? 1);
