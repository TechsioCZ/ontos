import { PgDialect } from 'drizzle-orm/pg-core';
import { expect, it } from 'effect-rstest';

import { demoAccountAuditActionRows } from '../../api/auth/demo-accounts.ts';

const company = '00000000-0000-4000-8000-000000000002';
const dialect = new PgDialect();

it('includes native configure-agent history without a principalKind discriminator, in the exact company', () => {
  const predicate = demoAccountAuditActionRows(company, 'agents');
  if (predicate === undefined) {
    throw new Error('Expected a scoped audit predicate');
  }
  const query = dialect.sqlToQuery(predicate);
  expect(query.params).toEqual([company, 'core.identity.configure-agent', 'core.identity.manage-demo-account']);
  expect(query.sql).toContain('"legal_entity_id" = $1');
  expect(query.sql).toContain("->>'actionKey' = $2) or (");
  expect(query.sql).toContain("->>'principalKind' = 'agent'");
  expect(query.sql).toContain("in ('action.executed', 'action.rejected')");
});

it('keeps native agent configurations out of the people audit branch', () => {
  const predicate = demoAccountAuditActionRows(company, 'people');
  if (predicate === undefined) {
    throw new Error('Expected a scoped audit predicate');
  }
  const query = dialect.sqlToQuery(predicate);
  expect(query.params).toEqual([company, 'core.identity.manage-demo-account']);
  expect(query.sql).toContain('"legal_entity_id" = $1');
  expect(query.sql).toContain("->>'principalKind', 'human') <> 'agent'");
});
