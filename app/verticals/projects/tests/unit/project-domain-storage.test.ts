/* eslint-disable curly -- Compact table-driven schema assertions remain readable. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { Schema } from 'effect';
import {
  ProjectNameSchema,
  ProjectPrefixInputSchema,
  ProjectPrefixSchema,
  ProjectShortTextSchema,
  normalizeProjectPrefix,
} from '../../src/domain/project.ts';
import { projects } from '../../src/db/schema.ts';
import { isProjectDescendant } from '../../src/services/project-persistence.service.ts';

const config = getTableConfig(projects);
const dialect = new PgDialect();

test('normalizes only valid 2-5 ASCII-letter Prefix inputs', () => {
  for (const [input, normalized] of [
    ['ab', 'AB'],
    ['aBcDe', 'ABCDE'],
  ] as const) {
    assert.equal(Schema.is(ProjectPrefixInputSchema)(input), true);
    assert.equal(normalizeProjectPrefix(input), normalized);
    assert.equal(Schema.is(ProjectPrefixSchema)(normalized), true);
  }
  for (const invalid of ['A', 'ABCDEF', 'A1', 'A B', 'ČR'])
    assert.equal(Schema.is(ProjectPrefixInputSchema)(invalid), false);
});

test('requires non-whitespace Name and counts shortText Unicode code points', () => {
  assert.equal(Schema.is(ProjectNameSchema)('Project'), true);
  assert.equal(Schema.is(ProjectNameSchema)('  \n'), false);
  assert.equal(Schema.is(ProjectShortTextSchema)('😀'.repeat(255)), true);
  assert.equal(Schema.is(ProjectShortTextSchema)('😀'.repeat(256)), false);
});

test('owns one tenant-isolated Project table with immutable creation columns and hierarchy FK', () => {
  assert.equal(config.schema, 'projects');
  assert.equal(config.name, 'projects');
  assert.deepEqual(
    config.columns.map((column) => column.name),
    [
      'project_id',
      'tenant_id',
      'prefix',
      'name',
      'short_text',
      'owner_principal_id',
      'parent_project_id',
      'lifecycle_state',
      'created_by_principal_id',
      'created_at',
      'updated_at',
    ],
  );
  for (const name of [
    'project_id',
    'tenant_id',
    'prefix',
    'name',
    'owner_principal_id',
    'lifecycle_state',
    'created_by_principal_id',
    'created_at',
    'updated_at',
  ])
    assert.equal(config.columns.find((column) => column.name === name)?.notNull, true);
  assert.equal(config.foreignKeys[0]?.getName(), 'projects_projects_tenant_parent_fk');
  assert.deepEqual(
    config.foreignKeys[0]?.reference().columns.map((column) => column.name),
    ['tenant_id', 'parent_project_id'],
  );
  const prefixIndex = config.indexes.find(
    (candidate) => candidate.config.name === 'projects_projects_tenant_prefix_uk',
  );
  assert.equal(prefixIndex?.config.unique, true);
  assert.equal(config.policies.length, 4);
  const checks = Object.fromEntries(
    config.checks.map((candidate) => [candidate.name, dialect.sqlToQuery(candidate.value).sql]),
  );
  assert.match(checks['projects_projects_prefix_ck'] ?? '', /A-Z/u);
  assert.match(checks['projects_projects_short_text_ck'] ?? '', /char_length/u);
  assert.match(checks['projects_projects_not_own_parent_ck'] ?? '', /<>/u);
});

test('generated migration forces RLS and owns an independent journal', async () => {
  const migration = await readFile(
    new URL('../../drizzle/0000_last_phil_sheldon.sql', import.meta.url),
    'utf-8',
  );
  const configSource = await readFile(new URL('../../drizzle.config.ts', import.meta.url), 'utf-8');
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/u);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/u);
  assert.match(migration, /projects_projects_tenant_prefix_uk/u);
  assert.match(configSource, /__drizzle_migrations_projects/u);
});

test('detects every descendant while preserving stable subtree identities', () => {
  const hierarchy = [
    { parentProjectId: null, projectId: 'root' },
    { parentProjectId: 'root', projectId: 'child' },
    { parentProjectId: 'child', projectId: 'grandchild' },
    { parentProjectId: null, projectId: 'other' },
  ];
  assert.equal(isProjectDescendant(hierarchy, 'root', 'child'), true);
  assert.equal(isProjectDescendant(hierarchy, 'root', 'grandchild'), true);
  assert.equal(isProjectDescendant(hierarchy, 'child', 'root'), false);
  assert.equal(isProjectDescendant(hierarchy, 'root', 'other'), false);
  assert.deepEqual(
    hierarchy.map((row) => row.projectId),
    ['root', 'child', 'grandchild', 'other'],
  );
});
