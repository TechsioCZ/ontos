import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';

import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';

/*
 * scripts/ci/commit-proof.sh decides whether a push to the demo trunk skips its gates because a candidate/* dispatch
 * of the same workflow already passed on the same commit. Each case below breaks one soundness rule of that decision
 * and must leave the gates running; the GitHub API is a fake gh that answers each recorded call exactly.
 */

const SCRIPT = fileURLToPath(new URL('../ci/commit-proof.sh', import.meta.url));
const REPOSITORY = 'TechsioCZ/ontos';
const BRANCH = 'demo/sales-crm';
const WORKFLOW_ID = 342_952_200;
const RUN_ID = 44_500_000_000;
const HEAD = '1'.repeat(40);
const BEFORE = '2'.repeat(40);
const OLDER = '3'.repeat(40);
const CANDIDATE_RUN = 44_490_000_000;
const OLDER_CANDIDATE_RUN = 44_480_000_000;
const runUrl = (id: number) => `https://github.com/${REPOSITORY}/actions/runs/${id}`;

const RUN_LOOKUP = `api repos/${REPOSITORY}/actions/runs/${RUN_ID} --jq .workflow_id`;
const PREVIOUS_LIST = `api --method GET repos/${REPOSITORY}/actions/workflows/${WORKFLOW_ID}/runs -f branch=${BRANCH} -f event=push -f head_sha=${BEFORE} -f per_page=100`;
const DISPATCH_LIST = `api --method GET repos/${REPOSITORY}/actions/workflows/${WORKFLOW_ID}/runs -f event=workflow_dispatch -f head_sha=${HEAD} -f per_page=100`;
const artifactList = (run: number) =>
  `api --method GET repos/${REPOSITORY}/actions/runs/${run}/artifacts -f name=ci-comparison`;
const artifactZip = (artifact: number) => `api repos/${REPOSITORY}/actions/artifacts/${artifact}/zip`;

interface Run {
  readonly conclusion: string | null;
  readonly created_at: string;
  readonly event: string;
  readonly head_branch: string;
  readonly head_sha: string;
  readonly id: number;
  readonly run_attempt?: number;
  readonly status: string;
  readonly workflow_id: number;
}
const runs = (list: readonly Run[]) =>
  JSON.stringify({
    total_count: list.length,
    workflow_runs: list.map((run) => ({ ...run, html_url: runUrl(run.id) })),
  });
const greenPush = (sha: string, created = '2026-11-19T00:00:00Z'): Run => ({
  conclusion: 'success',
  created_at: created,
  event: 'push',
  head_branch: BRANCH,
  head_sha: sha,
  id: 44_470_000_000,
  status: 'completed',
  workflow_id: WORKFLOW_ID,
});
const candidate = (id = CANDIDATE_RUN, created = '2026-11-19T01:00:00Z'): Run => ({
  conclusion: 'success',
  created_at: created,
  event: 'workflow_dispatch',
  head_branch: 'candidate/main-merge-20261119',
  head_sha: HEAD,
  id,
  status: 'completed',
  workflow_id: WORKFLOW_ID,
});

/** A one-file stored ZIP archive, as the artifact download endpoint returns the uploaded record. */
const zipOf = (name: string, content: Buffer) => {
  const fileName = Buffer.from(name);
  const checksum = crc32(content);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04_03_4b_50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x21, 12);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(content.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(fileName.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02_01_4b_50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x21, 14);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(content.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(fileName.length, 28);
  const centralOffset = local.length + fileName.length + content.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06_05_4b_50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + fileName.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, fileName, content, central, fileName, end]);
};

/** What the artifact list says of one artifact; the case under test overrides one field. */
interface ArtifactFields {
  readonly expired?: boolean;
  readonly name?: string;
  readonly workflow_run?: { readonly head_sha: string; readonly id: number };
}
const artifactOf = (run: number, id: number, fields: ArtifactFields = {}) => ({
  [artifactList(run)]: {
    stdout: JSON.stringify({
      artifacts: [{ expired: false, id, name: 'ci-comparison', workflow_run: { head_sha: HEAD, id: run }, ...fields }],
      total_count: 1,
    }),
  },
});

interface Route {
  readonly exit?: number;
  readonly stderr?: string;
  readonly stdout?: Buffer | string;
}

it.live('skips the gates of a push only on a sound candidate proof of the same commit', () =>
  Effect.sync(() => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'ontos-ci-commit-proof-'));
    /** The record a candidate plan writes, through the script's own record subcommand. */
    const recorded = (fields: Readonly<Record<string, string>> = {}) => {
      const file = path.join(directory, 'record', 'comparison.json');
      rmSync(path.dirname(file), { force: true, recursive: true });
      execFileSync('/bin/bash', [SCRIPT, 'record', file], {
        env: {
          BASE_REF: BRANCH,
          BASE_SHA: BEFORE,
          HEAD_SHA: HEAD,
          PATH: '/usr/bin:/bin',
          PLAN_MODE: 'affected',
          ...fields,
        },
        stdio: 'pipe',
      });
      return zipOf('comparison.json', readFileSync(file));
    };
    /** The answers of a sound proof: a green previous head and one candidate run that compared with it. */
    const sound = (record = recorded()) => ({
      [DISPATCH_LIST]: { stdout: runs([candidate()]) },
      [PREVIOUS_LIST]: { stdout: runs([greenPush(BEFORE)]) },
      [RUN_LOOKUP]: { stdout: `${WORKFLOW_ID}\n` },
      ...artifactOf(CANDIDATE_RUN, 7),
      [artifactZip(7)]: { stdout: record },
    });
    const find = (routes: Readonly<Record<string, Route>>, environment: Readonly<Record<string, string>> = {}) => {
      const bin = path.join(directory, 'bin');
      rmSync(bin, { force: true, recursive: true });
      mkdirSync(bin);
      const calls = path.join(directory, 'calls');
      const output = path.join(directory, 'outputs');
      const summary = path.join(directory, 'summary');
      for (const file of [calls, output, summary]) {
        writeFileSync(file, '');
      }
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
        cwd: directory,
        encoding: 'utf-8',
        env: {
          BEFORE_SHA: BEFORE,
          GITHUB_OUTPUT: output,
          GITHUB_REF_NAME: BRANCH,
          GITHUB_REPOSITORY: REPOSITORY,
          GITHUB_RUN_ID: String(RUN_ID),
          GITHUB_SHA: HEAD,
          GITHUB_STEP_SUMMARY: summary,
          PATH: `${bin}:/usr/bin:/bin`,
          ...environment,
        },
        stdio: 'pipe',
      });
      const outputs = readFileSync(output, 'utf-8');
      return {
        calls: readFileSync(calls, 'utf-8').split('\n').filter(Boolean),
        log,
        proven: /^proven=(?<proven>\w+)$/mu.exec(outputs)?.groups?.proven,
        run: /^run=(?<run>.+)$/mu.exec(outputs)?.groups?.run,
        summary: readFileSync(summary, 'utf-8'),
      };
    };
    const unproven = (routes: Readonly<Record<string, Route>>, label: string, environment?: Record<string, string>) => {
      const result = find(routes, environment);
      expect(result.proven, label).toBe('false');
      expect(result.run, label).toBeUndefined();
      expect(result.summary, label).toBe('');
      expect(result.log, label).toContain('The gates run.');
      return result;
    };
    try {
      // A sound proof: the push skips its gates, and its log and step summary name the proving run (rule 5).
      for (const mode of ['affected', 'scoped', 'full']) {
        const proven = find(sound(recorded({ PLAN_MODE: mode })));
        expect(proven.proven, mode).toBe('true');
        expect(proven.run, mode).toBe(runUrl(CANDIDATE_RUN));
        expect(proven.log, mode).toContain(`Run ${runUrl(CANDIDATE_RUN)} already proved ${HEAD}`);
        expect(proven.summary, mode).toContain(`Run ${runUrl(CANDIDATE_RUN)} already proved ${HEAD}`);
        expect(proven.calls, mode).toEqual([
          RUN_LOOKUP,
          PREVIOUS_LIST,
          DISPATCH_LIST,
          artifactList(CANDIDATE_RUN),
          artifactZip(7),
        ]);
      }

      // Rule 1: only a completed, successful candidate/* dispatch of this workflow on this very commit is looked at;
      // the list may hold anything, its record is never read.
      for (const [label, run] of [
        ['another commit', { ...candidate(), head_sha: OLDER }],
        ['another workflow', { ...candidate(), workflow_id: WORKFLOW_ID + 1 }],
        ['a push run', { ...candidate(), event: 'push' }],
        ['a pull request run', { ...candidate(), event: 'pull_request' }],
        ['a dispatch outside candidate/*', { ...candidate(), head_branch: 'feature/candidate/x' }],
        ['a running candidate', { ...candidate(), conclusion: null, status: 'in_progress' }],
        // Rule 4: a cancelled run and a rerun whose final attempt is not green never count.
        ['a cancelled candidate', { ...candidate(), conclusion: 'cancelled' }],
        ['a red rerun', { ...candidate(), conclusion: 'failure', run_attempt: 2 }],
      ] as const) {
        const result = unproven({ ...sound(), [DISPATCH_LIST]: { stdout: runs([run]) } }, label);
        expect(result.calls, label).not.toContain(artifactList(CANDIDATE_RUN));
      }

      // Rule 2: the candidate compared with this branch at exactly the commit the push starts from.
      for (const [label, fields] of [
        ['an older merge base', { BASE_SHA: OLDER }],
        ['a forced-full run with no merge base', { BASE_SHA: '', PLAN_MODE: 'full' }],
        ['a narrower custom base-ref', { BASE_REF: 'candidate/earlier-round' }],
        ['another base branch', { BASE_REF: 'main' }],
        ['a record of another commit', { HEAD_SHA: OLDER }],
        ['a documentation plan', { PLAN_MODE: 'docs' }],
        ['a proven plan', { PLAN_MODE: 'proven' }],
      ] as const) {
        unproven(sound(recorded(fields)), label);
      }
      // A run without its own live record, or a record of another run, proves nothing.
      for (const [label, fields] of [
        ['an expired record', { expired: true }],
        ['a record of another run', { workflow_run: { head_sha: HEAD, id: CANDIDATE_RUN + 1 } }],
        ['a record of another commit', { workflow_run: { head_sha: OLDER, id: CANDIDATE_RUN } }],
        ['another artifact', { name: 'ci-changed-paths' }],
      ] as const) {
        unproven({ ...sound(), ...artifactOf(CANDIDATE_RUN, 7, fields) }, label);
      }
      unproven({ ...sound(), [artifactZip(7)]: { stdout: zipOf('other.json', Buffer.from('{}')) } }, 'no record file');
      unproven({ ...sound(), [artifactZip(7)]: { stdout: 'not a zip' } }, 'an unreadable archive');
      // A newer candidate with an unfit record does not hide an older one that compared with the right commit.
      const older = find({
        ...sound(recorded({ BASE_SHA: OLDER })),
        [DISPATCH_LIST]: { stdout: runs([candidate(OLDER_CANDIDATE_RUN, '2026-11-19T00:30:00Z'), candidate()]) },
        ...artifactOf(OLDER_CANDIDATE_RUN, 8),
        [artifactZip(8)]: { stdout: recorded() },
      });
      expect(older.proven).toBe('true');
      expect(older.run).toBe(runUrl(OLDER_CANDIDATE_RUN));
      expect(older.log).toContain(`${runUrl(CANDIDATE_RUN)} recorded`);

      // Rule 3: the commit the push starts from is green: its newest push run on this branch succeeded.
      for (const [label, list] of [
        ['a red previous head', [{ ...greenPush(BEFORE), conclusion: 'failure' }]],
        ['an unfinished previous head', [{ ...greenPush(BEFORE), conclusion: null, status: 'in_progress' }]],
        ['a cancelled previous head', [{ ...greenPush(BEFORE), conclusion: 'cancelled' }]],
        ['an unknown previous head', []],
        ['a previous head green only on another branch', [{ ...greenPush(BEFORE), head_branch: 'main' }]],
        ['a previous head green only in another workflow', [{ ...greenPush(BEFORE), workflow_id: WORKFLOW_ID + 1 }]],
        ['a previous head green only as a dispatch', [{ ...greenPush(BEFORE), event: 'workflow_dispatch' }]],
        ['another commit green', [greenPush(OLDER)]],
        [
          'a previous head red after an earlier green run',
          [greenPush(BEFORE), { ...greenPush(BEFORE, '2026-11-19T00:10:00Z'), conclusion: 'failure' }],
        ],
      ] as const) {
        const result = unproven({ ...sound(), [PREVIOUS_LIST]: { stdout: runs(list) } }, label);
        expect(result.calls, label).not.toContain(DISPATCH_LIST);
      }
      expect(
        find({
          ...sound(),
          [PREVIOUS_LIST]: {
            stdout: runs([{ ...greenPush(BEFORE), conclusion: 'failure' }, greenPush(BEFORE, '2026-11-19T00:10:00Z')]),
          },
        }).proven,
      ).toBe('true');
      // A push that creates the branch starts from no commit.
      expect(unproven(sound(), 'a new branch', { BEFORE_SHA: '0'.repeat(40) }).calls).toEqual([]);

      // Every failed lookup is no proof and never fails the step: the gates run.
      for (const [label, routes] of [
        ['an unreadable workflow', { ...sound(), [RUN_LOOKUP]: { exit: 1, stderr: 'gh: Server Error (HTTP 502)\n' } }],
        [
          'unreadable push runs',
          { ...sound(), [PREVIOUS_LIST]: { exit: 1, stderr: 'gh: API rate limit exceeded (HTTP 403)\n' } },
        ],
        ['unparsable push runs', { ...sound(), [PREVIOUS_LIST]: { stdout: '<html>unicorn</html>' } }],
        [
          'unreadable dispatches',
          { ...sound(), [DISPATCH_LIST]: { exit: 1, stderr: 'gh: Server Error (HTTP 500)\n' } },
        ],
        [
          'unreadable artifacts',
          { ...sound(), [artifactList(CANDIDATE_RUN)]: { exit: 1, stderr: 'gh: Not Found (HTTP 404)\n' } },
        ],
        ['an undownloadable record', { ...sound(), [artifactZip(7)]: { exit: 1, stderr: 'gh: Gone (HTTP 410)\n' } }],
      ] as const) {
        unproven(routes, label);
      }
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  }),
);
