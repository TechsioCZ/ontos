import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import nodePath from 'node:path';

import { Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { appRoot, pluginDirectory, runOxlint, testsDirectory } from './oxlint.mts';
import { withTemporaryWorkspace } from './temporary-workspace.mts';

const ignorePatternFlag = '--ignore-pattern';
const skillsLockPath = '.agents/skills-lock.json';
const managedAssetSha256 = '0285a3668bea1d370f839bdc3b2a8d42795e330e6c897cfb3e5c50c878d10b7d';

const SkillSourceLock = Schema.Struct({
  installDir: Schema.Literal('.codex/skills'),
  schemaVersion: Schema.Literal(1),
  sources: Schema.Array(
    Schema.Struct({
      baseline: Schema.optional(
        Schema.Array(Schema.Struct({ name: Schema.String, path: Schema.optional(Schema.String) })),
      ),
      commit: Schema.optional(Schema.String),
      id: Schema.String,
      install: Schema.String,
      repository: Schema.String,
    }),
  ),
});

/** Exact installer-owned dependency bytes, not an exemption for editable skill or application source.
 * The provider pin or bundle changing fails closed and requires a new ownership review.
 */
const managedSkillAssetPaths = (root: string): string[] => {
  if (!existsSync(root) || realpathSync(root) !== nodePath.resolve(root)) {
    return [];
  }
  const directories = ['.agents', '.codex', '.codex/skills', '.codex/skills/mf', '.codex/skills/mf/assets'];
  for (const directory of directories) {
    const target = nodePath.join(root, directory);
    if (!existsSync(target) || lstatSync(target).isSymbolicLink() || !lstatSync(target).isDirectory()) {
      return [];
    }
  }
  const lockPath = nodePath.join(root, '.agents/skills-lock.json');
  const asset = nodePath.join(root, '.codex/skills/mf/assets/observability-chrome-devtool.iife.js');
  for (const target of [lockPath, asset]) {
    if (!existsSync(target) || lstatSync(target).isSymbolicLink() || !lstatSync(target).isFile()) {
      return [];
    }
  }
  const lock = Result.getOrThrow(
    Schema.decodeUnknownResult(Schema.fromJsonString(SkillSourceLock))(readFileSync(lockPath, 'utf-8')),
  );
  const provider = lock.sources.find((source) => source.id === 'module-federation-agent-skills');
  if (
    provider?.repository !== 'https://github.com/module-federation/agent-skills' ||
    provider.commit !== '07bb5b6c43ad457609e00c081b72d4c42508ec76' ||
    provider.install !== 'clone' ||
    provider.baseline?.some((skill) => skill.name === 'mf' && skill.path === '.codex/skills/mf') !== true
  ) {
    return [];
  }
  if (createHash('sha256').update(readFileSync(asset)).digest('hex') !== managedAssetSha256) {
    return [];
  }
  return [asset];
};

it('all repository source, including tools and root configuration, follows the Effect discrimination policy', () => {
  const run = runOxlint(
    nodePath.join(pluginDirectory, 'repository-policy.config.ts'),
    [
      '.',
      ignorePatternFlag,
      'tools/oxlint/**/tests/fixtures/**',
      ignorePatternFlag,
      'tools/oxlint/effect-native/tests/effect-policy-*/**',
      ...managedSkillAssetPaths(appRoot).flatMap((asset) => [ignorePatternFlag, nodePath.relative(appRoot, asset)]),
    ],
    appRoot,
  );
  expect(run.diagnostics.map(({ code, filename, labels }) => `${filename}:${labels[0]?.span.line} ${code}`)).toEqual(
    [],
  );
  expect(run.exitCode).toBe(0);
});

const managedAsset = '.codex/skills/mf/assets/observability-chrome-devtool.iife.js';
const policyConfig = nodePath.join(pluginDirectory, 'repository-policy.config.ts');
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
    }, testsDirectory);
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
    }, testsDirectory);
  }
});
