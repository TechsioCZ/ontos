import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';

/*
 * scripts/ci/seed-units.sh picks the run whose unit outputs a gates build shard starts from, and places them. Each
 * find case below breaks one rule of which run may be the seed and must leave no seed; the GitHub API is a fake gh that
 * answers each recorded call exactly and fails every other one. The unpack cases place only whole units, and nothing
 * from an archive that does not unpack.
 */

const SCRIPT = fileURLToPath(new URL('../ci/seed-units.sh', import.meta.url));
const REPOSITORY = 'TechsioCZ/ontos';
const TRUNK = 'demo/sales-crm';
const WORKFLOW_ID = 342_952_200;
const RUN_ID = 44_600_000_000;
const PUSH_RUN = 44_590_000_000;
const CANDIDATE_RUN = 44_580_000_000;
const runUrl = (id: number) => `https://github.com/${REPOSITORY}/actions/runs/${id}`;

const RUN_LOOKUP = `api repos/${REPOSITORY}/actions/runs/${RUN_ID} --jq .workflow_id`;
const runList = (sha: string) =>
  `api --method GET repos/${REPOSITORY}/actions/workflows/${WORKFLOW_ID}/runs -f head_sha=${sha} -f per_page=100`;
const artifactList = (run: number) =>
  `api --method GET repos/${REPOSITORY}/actions/runs/${run}/artifacts -f per_page=100`;

interface Run {
  readonly conclusion: string | null;
  readonly created_at: string;
  readonly event: string;
  readonly head_branch: string;
  readonly head_repository: { readonly full_name: string };
  readonly head_sha: string;
  readonly id: number;
  readonly repository: { readonly full_name: string };
  readonly status: string;
  readonly workflow_id: number;
}
const runs = (list: readonly Run[]) =>
  JSON.stringify({
    total_count: list.length,
    workflow_runs: list.map((run) => ({ ...run, html_url: runUrl(run.id) })),
  });
const trunkPush = (sha: string, id = PUSH_RUN, created = '2026-11-19T02:00:00Z'): Run => ({
  conclusion: 'success',
  created_at: created,
  event: 'push',
  head_branch: TRUNK,
  head_repository: { full_name: REPOSITORY },
  head_sha: sha,
  id,
  repository: { full_name: REPOSITORY },
  status: 'completed',
  workflow_id: WORKFLOW_ID,
});
const candidateRun = (sha: string, id = CANDIDATE_RUN, created = '2026-11-19T01:00:00Z'): Run => ({
  ...trunkPush(sha, id, created),
  event: 'workflow_dispatch',
  head_branch: 'candidate/main-merge-20261119',
});

interface ArtifactFields {
  readonly expired?: boolean;
  readonly name?: string;
  readonly workflow_run?: { readonly head_sha: string; readonly id: number };
}
/** The artifact list of a run that built: one node-units archive per shard; the case under test overrides fields. */
const unitArtifacts = (run: number, sha: string, fields: ArtifactFields = {}) =>
  JSON.stringify({
    artifacts: [1, 2, 3].map((shard) => ({
      expired: false,
      id: run + shard,
      name: `node-units-${shard}`,
      workflow_run: { head_sha: sha, id: run },
      ...fields,
    })),
    total_count: 3,
  });

interface Route {
  readonly exit?: number;
  readonly stderr?: string;
  readonly stdout?: string;
}

it.live(
  'seeds the build shards only from a successful run of this workflow on trunk history that kept its outputs',
  () =>
    Effect.sync(() => {
      const directory = mkdtempSync(path.join(os.tmpdir(), 'ontos-ci-seed-units-'));
      const repository = path.join(directory, 'repository');
      mkdirSync(repository);
      const git = (...args: string[]) =>
        execFileSync('/usr/bin/git', ['-c', 'user.name=CI test', '-c', 'user.email=ci@example.invalid', ...args], {
          cwd: repository,
          encoding: 'utf-8',
        }).trim();
      const commit = (file: string) => {
        writeFileSync(path.join(repository, file), `${file}\n`);
        git('add', file);
        git('commit', '--quiet', '-m', file);
        return git('rev-parse', 'HEAD');
      };
      const find = (routes: Readonly<Record<string, Route>>, base: string) => {
        const bin = path.join(directory, 'bin');
        rmSync(bin, { force: true, recursive: true });
        mkdirSync(bin);
        const calls = path.join(directory, 'calls');
        const output = path.join(directory, 'outputs');
        writeFileSync(calls, '');
        writeFileSync(output, '');
        const branches = Object.entries(routes).map(([args, { exit = 0, stderr = '', stdout = '' }], index) => {
          writeFileSync(path.join(bin, `stdout-${index}`), stdout);
          writeFileSync(path.join(bin, `stderr-${index}`), stderr);
          return `  '${args}') cat '${bin}/stdout-${index}'; cat '${bin}/stderr-${index}' >&2; exit ${exit} ;;`;
        });
        writeFileSync(
          path.join(bin, 'gh'),
          [
            '#!/bin/bash',
            `printf '%s\\n' "$*" >> '${calls}'`,
            'case "$*" in',
            ...branches,
            '  *) echo "unexpected gh $*" >&2; exit 97 ;;',
            'esac',
            '',
          ].join('\n'),
        );
        chmodSync(path.join(bin, 'gh'), 0o755);
        const log = execFileSync('/bin/bash', [SCRIPT, 'find'], {
          cwd: repository,
          encoding: 'utf-8',
          env: {
            BASE_SHA: base,
            GITHUB_OUTPUT: output,
            GITHUB_REPOSITORY: REPOSITORY,
            GITHUB_RUN_ID: String(RUN_ID),
            PATH: `${bin}:/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin`,
          },
          stdio: 'pipe',
        });
        return {
          calls: readFileSync(calls, 'utf-8').split('\n').filter(Boolean),
          log,
          run: /^run=(?<run>.+)$/mu.exec(readFileSync(output, 'utf-8'))?.groups?.run,
        };
      };
      try {
        git('init', '--quiet');
        // Seven trunk commits, oldest first, and a side commit that never landed on the trunk.
        const trunk = ['1.ts', '2.ts', '3.ts', '4.ts', '5.ts', '6.ts', '7.ts'].map(commit);
        git('checkout', '--quiet', '-b', 'round');
        const unlanded = commit('round.ts');
        git('checkout', '--quiet', '-');
        git('update-ref', `refs/remotes/origin/${TRUNK}`, trunk.at(-1) ?? '');
        const base = trunk.at(-1) ?? '';
        const parent = trunk.at(-2) ?? '';
        const lookup = { [RUN_LOOKUP]: { stdout: `${WORKFLOW_ID}\n` } };
        const seeded = (list: readonly Run[], sha = base, artifacts = unitArtifacts(PUSH_RUN, sha)) => ({
          ...lookup,
          [artifactList(PUSH_RUN)]: { stdout: artifacts },
          [runList(sha)]: { stdout: runs(list) },
        });
        const unseeded = (result: ReturnType<typeof find>, label: string) => {
          expect(result.run, label).toBeUndefined();
          expect(result.log, label).toContain('Every unit of the build shards builds.');
        };

        // A trunk push of this workflow on the base commit that kept its unit outputs is the seed.
        const sound = find(seeded([trunkPush(base)]), base);
        expect(sound.run).toBe(String(PUSH_RUN));
        expect(sound.calls).toEqual([RUN_LOOKUP, runList(base), artifactList(PUSH_RUN)]);
        expect(sound.log).toContain(`start from the unit outputs of ${runUrl(PUSH_RUN)}`);

        // A proven trunk commit: its push run built nothing, the candidate run that proved it did.
        const proven = find(
          {
            ...lookup,
            [artifactList(CANDIDATE_RUN)]: { stdout: unitArtifacts(CANDIDATE_RUN, base) },
            [artifactList(PUSH_RUN)]: { stdout: JSON.stringify({ artifacts: [], total_count: 0 }) },
            [runList(base)]: { stdout: runs([trunkPush(base), candidateRun(base)]) },
          },
          base,
        );
        expect(proven.run).toBe(String(CANDIDATE_RUN));

        // A run that is not this workflow's successful trunk push or candidate dispatch on that very commit, in this
        // repository, is never asked for its artifacts.
        for (const [label, run] of [
          ['another workflow', { ...trunkPush(base), workflow_id: WORKFLOW_ID + 1 }],
          ['a failed run', { ...trunkPush(base), conclusion: 'failure' }],
          ['a cancelled run', { ...trunkPush(base), conclusion: 'cancelled' }],
          ['a running run', { ...trunkPush(base), conclusion: null, status: 'in_progress' }],
          ['another commit', { ...trunkPush(base), head_sha: parent }],
          ['a push to main', { ...trunkPush(base), head_branch: 'main' }],
          ['a pull request run', { ...trunkPush(base), event: 'pull_request' }],
          ['a merge group run', { ...trunkPush(base), event: 'merge_group' }],
          [
            'a dispatch outside candidate/*',
            { ...trunkPush(base), event: 'workflow_dispatch', head_branch: 'feature/x' },
          ],
          ['a fork', { ...trunkPush(base), head_repository: { full_name: 'someone/ontos' } }],
          ['another repository', { ...trunkPush(base), repository: { full_name: 'someone/ontos' } }],
        ] as const) {
          const result = find(seeded([run]), base);
          unseeded(result, label);
          expect(result.calls, label).not.toContain(artifactList(PUSH_RUN));
        }

        // A run whose unit outputs expired, or that holds only other artifacts or those of another run, is no seed.
        for (const [label, fields] of [
          ['expired outputs', { expired: true }],
          ['another artifact', { name: 'ci-comparison' }],
          ['a stage archive', { name: 'stage-units-1' }],
          ['outputs of another run', { workflow_run: { head_sha: base, id: PUSH_RUN + 1 } }],
          ['outputs of another commit', { workflow_run: { head_sha: parent, id: PUSH_RUN } }],
        ] as const) {
          const result = find(seeded([trunkPush(base)], base, unitArtifacts(PUSH_RUN, base, fields)), base);
          unseeded(result, label);
          expect(result.calls, label).toEqual([
            RUN_LOOKUP,
            runList(base),
            artifactList(PUSH_RUN),
            ...trunk.slice(-5, -1).toReversed().map(runList),
          ]);
        }

        // No run on the base: its nearest first-parent ancestor with one is the seed, before any older one.
        const nearest = find(
          {
            ...lookup,
            [artifactList(PUSH_RUN)]: { stdout: unitArtifacts(PUSH_RUN, parent) },
            [runList(base)]: { stdout: runs([]) },
            [runList(parent)]: { stdout: runs([trunkPush(parent)]) },
          },
          base,
        );
        expect(nearest.run).toBe(String(PUSH_RUN));
        expect(nearest.calls).toEqual([RUN_LOOKUP, runList(base), runList(parent), artifactList(PUSH_RUN)]);

        // Five commits at most: a seed six commits back is never looked up.
        const sixth = trunk.at(-6) ?? '';
        const bounded = find(
          {
            ...lookup,
            ...Object.fromEntries(trunk.slice(-5).map((sha) => [runList(sha), { stdout: runs([]) }])),
            [artifactList(PUSH_RUN)]: { stdout: unitArtifacts(PUSH_RUN, sixth) },
            [runList(sixth)]: { stdout: runs([trunkPush(sixth)]) },
          },
          base,
        );
        unseeded(bounded, 'six commits back');
        expect(bounded.calls).toEqual([RUN_LOOKUP, ...trunk.slice(-5).toReversed().map(runList)]);

        // A commit outside the trunk's history is never a seed, even with a sound-looking run; its trunk parent may be.
        const round = find(
          {
            ...seeded([trunkPush(unlanded), candidateRun(unlanded)], unlanded),
            [runList(base)]: { stdout: runs([]) },
          },
          unlanded,
        );
        expect(round.calls).not.toContain(runList(unlanded));
        expect(round.log).toContain(`${unlanded} is not in the history of ${TRUNK}`);
        unseeded(round, 'an unlanded fix round');

        // Every failed lookup is no seed and never fails the step.
        unseeded(find({}, ''), 'no comparison');
        expect(find({}, '').calls).toEqual([]);
        for (const [label, routes] of [
          ['an unreadable workflow', { ...seeded([trunkPush(base)]), [RUN_LOOKUP]: { exit: 1, stderr: 'HTTP 502\n' } }],
          ['unreadable runs', { ...seeded([trunkPush(base)]), [runList(base)]: { exit: 1, stderr: 'HTTP 403\n' } }],
          ['unparsable runs', { ...seeded([trunkPush(base)]), [runList(base)]: { stdout: '<html>unicorn</html>' } }],
          ['unreadable artifacts', { ...seeded([trunkPush(base)]), [artifactList(PUSH_RUN)]: { exit: 1 } }],
          ['unparsable artifacts', { ...seeded([trunkPush(base)]), [artifactList(PUSH_RUN)]: { stdout: '{}' } }],
        ] as const) {
          unseeded(find(routes, base), label);
        }
      } finally {
        rmSync(directory, { force: true, recursive: true });
      }
    }),
);

it.live('places the whole outputs of the shard units from the seed archive, and nothing from a broken one', () =>
  Effect.sync(() => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'ontos-ci-seed-unpack-'));
    const units = ['verticals/whole', 'verticals/half', 'verticals/linked', 'verticals/built'];
    const source = path.join(directory, 'source');
    const app = path.join(directory, 'app');
    const archive = path.join(directory, 'units.tar.zst');
    const place = (file: string) => {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, `${path.relative(source, file)}\n`);
    };
    const unpack = (seed: string) => {
      rmSync(app, { force: true, recursive: true });
      for (const unit of units) {
        mkdirSync(path.join(app, unit, 'src'), { recursive: true });
      }
      // A unit that already has outputs in the checkout keeps its own.
      place(path.join(app, 'verticals/built/dist/own.js'));
      const log = execFileSync('/bin/bash', [SCRIPT, 'unpack', seed], {
        cwd: app,
        encoding: 'utf-8',
        env: {
          PATH: '/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin',
          RUNNER_TEMP: directory,
          SHARD_UNITS: units.join(' '),
        },
        stdio: 'pipe',
      });
      return { log, placed: (file: string) => existsSync(path.join(app, file)) };
    };
    try {
      // What a shard packs: every ignored path of its units, here also another shard's unit and other build files.
      for (const file of [
        'verticals/whole/dist/index.js',
        'verticals/whole/.output/server.mjs',
        'verticals/whole/.modern/state.json',
        'verticals/half/dist/index.js',
        'verticals/linked/.output/server.mjs',
        'verticals/built/dist/index.js',
        'verticals/built/.output/server.mjs',
        'verticals/other/dist/index.js',
        'verticals/other/.output/server.mjs',
      ]) {
        place(path.join(source, file));
      }
      symlinkSync('/etc', path.join(source, 'verticals/linked/dist'));
      execFileSync('/usr/bin/tar', ['--create', '--zstd', '--file', archive, '--directory', source, 'verticals']);

      const whole = unpack(archive);
      expect(whole.placed('verticals/whole/dist/index.js')).toBe(true);
      expect(whole.placed('verticals/whole/.output/server.mjs')).toBe(true);
      // Only dist/ and .output/ of the shard's units, both or neither.
      expect(whole.placed('verticals/whole/.modern')).toBe(false);
      expect(whole.placed('verticals/half/dist')).toBe(false);
      expect(whole.placed('verticals/linked/dist')).toBe(false);
      expect(whole.placed('verticals/linked/.output')).toBe(false);
      expect(whole.placed('verticals/other')).toBe(false);
      expect(whole.placed('verticals/built/dist/own.js')).toBe(true);
      expect(whole.placed('verticals/built/dist/index.js')).toBe(false);
      expect(whole.placed('verticals/built/.output')).toBe(false);
      expect(whole.log).toContain('Placed the seed outputs of 1 of 4 units');

      // An archive that does not unpack whole, cut short or no archive at all, places nothing and fails nothing.
      const bytes = readFileSync(archive);
      const truncated = path.join(directory, 'truncated.tar.zst');
      writeFileSync(truncated, bytes.subarray(0, Math.floor(bytes.length / 2)));
      const garbage = path.join(directory, 'garbage.tar.zst');
      writeFileSync(garbage, 'not an archive');
      for (const seed of [truncated, garbage, path.join(directory, 'missing.tar.zst')]) {
        const broken = unpack(seed);
        for (const unit of units.filter((name) => name !== 'verticals/built')) {
          expect(broken.placed(`${unit}/dist`), seed).toBe(false);
          expect(broken.placed(`${unit}/.output`), seed).toBe(false);
        }
        expect(broken.log, seed).toContain('::warning title=No seed::');
      }
      // The staging directories are gone either way.
      expect(execFileSync('/bin/ls', [directory], { encoding: 'utf-8' })).not.toContain('seed-units.');
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  }),
);
