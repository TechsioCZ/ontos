import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import nodePath from 'node:path';

import { expect, it } from 'effect-rstest';

import { ignorePatternFlag, managedAssetSha256, managedSkillAssetPaths, policyConfig } from '../repository-policy.mts';
import { appRoot, runOxlint } from './oxlint.mts';
import { withTemporaryWorkspace } from './temporary-workspace.mts';

const skillsLockPath = '.agents/skills-lock.json';

const managedAsset = '.codex/skills/mf/assets/observability-chrome-devtool.iife.js';
const firstPartyInstanceof = 'export const check = (value) => value instanceof Error;';
const instanceOfRule = 'effect-native(no-instanceof)';

it('supports missing optional output and omits only the immutable installed provider asset', () => {
  const installedPath = nodePath.join(appRoot, managedAsset);
  const installedBytes = existsSync(installedPath) ? readFileSync(installedPath) : undefined;
  const hasPinnedBytes =
    installedBytes !== undefined && createHash('sha256').update(installedBytes).digest('hex') === managedAssetSha256;
  expect(managedSkillAssetPaths(appRoot)).toEqual(hasPinnedBytes ? [installedPath] : []);
  // Absence is always exercised. Installed-output positives are additional coverage when available.
  const variants = hasPinnedBytes ? [undefined, installedBytes] : [undefined];
  for (const bytes of variants) {
    withTemporaryWorkspace((directory) => {
      const lock = readFileSync(nodePath.join(appRoot, skillsLockPath), 'utf-8');
      const asset = nodePath.join(directory, managedAsset);
      mkdirSync(nodePath.dirname(asset), { recursive: true });
      mkdirSync(nodePath.join(directory, '.agents'), { recursive: true });
      writeFileSync(nodePath.join(directory, skillsLockPath), lock);
      if (bytes !== undefined) {
        writeFileSync(asset, bytes);
      }
      const neighbors = [
        'scripts/first-party.js',
        'verticals/example/src/first-party.ts',
        '.codex/skills/mf/assets/first-party.js',
        '.codex/skills/mf/first-party.ts',
        'unmanaged/.codex/skills/mf/assets/observability-chrome-devtool.iife.js',
      ].map((relative) => nodePath.join(directory, relative));
      for (const filename of neighbors) {
        mkdirSync(nodePath.dirname(filename), { recursive: true });
        writeFileSync(filename, firstPartyInstanceof);
      }
      const paths = managedSkillAssetPaths(directory);
      expect(paths).toEqual(bytes === undefined ? [] : [asset]);
      const flags = paths.flatMap((filename) => [ignorePatternFlag, nodePath.relative(appRoot, filename)]);
      const inputs = bytes === undefined ? neighbors : [asset, ...neighbors];
      const run = runOxlint(policyConfig, [...inputs, ...flags], appRoot);
      expect(run.exitCode).toBe(1);
      expect(run.numberOfFiles).toBe(neighbors.length);
      expect(run.diagnostics.every(({ code }) => code === instanceOfRule)).toBe(true);
      expect(run.diagnostics.map(({ filename }) => nodePath.resolve(appRoot, filename)).toSorted()).toEqual(
        neighbors.toSorted(),
      );
      writeFileSync(asset, firstPartyInstanceof);
      expect(managedSkillAssetPaths(directory)).toEqual([]);
      const changed = runOxlint(policyConfig, [asset], appRoot);
      expect(changed.exitCode).toBe(1);
      expect(changed.diagnostics.map(({ code }) => code)).toEqual([instanceOfRule]);
      if (bytes !== undefined) {
        writeFileSync(asset, bytes);
        for (const invalidLock of [
          lock.replace('07bb5b6c43ad457609e00c081b72d4c42508ec76', '0000000000000000000000000000000000000000'),
          lock.replace('https://github.com/module-federation/agent-skills', 'https://example.invalid/agent-skills'),
          lock.replace('"path": ".codex/skills/mf"', '"path": ".codex/skills/unmanaged"'),
          lock.replace('"install": "clone"', '"install": "vendored"'),
        ]) {
          expect(invalidLock).not.toBe(lock);
          writeFileSync(nodePath.join(directory, skillsLockPath), invalidLock);
          expect(managedSkillAssetPaths(directory)).toEqual([]);
        }
        const unowned = runOxlint(policyConfig, [asset], appRoot);
        expect(unowned.exitCode).toBe(1);
        expect(unowned.diagnostics).toHaveLength(3);
      }
    });
  }
});

it('does not exempt managed-looking paths through file or directory symlinks', () => {
  for (const linkKind of ['file', 'directory']) {
    withTemporaryWorkspace((directory) => {
      const asset = nodePath.join(directory, managedAsset);
      const escaped = nodePath.join(directory, 'unmanaged');
      mkdirSync(nodePath.dirname(asset), { recursive: true });
      mkdirSync(nodePath.join(directory, '.agents'), { recursive: true });
      mkdirSync(escaped);
      writeFileSync(nodePath.join(directory, skillsLockPath), readFileSync(nodePath.join(appRoot, skillsLockPath)));
      const target = nodePath.join(escaped, nodePath.basename(asset));
      const installedPath = nodePath.join(appRoot, managedAsset);
      const bytes = existsSync(installedPath) ? readFileSync(installedPath) : undefined;
      const pinned = bytes !== undefined && createHash('sha256').update(bytes).digest('hex') === managedAssetSha256;
      writeFileSync(target, pinned ? bytes : firstPartyInstanceof);
      if (linkKind === 'file') {
        symlinkSync(target, asset);
      } else {
        rmSync(nodePath.dirname(asset), { recursive: true });
        symlinkSync(escaped, nodePath.dirname(asset));
      }
      expect(managedSkillAssetPaths(directory)).toEqual([]);
      const run = runOxlint(policyConfig, [asset], appRoot);
      expect(run.exitCode).toBe(1);
      expect(run.diagnostics.every(({ code }) => code === instanceOfRule)).toBe(true);
      expect(run.diagnostics).toHaveLength(pinned ? 3 : 1);
      const rootAlias = nodePath.join(directory, 'root-alias');
      symlinkSync(directory, rootAlias);
      expect(managedSkillAssetPaths(rootAlias)).toEqual([]);
    });
  }
});
