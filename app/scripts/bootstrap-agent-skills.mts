#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const createBin = process.env.ULTRAMODERN_CREATE_BIN;
const forwardedArgs = process.argv.slice(2);
const workspaceRoot =
  process.env.ULTRAMODERN_WORKSPACE_ROOT ?? path.resolve(import.meta.dirname, '..');
const checkOnly = forwardedArgs.includes('--check');
const postinstall = forwardedArgs.includes('--postinstall');
const skipSkills =
  process.env.ULTRAMODERN_SKIP_CODEX_SKILLS === '1' || process.env.ULTRAMODERN_CODEX_SKILLS === '0';
const skillsLock = path.join(workspaceRoot, '.codex', 'skills-lock.json');

if (skipSkills) {
  console.warn('Skipping Codex skill bootstrap by configuration.');
  process.exit(0);
}

if (!existsSync(skillsLock) && (postinstall || checkOnly)) {
  console.warn(`Skipping Codex skill bootstrap: ${skillsLock} is missing.`);
  process.exit(0);
}

const skillArgs = checkOnly
  ? ['skills', 'check', ...forwardedArgs.filter((arg) => arg !== '--check')]
  : ['skills', 'install', ...forwardedArgs];
const ultramodernArgs = ['ultramodern', ...skillArgs];
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
