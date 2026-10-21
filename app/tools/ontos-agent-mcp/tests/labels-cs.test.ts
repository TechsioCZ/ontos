import { describe, expect, it } from '@rstest/core';
import type { CatalogAction } from '../src/capabilities/types.ts';
import {
  commandTitleCs,
  entryDescriptionCs,
  moduleLabelCs,
  readTitleCs,
} from '../src/catalog/labels-cs.ts';

const fakeAction: CatalogAction = {
  kind: 'action',
  id: 'x/command/CreateFoo',
  moduleId: 'x',
  appId: 'x-app',
  actionSlug: 'apply-command',
  commandTag: 'CreateFoo',
  inputSchema: {},
  toolName: 'x_app__create_foo',
  proposable: true,
};

describe('labels-cs', () => {
  it('maps module ids to Czech labels and falls back for unknown ids', () => {
    expect(moduleLabelCs('work.tasks', 'x')).toBe('Úkoly a projekty');
    expect(moduleLabelCs('nope', 'Fallback')).toBe('Fallback');
  });

  it('prefers module-specific command titles and falls back to verb prefixes', () => {
    expect(commandTitleCs('work.tasks', 'CreateTask')).toBe('Vytvořit úkol');
    expect(commandTitleCs('property.leasing', 'Confirm')).toBe('Potvrdit nájem');
    expect(commandTitleCs('x', 'CreateFoo')).toBe('Vytvořit – CreateFoo');
    expect(commandTitleCs('x', 'UnassignFoo')).toBe('Odebrat přiřazení – UnassignFoo');
    expect(commandTitleCs('x', 'Settlement')).toBe('Akce Settlement');
  });

  it('titles records reads with the module label', () => {
    expect(readTitleCs('work.tasks', 'records', 'Úkoly a projekty')).toBe('Přehled: Úkoly a projekty');
  });

  it('describes approval-only actions as proposals', () => {
    expect(entryDescriptionCs(fakeAction, 'Test', 'approval')).toContain('Pouze NÁVRH');
  });
});
