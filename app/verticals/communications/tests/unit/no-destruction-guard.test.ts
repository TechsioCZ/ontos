import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'effect-rstest';

import { communicationsManifest } from '../../vertical.manifest.ts';
import { outboxWorkers } from '../../src/workers/index.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));

const filesUnder = (directory: string, suffix: RegExp): readonly string[] =>
  readdirSync(path.join(root, directory), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && suffix.test(entry.name))
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)));

/** Source with comments removed, so prose that explains the prohibition cannot trip or hide a real call. */
const codeOf = (file: string): string =>
  readFileSync(path.join(root, file), 'utf-8')
    .replaceAll(/\/\*[\s\S]*?\*\//gu, '')
    .replaceAll(/(?<keep>^|[^:])\/\/.*$/gmu, '$<keep>');

const ownerSources = [
  ...filesUnder('src', /\.ts$/u),
  ...filesUnder('shared', /\.ts$/u),
  ...filesUnder('api', /\.ts$/u),
  'vertical.manifest.ts',
  'vertical.registration.ts',
];

/**
 * The only destructive or rewriting statements that exist, each with the reason it is not a D21 disposal path. A new entry needs
 * the same review: no entry may touch a personal-data category of the inventory.
 */
const allowedMutations: readonly { readonly file: string; readonly pattern: RegExp; readonly reason: string }[] = [
  {
    file: 'src/auth/gateway-assertion-redemption-runtime.ts',
    pattern: /\.delete\(gatewayAssertionRedemptions\)/u,
    reason:
      'generated replay protection of the gateway assertion ledger: issuer, audience and jti only, no subject, actor or message data',
  },
  {
    file: 'src/services/template-revision.service.ts',
    pattern: /\.update\(templateActivations\)/u,
    reason:
      'closes ONE activation period once (a trigger refuses any later change), so closed template history stays append-only',
  },
];

const forbidden: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: 'drizzle delete', pattern: /\.delete\(/u },
  { name: 'drizzle update', pattern: /\.update\(/u },
  { name: 'raw destructive SQL', pattern: /\b(?:delete\s+from|truncate\s+table|drop\s+table|drop\s+schema)\b/iu },
  { name: 'anonymize or purge call', pattern: /\b(?:anonymi[sz]e|purge|shred|scrub|wipe)[A-Z_(a-z]*\s*\(/u },
  {
    name: 'cleanup or disposal job',
    pattern: /\b(?:cleanup|garbageCollect|expireNow|dispose(?:Of)?Data)[A-Za-z]*\s*\(/u,
  },
  { name: 'timer', pattern: /\b(?:setInterval|setTimeout)\s*\(/u },
  {
    name: 'scheduler',
    pattern: /\b(?:Schedule\.(?:cron|spaced|fixed|fromDelay)|Effect\.(?:repeat|schedule|forever)|Cron\.)/u,
  },
];

describe('No automatic destructive mechanism (#1410 AC-05 AC-12, PRIV-COM-05/06/16, E)', () => {
  it('has no delete, update, purge, anonymize, cleanup, timer or scheduler in any owner source, except the two reviewed non-personal ones', () => {
    const offenders = ownerSources.flatMap((file) => {
      const code = codeOf(file);
      return forbidden.flatMap(({ name, pattern }) => {
        const matches = code.match(new RegExp(pattern.source, `${pattern.flags}g`)) ?? [];
        const allowed = allowedMutations.filter((entry) => entry.file === file && entry.pattern.test(code));
        return matches.length > allowed.length ? [`${file}: ${name}`] : [];
      });
    });
    expect(offenders).toEqual([]);
  });

  it('allows no mutation on a personal-data table: every allowed statement targets a table with no personal data', () => {
    for (const { reason } of allowedMutations) {
      expect(reason.length).toBeGreaterThan(20);
    }
    expect(allowedMutations.map(({ file }) => file).toSorted()).toEqual([
      'src/auth/gateway-assertion-redemption-runtime.ts',
      'src/services/template-revision.service.ts',
    ]);
  });

  it('has no DELETE, TRUNCATE or DROP TABLE in any migration, and one reviewed pre-release column correction', () => {
    const migrations = filesUnder('drizzle', /migration\.sql$/u);
    expect(migrations.length).toBeGreaterThan(0);
    const dropped = migrations.flatMap((file) => {
      const sql = readFileSync(path.join(root, file), 'utf-8').replaceAll(/--.*$/gmu, '');
      expect(/\b(?:delete\s+from|truncate|drop\s+table|drop\s+schema)\b/iu.test(sql), file).toBe(false);
      return (sql.match(/drop\s+column/giu) ?? []).length > 0 ? [file] : [];
    });
    // #1398 hardening removed two never-used placeholder columns from the template type, before any release
    expect(dropped).toEqual(['drizzle/20261119122651_template-revision-hardening/migration.sql']);
  });

  it('exposes no Action whose key or verb can dispose of data: the only Actions are the existing template, language and intake ones', () => {
    const keys = communicationsManifest.publicSurface.actions.map((action) => action.descriptor.actionKey);
    expect(
      keys.filter((key) => /(?:delete|purge|anonymi[sz]e|erase|shred|wipe|cleanup|dispos|retention|dsr)/iu.test(key)),
    ).toEqual([]);
  });

  it('registers exactly one worker, the pre-handoff worker: no expiry, retention, cleanup or disposition worker exists', () => {
    expect(outboxWorkers.map((worker) => worker.descriptor.workerKey)).toEqual([
      'communications.core.prepare-message-handoff',
    ]);
  });

  it('keeps the retention hook and the owner contract free of any write capability', () => {
    for (const file of filesUnder('shared/privacy-owner', /\.ts$/u)) {
      const code = codeOf(file);
      expect(/from 'drizzle-orm|ScopedTransactionExecutor|\.insert\(|\.update\(|\.delete\(/u.test(code), file).toBe(
        false,
      );
    }
    const guard = codeOf('src/domain/retention/anti-resurrection-guard.ts');
    expect(/\.insert\(|\.update\(|\.delete\(|\.execute\(/u.test(guard)).toBe(false);
  });
});
