import { expect, it } from 'effect-rstest';

import type { ShellNavigationItem } from '../../../shared/api.ts';
import { AppIdSchema, EntrypointKeySchema, GroupKeySchema, ModuleIdSchema } from '../../../shared/api.ts';
import {
  hasModuleAiApprovals,
  moduleAgentApprovalsGroupKey,
  withAgentPlatformNavigation,
  withConnectedAppsNavigation,
  withoutModuleAiApprovals,
  withPeopleAdministration,
} from '../../../shared/shell-platform-navigation.ts';

const item = (
  page: string,
  groupKey = 'shell.navigation.sales',
  requiresCapability?: ShellNavigationItem['requiresCapability'],
): ShellNavigationItem => ({
  appId: AppIdSchema.make('fixture'),
  enabled: true,
  entrypointKey: EntrypointKeySchema.make(`fixture.module.page.${page}`),
  groupKey: GroupKeySchema.make(groupKey),
  href: `/fixture/${page}`,
  icon: 'icon-[mdi--view-grid-outline]',
  label: { cs: page, en: page },
  moduleId: ModuleIdSchema.make('fixture.module'),
  order: 100,
  requiresCapability,
  state: 'active',
  unavailable: false,
  writable: true,
});

const clients = item('clients');
const moduleApprovals = item('ai', moduleAgentApprovalsGroupKey);
const people = item('people', 'shell.navigation.settings', 'people_administration');

it('moves in-module AI approval pages out of the sidebar and reports that they exist', () => {
  expect(hasModuleAiApprovals([clients, moduleApprovals])).toBe(true);
  expect(hasModuleAiApprovals([clients])).toBe(false);
  expect(withoutModuleAiApprovals([clients, moduleApprovals])).toEqual([clients]);
});

it('lists destinations needing people administration only to people who have it', () => {
  expect(withPeopleAdministration([clients, people], false)).toEqual([clients]);
  expect(withPeopleAdministration([clients, people], true).map(({ href }) => href)).toEqual([
    '/fixture/clients',
    '/sprava/lide-a-role',
  ]);
  expect(withPeopleAdministration([], true).map(({ href }) => href)).toEqual(['/sprava/lide-a-role']);
});

it('adds the platform approval and connection pages to Settings only when shown', () => {
  expect(withAgentPlatformNavigation([clients], false)).toEqual([clients]);
  const platform = withConnectedAppsNavigation(withAgentPlatformNavigation([clients], true), true);
  expect(platform.map(({ href }) => href)).toEqual([
    '/fixture/clients',
    '/sprava/ke-schvaleni',
    '/sprava/aktivita-agentu',
    '/sprava/pripojene-aplikace',
  ]);
  expect(platform.slice(1).map(({ entrypointKey, groupKey }) => [entrypointKey, groupKey])).toEqual([
    ['shell-super-app.page.agent-approvals', 'shell.navigation.settings'],
    ['shell-super-app.page.agent-activity', 'shell.navigation.settings'],
    ['shell-super-app.page.connected-apps', 'shell.navigation.settings'],
  ]);
});
