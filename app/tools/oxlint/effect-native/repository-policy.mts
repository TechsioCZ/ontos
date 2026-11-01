import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import nodePath from 'node:path';

import { Result, Schema } from 'effect';

import { appRoot, pluginDirectory, runOxlint } from './tests/oxlint.mts';

/**
 * Repository policy lint: `repository-policy.config.ts` over all application source, including
 * tools and root configuration. Usage: node tools/oxlint/effect-native/repository-policy.mts
 */
const skillsLockPath = '.agents/skills-lock.json';
export const managedAssetSha256 = '0285a3668bea1d370f839bdc3b2a8d42795e330e6c897cfb3e5c50c878d10b7d';
export const policyConfig = nodePath.join(pluginDirectory, 'repository-policy.config.ts');
export const ignorePatternFlag = '--ignore-pattern';

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
export const managedSkillAssetPaths = (root: string): string[] => {
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
  const lockPath = nodePath.join(root, skillsLockPath);
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

/** Lint the repository; diagnostics, a crashed loader, or an empty run fail the command. */
export const lintRepositoryPolicy = (root = appRoot) =>
  runOxlint(
    policyConfig,
    [
      '.',
      ignorePatternFlag,
      'tools/oxlint/**/tests/fixtures/**',
      ...managedSkillAssetPaths(root).flatMap((asset) => [ignorePatternFlag, nodePath.relative(root, asset)]),
    ],
    root,
  );

if (import.meta.main) {
  if (process.argv.length > 2) {
    throw new Error('Usage: node tools/oxlint/effect-native/repository-policy.mts');
  }
  const run = lintRepositoryPolicy();
  for (const { code, filename, labels, message } of run.diagnostics) {
    const span = labels[0]?.span;
    console.error(`${filename}:${span?.line ?? 0}:${span?.column ?? 0} ${code} ${message}`);
  }
  console.log(`Repository policy: ${run.numberOfFiles} files linted, ${run.diagnostics.length} diagnostics.`);
  // Any diagnostic fails the step, including a warning that leaves Oxlint's own exit status at zero.
  process.exitCode = run.diagnostics.length === 0 ? run.exitCode : 1;
}
