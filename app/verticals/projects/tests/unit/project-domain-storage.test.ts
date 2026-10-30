import { getTableConfig } from 'drizzle-orm/pg-core';
import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import {
  ProjectNameSchema,
  ProjectPrefixInputSchema,
  ProjectPrefixSchema,
  ProjectShortTextSchema,
  normalizeProjectPrefix,
} from '../../shared/domain/project.ts';
import { projects } from '../../src/db/schema.ts';
import { isProjectDescendant } from '../../src/services/project-persistence.service.ts';

it.each(['A', 'ABCDEF', 'A1', 'A B', 'A-B', 'ČR'])('rejects invalid Prefix %s', (value) => {
  expect(Schema.is(ProjectPrefixInputSchema)(value)).toBe(false);
});
it.each(['ab', 'aBcDe'])('normalizes a valid Prefix %s', (value) => {
  expect(Schema.is(ProjectPrefixInputSchema)(value)).toBe(true);
  expect(Schema.is(ProjectPrefixSchema)(normalizeProjectPrefix(value))).toBe(true);
});
it('accepts 255 Unicode code points and rejects 256, and requires a non-whitespace Name', () => {
  expect(Schema.is(ProjectShortTextSchema)('😀'.repeat(255))).toBe(true);
  expect(Schema.is(ProjectShortTextSchema)('😀'.repeat(256))).toBe(false);
  expect(Schema.is(ProjectNameSchema)(' \n')).toBe(false);
});
it('owns a tenant-scoped Project table and a composite same-tenant hierarchy reference', () => {
  const config = getTableConfig(projects);
  expect(config.schema).toBe('projects');
  expect(config.name).toBe('projects');
  expect(config.policies).toHaveLength(4);
  expect(config.foreignKeys[0]?.reference().columns.map((column) => column.name)).toEqual([
    'tenant_id',
    'parent_project_id',
  ]);
  expect(
    config.indexes.find(({ config: index }) => index.name === 'projects_projects_tenant_prefix_uk')?.config.unique,
  ).toBe(true);
});
it('finds indirect descendants without changing subtree identities', () => {
  const hierarchy = [
    { parentProjectId: null, projectId: 'root' },
    { parentProjectId: 'root', projectId: 'child' },
    { parentProjectId: 'child', projectId: 'leaf' },
  ];
  expect(isProjectDescendant(hierarchy, 'root', 'leaf')).toBe(true);
  expect(isProjectDescendant(hierarchy, 'leaf', 'root')).toBe(false);
});
