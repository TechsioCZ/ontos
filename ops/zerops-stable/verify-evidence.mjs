// The two release inputs verify.mjs does not produce itself and never assumes: the migration rehearsal record
// (data.mjs rehearse, after the candidate migrator ran on disposable scratch restores of the stable backup) and the
// human sales walkthrough record. Each binds the tag and commit under verification; a missing, foreign or stale file fails
// its check.
import { readFile } from 'node:fs/promises';

import { assertRehearsalEvidence, backupManifestDigest, readRehearsalEvidence } from './data.mjs';

/** Evidence older than this does not prove the candidate under verification now. */
export const EVIDENCE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const WALKTHROUGH_KIND = 'ontos.stable.sales-walkthrough';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const instant = (value) => (typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? Date.parse(value) : undefined);

const readEvidence = async (check, path, label) => {
  if (typeof path !== 'string' || path.length === 0) {
    check.fail(`no ${label} evidence was given`);
    return undefined;
  }
  try {
    const value = JSON.parse(await readFile(path, 'utf8'));
    if (!isObject(value)) throw new SyntaxError('not an object');
    return value;
  } catch (error) {
    check.fail(`${label} evidence is not readable JSON (${error.code ?? error.name})`);
    return undefined;
  }
};

const bindsRelease = (check, value, release, label) => {
  check.expect(value.schemaVersion === 1, `${label} evidence is schemaVersion 1`, `${label} evidence is not schemaVersion 1`);
  check.expect(
    value.tag === release.tag && value.commit === release.commit,
    `${label} evidence binds ${release.tag} at ${release.commit}`,
    `${label} evidence does not bind ${release.tag} at ${release.commit}`,
  );
};

const recent = (check, at, now, label) => {
  check.expect(
    at !== undefined && at <= now.getTime() && now.getTime() - at <= EVIDENCE_MAX_AGE_MS,
    `${label} is within the last 7 days`,
    `${label} is missing, in the future or older than 7 days`,
  );
};

/**
 * Migration rehearsal: the record data.mjs `rehearse` wrote after the candidate migrator ran on scratch restores of the
 * stable backup, accepted by data.mjs's own assertRehearsalEvidence for this tag, commit and backup.
 */
export const migrationRehearsalCheck = async (check, { backupDirectory, config, path, release }) => {
  check.require(typeof path === 'string' && path.length > 0, 'no migration rehearsal evidence was given');
  check.require(
    typeof backupDirectory === 'string' && backupDirectory.length > 0,
    'no backup directory was given to bind the rehearsal to',
  );
  const record = await readRehearsalEvidence(path);
  const backupManifestSha256 = await backupManifestDigest(backupDirectory);
  assertRehearsalEvidence(record, { backupManifestSha256, commit: release.commit, config, tag: release.tag });
  check.pass(`the ${release.commit} migrator exited 0 on scratch restores of backup ${backupManifestSha256}`);
  check.pass(`the rehearsal ran ${String(record.startedAt)} to ${String(record.finishedAt)} on scratch cluster ${String(record.scratchSystemIdentifier)}`);
};

const WALKTHROUGH_KEYS = ['schemaVersion', 'kind', 'tag', 'commit', 'performedBy', 'performedAt', 'verdict', 'notes'];

/**
 * Human sales walkthrough: {schemaVersion: 1, kind, tag, commit, performedBy, performedAt, verdict, notes}. A person
 * walks the sales journeys on stable and records `accepted` or `rejected`; this check never decides for them.
 */
export const salesWalkthroughCheck = async (check, { now, path, release }) => {
  const value = await readEvidence(check, path, 'sales walkthrough');
  if (value === undefined) return;
  const unknown = Object.keys(value).filter((key) => !WALKTHROUGH_KEYS.includes(key));
  const missing = WALKTHROUGH_KEYS.filter((key) => !(key in value));
  check.expect(
    unknown.length === 0 && missing.length === 0,
    'the walkthrough record has exactly its fields',
    `the walkthrough record has unknown fields (${unknown.join(', ')}) or misses fields (${missing.join(', ')})`,
  );
  check.expect(value.kind === WALKTHROUGH_KIND, `kind is ${WALKTHROUGH_KIND}`, `kind is not ${WALKTHROUGH_KIND}`);
  bindsRelease(check, value, release, 'sales walkthrough');
  check.expect(
    typeof value.performedBy === 'string' && value.performedBy.trim().length > 0,
    'the walkthrough names who performed it',
    'the walkthrough names nobody',
  );
  check.expect(typeof value.notes === 'string', 'the walkthrough carries its notes', 'the walkthrough notes are not text');
  recent(check, instant(value.performedAt), now, 'the walkthrough');
  check.expect(
    value.verdict === 'accepted',
    'the person who walked the sales journeys accepted the candidate',
    `the walkthrough verdict is ${JSON.stringify(value.verdict)}, not "accepted"`,
  );
};
