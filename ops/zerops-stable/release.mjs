#!/usr/bin/env node
// Stable release candidates: immutable annotated `sales-stable/YYYY-MM-DD[-N]` tags on commits of demo/sales-crm.
//
//   node app/scripts/zerops/stable/release.mjs pin --tag sales-stable/2026-11-27 [--ref demo/sales-crm]
//       [--demo-ref origin/demo/sales-crm] [--remote origin] [--push]
//   node app/scripts/zerops/stable/release.mjs inspect --tag sales-stable/2026-11-27
//       [--demo-ref origin/demo/sales-crm] [--remote origin]
//
// `pin` creates the annotated tag locally and pushes it only with --push. `inspect` prints the tag's exact commit as
// JSON and fails on a lightweight, malformed or moved tag, or a commit that is not on the demo line. Friday is the
// usual pin day; another day only prints a note. Every git call takes an argument array, never a shell string.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

export const TAG_PATTERN = /^sales-stable\/(\d{4})-(\d{2})-(\d{2})(?:-([1-9]\d*))?$/u;
export const DEFAULT_PIN_REF = 'demo/sales-crm';
export const DEFAULT_DEMO_REF = 'origin/demo/sales-crm';
export const DEFAULT_REMOTE = 'origin';
const PRAGUE = 'Europe/Prague';

export class ReleaseError extends Error {}

/** The date and same-day sequence of a candidate tag (the first tag of a day has no suffix, the second is -2). */
export function parseTag(tag) {
  const match = TAG_PATTERN.exec(String(tag ?? ''));
  if (!match) throw new ReleaseError(`${tag} is not a sales-stable/YYYY-MM-DD[-N] tag`);
  const [, year, month, day, suffix] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (date.toISOString().slice(0, 10) !== `${year}-${month}-${day}`) {
    throw new ReleaseError(`${tag} names no calendar date`);
  }
  const sequence = suffix === undefined ? 1 : Number(suffix);
  if (suffix !== undefined && sequence < 2) {
    throw new ReleaseError(`${tag}: the first tag of a day has no suffix; the second is -2`);
  }
  return { date: `${year}-${month}-${day}`, sequence };
}

/** The weekday (Mon … Sun) and date (YYYY-MM-DD) of an instant in Prague. */
export function pragueDay(now) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: PRAGUE,
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(now)
      .map((part) => [part.type, part.value]),
  );
  return { weekday: parts.weekday, date: `${parts.year}-${parts.month}-${parts.day}` };
}

/** sha256 (hex) of the config file's bytes: what candidate evidence and the artifact manifest bind. */
export function configFileDigest(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function git(cwd, args, { allowFailure = false } = {}) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (allowFailure) return null;
    throw new ReleaseError(`git ${args[0]} failed: ${result.stderr.trim() || `exit ${result.status}`}`);
  }
  return result.stdout.replace(/\n$/u, '');
}

const resolveCommit = (cwd, ref) => {
  const commit = git(cwd, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], {
    allowFailure: true,
  });
  if (!commit) throw new ReleaseError(`${ref} names no commit here (fetch it first)`);
  return commit;
};

const isAncestor = (cwd, commit, ref) => {
  const result = spawnSync('git', ['merge-base', '--is-ancestor', commit, ref], { cwd, encoding: 'utf8' });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new ReleaseError(`cannot compare ${commit} with ${ref}: ${result.stderr.trim()}`);
};

/** The tag object id the remote holds for <tag>, or null when it holds none. */
const remoteTagObject = (cwd, remote, tag) => {
  const output = git(cwd, ['ls-remote', '--tags', remote, `refs/tags/${tag}`]);
  const line = output.split('\n').find((entry) => entry.endsWith(`\trefs/tags/${tag}`));
  return line ? line.split('\t')[0] : null;
};

const tagHeader = (raw) => {
  const header = {};
  for (const line of raw.split('\n')) {
    if (line === '') break;
    const space = line.indexOf(' ');
    header[line.slice(0, space)] = line.slice(space + 1);
  }
  return header;
};

/**
 * The exact commit of an annotated candidate tag, proven: an annotated tag object naming itself and one commit, that
 * commit on the demo line, and (with a remote) the remote holding the same tag object. A remote holding another
 * object means the tag moved, which fails. `published` says whether the remote holds it at all.
 */
export function inspectRelease({ cwd, tag, demoRef = DEFAULT_DEMO_REF, remote = DEFAULT_REMOTE }) {
  parseTag(tag);
  const ref = `refs/tags/${tag}`;
  const type = git(cwd, ['cat-file', '-t', ref], { allowFailure: true });
  if (type === null) throw new ReleaseError(`${tag} does not exist here (git fetch ${remote} tag ${tag})`);
  if (type !== 'tag') throw new ReleaseError(`${tag} is a lightweight tag; candidates are annotated tags`);
  const tagObject = git(cwd, ['rev-parse', '--verify', ref]);
  const header = tagHeader(git(cwd, ['cat-file', 'tag', tagObject]));
  if (header.tag !== tag) throw new ReleaseError(`the tag object under ${tag} names itself ${header.tag}`);
  if (header.type !== 'commit') throw new ReleaseError(`${tag} tags a ${header.type}, not a commit`);
  const commit = header.object;
  if (resolveCommit(cwd, ref) !== commit) throw new ReleaseError(`${tag} does not resolve to the commit it tags`);
  const demoCommit = resolveCommit(cwd, demoRef);
  if (!isAncestor(cwd, commit, demoRef)) {
    throw new ReleaseError(`${tag} tags ${commit}, which is not on ${demoRef}`);
  }
  let published = null;
  if (remote) {
    const held = remoteTagObject(cwd, remote, tag);
    if (held !== null && held !== tagObject) {
      throw new ReleaseError(`${tag} moved: ${remote} holds tag object ${held}, this repository ${tagObject}`);
    }
    published = held !== null;
  }
  return { tag, tagObject, commit, demoRef, demoCommit, remote: remote || null, published };
}

/** inspectRelease, and the tag must be published: only a pushed tag is the immutable candidate CI builds. */
export function inspectDeployableRelease(options) {
  const release = inspectRelease(options);
  if (release.published !== true) {
    throw new ReleaseError(`${release.tag} is not on ${release.remote ?? 'a remote'}; push it before building or deploying`);
  }
  return release;
}

/** Builds read the checkout itself: it must be exactly <commit>, with nothing modified or untracked. */
export function assertCleanCheckoutAt(cwd, commit) {
  const head = git(cwd, ['rev-parse', 'HEAD']);
  if (head !== commit) throw new ReleaseError(`the checkout is at ${head}, not the candidate ${commit}`);
  const dirty = git(cwd, ['status', '--porcelain', '--untracked-files=all']);
  if (dirty !== '') {
    throw new ReleaseError(`the checkout differs from ${commit}:\n${dirty.split('\n').slice(0, 20).join('\n')}`);
  }
}

/** Creates the annotated candidate tag on <ref> (pushed only with push: true). Never replaces a tag. */
export function pinCandidate({
  cwd,
  tag,
  ref = DEFAULT_PIN_REF,
  demoRef = DEFAULT_DEMO_REF,
  remote = DEFAULT_REMOTE,
  push = false,
  now = new Date(),
}) {
  const { date } = parseTag(tag);
  const commit = resolveCommit(cwd, ref);
  if (!isAncestor(cwd, commit, demoRef)) {
    throw new ReleaseError(`${ref} (${commit}) is not on ${demoRef}; push it to demo/sales-crm first`);
  }
  if (git(cwd, ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`], { allowFailure: true })) {
    throw new ReleaseError(`${tag} exists already; tags are immutable, pin the next one (-2, -3, …)`);
  }
  if (push && remoteTagObject(cwd, remote, tag) !== null) {
    throw new ReleaseError(`${remote} holds ${tag} already; tags are immutable, pin the next one`);
  }
  const message = `Stable sales candidate ${tag}\n\ncommit: ${commit}\nref: ${ref}\npinned-at: ${now.toISOString()}\n`;
  git(cwd, ['tag', '--annotate', '--message', message, tag, commit]);
  if (push) git(cwd, ['push', remote, `refs/tags/${tag}:refs/tags/${tag}`]);
  const notes = [];
  const today = pragueDay(now);
  if (today.weekday !== 'Fri') notes.push(`pinned on ${today.weekday}; the usual pin day is Friday`);
  if (today.date !== date) notes.push(`the tag names ${date}, today in Prague is ${today.date}`);
  if (!push) notes.push(`not pushed; publish it with: git push ${remote} refs/tags/${tag}`);
  return { ...inspectRelease({ cwd, tag, demoRef, remote: push ? remote : null }), notes };
}

const USAGE = `usage:
  release.mjs pin --tag sales-stable/YYYY-MM-DD[-N] [--ref demo/sales-crm] [--demo-ref ${DEFAULT_DEMO_REF}] [--remote origin] [--push]
  release.mjs inspect --tag TAG [--demo-ref ${DEFAULT_DEMO_REF}] [--remote origin]`;

export function main(argv, { cwd = process.cwd(), now = new Date() } = {}) {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      tag: { type: 'string' },
      ref: { type: 'string' },
      'demo-ref': { type: 'string' },
      remote: { type: 'string' },
      push: { type: 'boolean', default: false },
    },
    strict: true,
  });
  if (!values.tag) throw new ReleaseError(USAGE);
  const common = { cwd, tag: values.tag, demoRef: values['demo-ref'] ?? DEFAULT_DEMO_REF, remote: values.remote ?? DEFAULT_REMOTE };
  if (command === 'pin') return pinCandidate({ ...common, ref: values.ref ?? DEFAULT_PIN_REF, push: values.push, now });
  if (command === 'inspect' && values.ref === undefined && !values.push) return inspectRelease(common);
  throw new ReleaseError(USAGE);
}

if (import.meta.main) {
  try {
    const result = main(process.argv.slice(2));
    for (const note of result.notes ?? []) console.error(`note: ${note}`);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof ReleaseError ? error.message : error);
    process.exit(1);
  }
}
