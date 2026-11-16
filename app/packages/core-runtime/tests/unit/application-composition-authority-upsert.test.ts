import { drizzle } from 'drizzle-orm/node-postgres';
import { DateTime, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { applicationCompositionAuthority } from '../../src/db/schema.ts';
import { ActiveApplicationCompositionSnapshotSchema } from '../../src/modules/active-application-composition.ts';
import {
  applicationCompositionAuthorityUpsert,
  revisionActivatedAtMicros,
} from '../../src/modules/application-composition-authority.ts';

const REVISION = 'a'.repeat(64);
const OTHER_REVISION = 'b'.repeat(64);
const at = (iso: string) => DateTime.toDateUtc(DateTime.makeUnsafe(iso));

const snapshot = Schema.decodeSync(ActiveApplicationCompositionSnapshotSchema)({
  composition: {
    modules: [],
    revision: REVISION,
    schemaVersion: '2',
    shell: {
      contributionAbi: { id: 'ontos.shell-contributions', version: '1' },
      coreCapabilities: [],
      deployment: { appId: 'shell-super-app', buildMarker: 'shell-build-1' },
      federationManifest: { sha256: 'a'.repeat(64), url: 'https://shell.example/mf-manifest.json' },
      runtimeContract: { sha256: 'b'.repeat(64), url: 'https://shell.example/ontos-shell-runtime.json' },
      sharedSingletons: [],
    },
  },
  observedAt: '2026-11-15T10:00:00.000Z',
  validUntil: '2026-11-15T16:00:00.000Z',
});

/** The row as the writer reads it: through the Date-valued schema, so its activation is cut to milliseconds. */
const rowRead = (
  revision: string,
  phase: 'active' | 'draining',
  durableWorkAdmission: 'closed' | 'open',
): typeof applicationCompositionAuthority.$inferSelect => ({
  authorityKey: 'active',
  durableWorkAdmission,
  phase,
  revision,
  revisionActivatedAt: at('2026-11-15T09:00:00.123Z'),
  subscriptionsJson: [],
  updatedAt: at('2026-11-15T09:30:00.000Z'),
  validUntil: at('2026-11-15T15:00:00.000Z'),
});

/** The statement exactly as the publication builds it (with its RETURNING), rendered offline. */
const publicationStatement = (current?: typeof applicationCompositionAuthority.$inferSelect) => {
  const upsert = applicationCompositionAuthorityUpsert(current, snapshot, []);
  const statement = drizzle
    .mock()
    .insert(applicationCompositionAuthority)
    .values(upsert.values)
    .onConflictDoUpdate({ set: upsert.set, target: applicationCompositionAuthority.authorityKey })
    .returning({ activatedAtMicros: revisionActivatedAtMicros, revision: applicationCompositionAuthority.revision })
    .toSQL();
  const [insert = '', rest = ''] = statement.sql.split(' on conflict ');
  const [conflictUpdate = '', returning = ''] = rest.split(' returning ');
  const { columns = '', values = '' } = /\((?<columns>[^)]*)\) values \((?<values>.*)\)$/u.exec(insert)?.groups ?? {};
  const inserted = new Map(columns.split(', ').map((column, index) => [column, values.split(', ')[index]] as const));
  return { conflictUpdate, inserted, params: statement.params, returning };
};

describe('the authority row one publication writes', () => {
  it('never writes revision_activated_at when it renews the revision that holds the row', () => {
    // PostgreSQL keeps the exact moment (microseconds); the value read back through the Date schema holds milliseconds.
    const renewal = publicationStatement(rowRead(REVISION, 'draining', 'closed'));
    expect(renewal.conflictUpdate).not.toContain('"revision_activated_at"');
    // The activation it read (09:00:00.123) is never sent back; the lease it publishes is.
    const sent = JSON.stringify(renewal.params);
    expect(sent).not.toContain('09:00:00.123');
    expect(sent).toContain('16:00:00');
    expect(renewal.params).toContain('closed');
    expect(renewal.params).toContain('draining');
  });

  it('takes the row now, on the database clock, for another revision and for the first row', () => {
    const replacement = publicationStatement(rowRead(OTHER_REVISION, 'draining', 'open'));
    expect(replacement.conflictUpdate).toContain('"revision_activated_at" = clock_timestamp()');
    expect(replacement.params).toContain('active');
    expect(publicationStatement().inserted.get('"revision_activated_at"')).toBe('clock_timestamp()');
  });

  it('returns the exact activation the row holds after the write, as integer microseconds in text', () => {
    for (const statement of [publicationStatement(), publicationStatement(rowRead(REVISION, 'active', 'open'))]) {
      expect(statement.returning).toBe(
        '(extract(epoch from "revision_activated_at") * 1000000)::bigint::text, "revision"',
      );
    }
  });
});
