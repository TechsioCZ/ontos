import type { ShellNavigationItem } from '../../shared/api.ts';
import { AppIdSchema, EntrypointKeySchema, GroupKeySchema, ModuleIdSchema } from '../../shared/api.ts';

/**
 * Navigation section of in-module AI approval pages. They stay in their modules but leave the sidebar: the platform
 * approval layer („Ke schválení“) aggregates their batches and links back to them.
 */
export const moduleAgentApprovalsGroupKey = 'shell.navigation.agent-approvals';

const shellAppId = AppIdSchema.make('shell-super-app');
const shellModuleId = ModuleIdSchema.make('shell-super-app');
const settingsGroupKey = GroupKeySchema.make('shell.navigation.settings');

const platformItem = (
  page: string,
  href: string,
  icon: ShellNavigationItem['icon'],
  label: ShellNavigationItem['label'],
  order: number,
): ShellNavigationItem => ({
  appId: shellAppId,
  enabled: true,
  entrypointKey: EntrypointKeySchema.make(`shell-super-app.page.${page}`),
  groupKey: settingsGroupKey,
  href,
  icon,
  label,
  moduleId: shellModuleId,
  order,
  state: 'active',
  unavailable: false,
  writable: true,
});

const agentApprovalsItem = platformItem(
  'agent-approvals',
  '/sprava/ke-schvaleni',
  'icon-[mdi--clipboard-check-outline]',
  { cs: 'Ke schválení', en: 'Approvals' },
  9000,
);
const agentActivityItem = platformItem(
  'agent-activity',
  '/sprava/aktivita-agentu',
  'icon-[mdi--robot-outline]',
  { cs: 'Aktivita agentů', en: 'Agent activity' },
  9001,
);
const connectedAppsItem = platformItem(
  'connected-apps',
  '/sprava/pripojene-aplikace',
  'icon-[mdi--connection]',
  { cs: 'Připojené aplikace', en: 'Connected apps' },
  9002,
);

/** True when the person can open an in-module AI approval page, whose batches the platform layer also shows. */
export const hasModuleAiApprovals = (navigation: readonly ShellNavigationItem[]): boolean =>
  navigation.some(({ groupKey }) => groupKey === moduleAgentApprovalsGroupKey);

/** One approval inbox: in-module AI approval pages leave the sidebar (Ke schválení shows their batches and links them). */
export const withoutModuleAiApprovals = (navigation: readonly ShellNavigationItem[]): readonly ShellNavigationItem[] =>
  navigation.filter(({ groupKey }) => groupKey !== moduleAgentApprovalsGroupKey);

/** True when a module offers a destination that needs the Shell's people administration. */
export const offersPeopleAdministration = (navigation: readonly ShellNavigationItem[]): boolean =>
  navigation.some(({ requiresCapability }) => requiresCapability === 'people_administration');

/** Destinations needing people administration are listed only to people who may administer people. */
export const withPeopleAdministration = (
  navigation: readonly ShellNavigationItem[],
  canManagePeople: boolean,
): readonly ShellNavigationItem[] =>
  canManagePeople ? navigation : navigation.filter(({ requiresCapability }) => requiresCapability === undefined);

/**
 * Platform pages of the approval layer: shown to company administrators and to people who can open an in-module AI
 * approval page.
 */
export const withAgentPlatformNavigation = (
  items: readonly ShellNavigationItem[],
  show: boolean,
): readonly ShellNavigationItem[] => (show ? [...items, agentApprovalsItem, agentActivityItem] : items);

/** Nastavení › Připojené aplikace: company administrators only (the endpoint enforces it too). */
export const withConnectedAppsNavigation = (
  items: readonly ShellNavigationItem[],
  show: boolean,
): readonly ShellNavigationItem[] => (show ? [...items, connectedAppsItem] : items);
