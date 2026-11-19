import path from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { Config, Effect, FileSystem, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { ChildProcess } from 'effect/process';
import { parse } from 'yaml';

import { collectToolingProcess } from './tooling-process-fixture.mts';

/**
 * The repository's Actions cache holds 10 GiB. On 2026-11-15 the gates' unit output cache wrote a full 1.7 GiB set on
 * every pull request run (keyed by merge sha, run id and attempt) and evicted the stage deploy's unit caches, so the
 * next deploy rebuilt all 28 units. A cache key names what decides the cache's content, never the commit or the run.
 */
const APP = path.resolve(import.meta.dirname, '../..');
const REPOSITORY = path.resolve(APP, '..');
const PER_RUN =
  /github\.(?:sha|run_id|run_attempt|event\.pull_request\.head\.sha)|\$\{?GITHUB_(?:SHA|RUN_ID|RUN_ATTEMPT)\b|\.github\/workflows\//u;
const CACHE_ACTION = /^actions\/cache(?:\/restore|\/save)?@/u;

/**
 * The caches whose content is the commit or the run itself, so their key must name it. Every other key fails on any
 * per-commit or per-run part.
 */
const PER_RUN_ALLOWED = new Map([
  // Saved only by main pushes (warm-caches): the incremental TS-Go state of that commit, restored by prefix.
  ['tsgo-', 'the TS-Go incremental build of one main commit, saved by main pushes only'],
]);

const StepSchema = Schema.Struct({
  id: Schema.optional(Schema.String),
  if: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  run: Schema.optional(Schema.String),
  uses: Schema.optional(Schema.String),
  with: Schema.optional(Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Number, Schema.Boolean]))),
});
type Step = typeof StepSchema.Type;
const WorkflowSchema = Schema.Struct({
  jobs: Schema.Record(Schema.String, Schema.Struct({ steps: Schema.optional(Schema.Array(StepSchema)) })),
});
const ActionSchema = Schema.Struct({ runs: Schema.Struct({ steps: Schema.Array(StepSchema) }) });

interface CacheStep {
  readonly key: string;
  readonly label: string;
  readonly save: boolean;
  readonly step: Step;
}

/** A key's text with every `steps.<id>.outputs.*` it reads replaced by what that step computes it from. */
const resolveKey = (key: string, steps: readonly Step[], installApp: readonly Step[]): string =>
  key.replaceAll(
    /\$\{\{\s*steps\.(?<id>[\w-]+)\.outputs\.(?<output>[\w-]+)\s*\}\}/gu,
    (whole, id: string, output: string) => {
      const source = steps.find((candidate) => candidate.id === id);
      if (source === undefined) {
        return whole;
      }
      if (CACHE_ACTION.test(source.uses ?? '')) {
        return resolveKey(String(source.with?.key ?? ''), steps, installApp);
      }
      // The install action names the TS-Go cache in its own `typescript-build` step.
      if (source.uses === './.github/actions/install-app' && output === 'typescript-build-key') {
        return installApp.find((candidate) => candidate.id === 'typescript-build')?.run ?? whole;
      }
      return source.run ?? whole;
    },
  );

const cacheSteps = Effect.gen(function* readCacheSteps() {
  const fs = yield* FileSystem.FileSystem;
  const found: CacheStep[] = [];
  const installApp = (yield* Schema.decodeUnknownEffect(ActionSchema)(
    parse(yield* fs.readFileString(path.join(REPOSITORY, '.github/actions/install-app/action.yml'))),
  )).runs.steps;
  const sources = [
    ...(yield* fs.readDirectory(path.join(REPOSITORY, '.github/workflows')))
      .filter((name) => name.endsWith('.yml'))
      .map((name) => `.github/workflows/${name}`),
    ...(yield* fs.readDirectory(path.join(REPOSITORY, '.github/actions'))).map(
      (name) => `.github/actions/${name}/action.yml`,
    ),
  ].toSorted();
  for (const source of sources) {
    const document: unknown = parse(yield* fs.readFileString(path.join(REPOSITORY, source)));
    const jobs = source.endsWith('action.yml')
      ? [
          [
            path.basename(path.dirname(source)),
            (yield* Schema.decodeUnknownEffect(ActionSchema)(document)).runs.steps,
          ] as const,
        ]
      : Object.entries((yield* Schema.decodeUnknownEffect(WorkflowSchema)(document)).jobs).map(
          ([job, { steps }]) => [job, steps ?? []] as const,
        );
    for (const [job, steps] of jobs) {
      for (const step of steps.filter(({ uses }) => CACHE_ACTION.test(uses ?? ''))) {
        const raw = [step.with?.key, step.with?.['restore-keys']].map((value) => String(value ?? '')).join('\n');
        found.push({
          key: resolveKey(raw, steps, installApp),
          label: `${path.basename(source)} ${job} › ${step.name ?? step.uses ?? ''}`,
          save: (step.uses ?? '').startsWith('actions/cache/save@'),
          step,
        });
      }
    }
  }
  return found;
});

const allowedFor = (key: string) => [...PER_RUN_ALLOWED.keys()].find((prefix) => key.includes(prefix));

it.effect('names no cache by commit, run or workflow file unless its content is that commit or run', () =>
  Effect.gen(function* perRunKeys() {
    const steps = yield* cacheSteps;
    expect(steps.length).toBeGreaterThan(10);
    const offenders = steps
      .filter(({ key }) => PER_RUN.test(key) && allowedFor(key) === undefined)
      .map(({ key, label }) => `${label}: ${key}`);
    expect(offenders).toEqual([]);
    // Every allow-list entry still names a real cache, so the list cannot outlive what it excuses.
    for (const prefix of PER_RUN_ALLOWED.keys()) {
      expect(
        steps.some(({ key }) => key.includes(prefix)),
        prefix,
      ).toBe(true);
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('saves a content-keyed cache only when the run did not restore that exact entry', () =>
  Effect.gen(function* savesOnlyNew() {
    const saves = (yield* cacheSteps).filter(({ key, save }) => save && allowedFor(key) === undefined);
    const always = saves.filter(({ step }) => !/cache-hit != 'true'/u.test(step.if ?? ''));
    // The main-only TS-Go save is allow-listed above; every other save skips an exact hit.
    expect(always.map(({ label }) => label)).toEqual([]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

/**
 * The only conditions a content-keyed save may have: its exact entry was not restored, and its key was named. Anything
 * else (for example "only when something was built") leaves a cache restored through a prefix without an entry under
 * its own name, so it depends on the fallback forever (run 43725413089: six stage shards reused and saved nothing).
 */
const SAVE_CLAUSE = /^steps\.[\w-]+\.outputs\.(?:cache-hit != 'true'|key != '')$/u;
/**
 * The one other clause, on the pnpm store save alone: a job that used its restored installed workspace restored no
 * store and installed nothing, so it has no store to save. A lockfile change misses that workspace (its key holds the
 * lockfile), so the trunk job that installs it saves the store under its exact key.
 */
const STORE_SAVE = { clause: "steps.restored.outputs.usable != 'true'", label: 'install-app › Save the pnpm store' };
// The checkout proof provisions a browser in only the tooling shard that collects it. Its cache save must
// follow exactly the restore's selection, not an extra condition on what that shard happened to build.
const CHECKOUT_BROWSER_SAVE = {
  clause: "steps.checkout-browser.outputs.required == 'true'",
  label:
    "ultramodern-workspace-gates.yml workspace-gate › Save the checkout proof's pinned Chromium and system-library packages",
  restore:
    "ultramodern-workspace-gates.yml workspace-gate › Restore the checkout proof's pinned Chromium and system-library packages",
};

it.effect('makes every content-keyed save depend only on its exact entry not being restored', () =>
  Effect.gen(function* saveClauses() {
    const steps = yield* cacheSteps;
    const saves = steps.filter(({ key, save }) => save && allowedFor(key) === undefined);
    expect(steps.find(({ label }) => label === CHECKOUT_BROWSER_SAVE.restore)?.step.if).toBe(
      CHECKOUT_BROWSER_SAVE.clause,
    );
    expect(saves.find(({ label }) => label === CHECKOUT_BROWSER_SAVE.label)?.step.if).toContain(
      CHECKOUT_BROWSER_SAVE.clause,
    );
    const offenders = saves.flatMap(({ label, step }) =>
      (step.if ?? '')
        .split('&&')
        .map((clause) => clause.trim())
        // Which runs may write (an input, the ref) is policy; what a step produced may only be the exact hit and key.
        .filter((clause) => clause.includes('steps.') && !SAVE_CLAUSE.test(clause))
        .filter((clause) => !(label.endsWith(STORE_SAVE.label) && clause === STORE_SAVE.clause))
        .filter((clause) => !(label === CHECKOUT_BROWSER_SAVE.label && clause === CHECKOUT_BROWSER_SAVE.clause))
        .map((clause) => `${label}: ${clause}`),
    );
    expect(offenders).toEqual([]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

const KEY_SCRIPT = 'scripts/ci/cache-entry-key.sh';
const IDENTITY = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const runKey = (input: string, env: Readonly<Record<string, string>> = {}) =>
  collectToolingProcess(
    ChildProcess.make('bash', ['-c', `printf '%s' "$INPUT" | bash ${KEY_SCRIPT} zerops-units-v2-3-`], {
      cwd: APP,
      env: { INPUT: input, ...env },
      extendEnv: true,
    }),
  );

it.live(
  'names the same entry for the same identities in any order, a new one for a changed unit, and refuses doubt',
  () =>
    Effect.gen(function* keyScript() {
      const first = yield* runKey(`tax\t${IDENTITY}\npricing\t${IDENTITY}\n`);
      const again = yield* runKey(`pricing\t${IDENTITY}\ntax\t${IDENTITY}\n`);
      const changed = yield* runKey(`tax\t${IDENTITY}\npricing\t${OTHER}\n`);
      expect(first.status, first.stderr).toBe(0);
      expect(first.stdout).toMatch(/^key=zerops-units-v2-3-[a-f0-9]{64}\n$/u);
      expect(again.stdout).toBe(first.stdout);
      expect(changed.stdout).not.toBe(first.stdout);
      // Stage identity rows carry the inputs part and the variables after the identity.
      const row = yield* runKey(`tax\t${IDENTITY}\tfiles\tNODE_ENV=1a2b\n`);
      expect(row.status, row.stderr).toBe(0);
      for (const [label, input, reason] of [
        ['no identities', '', 'no unit identities on stdin'],
        ['no identity', 'tax\t\n', 'not a unit identity: tax'],
        ['short identity', 'tax\tabc\n', 'not a unit identity'],
        ['no tab', `tax=${IDENTITY}\n`, 'not a unit identity: tax='],
      ] as const) {
        const result = yield* runKey(input);
        expect(result.status, label).toBe(1);
        expect(result.stderr, label).toContain(reason);
        expect(result.stdout, label).toBe('');
      }
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.live('refuses to name an entry when the hash fails', () =>
  Effect.gen(function* failingHash() {
    const fs = yield* FileSystem.FileSystem;
    const bin = yield* fs.makeTempDirectoryScoped({ prefix: 'cache-key-stub-' });
    yield* fs.writeFileString(path.join(bin, 'sha256sum'), '#!/bin/sh\nexit 1\n');
    yield* fs.chmod(path.join(bin, 'sha256sum'), 0o700);
    const result = yield* runKey(`tax\t${IDENTITY}\n`, { PATH: `${bin}:${yield* Config.String('PATH')}` });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
