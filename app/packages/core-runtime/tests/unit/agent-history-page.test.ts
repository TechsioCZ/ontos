import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { expect, it } from 'effect-rstest';

import { agentHistoryPageSql } from '../../src/db/agent-history-page.ts';

const dialect = new PgDialect();
const source = sql`history`;
const at = '2026-10-23T10:00:00.000Z';

it('bounds native queue batches and their complete command sets in PostgreSQL', () => {
  const query = dialect.sqlToQuery(
    agentHistoryPageSql(source, 'crm', {
      batchKey: 'legacy:crm:batch-1',
      cursor: { at, id: 'legacy:crm:batch-2' },
      mode: 'queue',
      pendingOnly: true,
    }),
  );
  expect(query.params).toContain(31);
  expect(query.params).toContain(31 * 50);
  expect(query.params).toContain('legacy:crm:batch-1');
  expect(query.params).toContain('legacy:crm:batch-2');
  expect(query.params).toContain(at);
  expect(query.sql).toContain("c->>'status' = 'pending'");
  expect(query.sql).toContain("date_trunc('milliseconds'");
  expect(query.sql).toContain('collate "C"');
  expect(query.sql.indexOf('where')).toBeLessThan(query.sql.indexOf('limit'));
});

it('pages native activity by its latest eligible event, not the original proposal time', () => {
  const query = dialect.sqlToQuery(
    agentHistoryPageSql(source, 'merchandise', {
      agentPrincipalId: '72000000-0000-4000-8000-000000000090',
      cursor: { at, id: 'decision:legacy:merchandise:change-1' },
      kind: 'decision',
      mode: 'activity',
    }),
  );
  expect(query.sql).toContain('join lateral');
  expect(query.sql).toContain("c->>'status' <> 'pending'");
  expect(query.sql).toContain("c->>'decidedAt'");
  expect(query.sql).toContain("c->>'revertedAt'");
  expect(query.sql).toContain(
    'order by date_trunc(\'milliseconds\', e.at::timestamptz) desc, e.id collate "C" desc limit',
  );
  expect(query.params).toContain('decision:legacy:merchandise:change-1');
  expect(query.params).toContain(false);
  expect(query.params).toContain(true);
  expect(query.params).toContain(31);
});
