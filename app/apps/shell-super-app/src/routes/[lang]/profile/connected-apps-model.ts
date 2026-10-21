// @effect-diagnostics globalDate:off -- Browser UI boundary: formats server timestamps for display. expires: 2027-03-31.
/** Pure helpers of the "Připojené aplikace" screens: labels, access drafts and the connect guide. */
import type {
  AgentWritePolicy,
  ConnectionClientKind,
  ConnectionStatus,
  ConnectionSummary,
  ConnectionUpdateRequest,
} from '@app/shared-contracts/agent-access';

import type { ConnectionsFailure } from './connected-apps-client.ts';

export const writePolicyLabel: Record<AgentWritePolicy, string> = {
  approval: 'Ke schválení',
  direct: 'Přímo',
  read_only: 'Jen čtení',
};

export const writePolicyBadge: Record<AgentWritePolicy, 'info' | 'outline' | 'warning'> = {
  approval: 'info',
  direct: 'warning',
  read_only: 'outline',
};

export const clientKindLabel: Record<ConnectionClientKind, string> = {
  cimd: 'Ověřená aplikace',
  dcr: 'Registrovaná aplikace',
  loopback: 'Běží na tomto počítači',
};

export const statusLabel: Record<ConnectionStatus, string> = {
  active: 'Aktivní',
  denied: 'Zamítnuté',
  revoked: 'Odpojené',
  superseded: 'Nahrazené',
};

export const statusBadge: Record<ConnectionStatus, 'outline' | 'success'> = {
  active: 'success',
  denied: 'outline',
  revoked: 'outline',
  superseded: 'outline',
};

/** Who acts through the connection, as the person sees it in their own list. */
export const actingLabel = (c: ConnectionSummary): string =>
  c.acting.kind === 'human' ? 'Já' : `Agent ${c.acting.displayName}`;

/** Who acts through the connection, as an administrator sees it. */
export const actingAdminLabel = (c: ConnectionSummary): string =>
  c.acting.kind === 'human' ? c.acting.displayName : `${c.acting.displayName} (agent)`;

export const accessSummary = (c: ConnectionSummary): string => {
  if (c.allModules) {
    return 'Vše';
  }
  if (c.modules.length === 0) {
    return 'Nic';
  }
  const labels = c.modules
    .slice(0, 3)
    .map((module) => module.label)
    .join(', ');
  return c.modules.length > 3 ? `${labels} a další ${c.modules.length - 3}` : labels;
};

export const formatWhen = (iso: string | null): string => {
  if (iso === null) {
    return 'Zatím nepoužito';
  }
  return new Intl.DateTimeFormat('cs-CZ', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
};

const failureMessages: Record<ConnectionsFailure, string> = {
  conflict: 'Mezitím se něco změnilo. Načtěte stránku znovu.',
  error: 'Služba je nedostupná. Zkuste to znovu.',
  forbidden: 'Tuto akci nemůžete provést.',
  invalid: 'Údaje nejsou platné.',
  notFound: 'Připojení už neexistuje. Načtěte stránku znovu.',
  signedOut: 'Přihlášení vypršelo. Přihlaste se znovu.',
};

export const failureText = (reason: ConnectionsFailure, detail: string | null): string => {
  if (detail !== null) {
    return detail;
  }
  return failureMessages[reason];
};

export type ModuleChoice = 'none' | 'read' | 'write';

export interface EditDraft {
  readonly allModules: boolean;
  readonly modules: Readonly<Record<string, ModuleChoice>>;
  readonly writePolicy: AgentWritePolicy;
}

const moduleChoiceOf = (c: ConnectionSummary, moduleId: string): ModuleChoice => {
  const granted = c.modules.find((module) => module.moduleId === moduleId);
  if (granted !== undefined && granted.write) {
    return 'write';
  }
  if (granted !== undefined && granted.read) {
    return 'read';
  }
  return 'none';
};

export const draftFromConnection = (c: ConnectionSummary): EditDraft => ({
  allModules: c.allModules,
  modules: Object.fromEntries(c.limits.modules.map((limit) => [limit.moduleId, moduleChoiceOf(c, limit.moduleId)])),
  writePolicy: c.writePolicy,
});

export const setModuleChoice = (draft: EditDraft, moduleId: string, choice: ModuleChoice): EditDraft => ({
  ...draft,
  modules: { ...draft.modules, [moduleId]: choice },
});

const policyOrder: readonly AgentWritePolicy[] = ['read_only', 'approval', 'direct'];

const policyRank: Record<AgentWritePolicy, number> = { approval: 1, direct: 2, read_only: 0 };

const policyPresentation: Record<AgentWritePolicy, { readonly label: string; readonly description: string }> = {
  approval: {
    description: 'Každou změnu nejdřív schválí člověk v Nastavení › Ke schválení.',
    label: 'Navrhovat změny ke schválení (doporučeno)',
  },
  direct: {
    description: 'Změny se projeví hned, jako byste je udělal(a) vy.',
    label: 'Provádět změny přímo',
  },
  read_only: { description: '', label: 'Jen čtení' },
};

const policyDisabledReason = (c: ConnectionSummary): string => {
  if (c.acting.kind === 'human') {
    return 'Víc vaše oprávnění nedovolují.';
  }
  if (c.limits.maxWritePolicy === 'approval') {
    return 'Agent smí jen navrhovat změny (nastavení agenta).';
  }
  return 'Agent smí jen číst (nastavení agenta).';
};

export const policyChoices = (
  c: ConnectionSummary,
): readonly {
  readonly value: AgentWritePolicy;
  readonly label: string;
  readonly description: string;
  readonly disabled: boolean;
  readonly disabledReason: string | null;
}[] =>
  policyOrder.map((value) => {
    const disabled = policyRank[value] > policyRank[c.limits.maxWritePolicy];
    return {
      description: policyPresentation[value].description,
      disabled,
      disabledReason: disabled ? policyDisabledReason(c) : null,
      label: policyPresentation[value].label,
      value,
    };
  });

export const draftProblem = (draft: EditDraft): string | undefined => {
  const nothingChosen = Object.values(draft.modules).every((choice) => choice === 'none');
  return !draft.allModules && nothingChosen ? 'Vyberte alespoň jeden modul.' : undefined;
};

export const draftToRequest = (grantId: string, draft: EditDraft): ConnectionUpdateRequest => ({
  allModules: draft.allModules,
  grantId,
  modules: draft.allModules
    ? []
    : Object.entries(draft.modules)
        .flatMap(([moduleId, choice]) => (choice === 'none' ? [] : [{ access: choice, moduleId }]))
        .sort((a, b) => a.moduleId.localeCompare(b.moduleId)),
  writePolicy: draft.writePolicy,
});

export const connectGuide = (
  mcpUrl: string,
): readonly {
  readonly id: string;
  readonly title: string;
  readonly text: string;
  readonly command: string | null;
}[] => [
  {
    command: null,
    id: 'chatgpt',
    text: 'Nastavení › Aplikace a konektory › Přidat vlastní MCP server › URL › OAuth.',
    title: 'ChatGPT',
  },
  {
    command: null,
    id: 'claude',
    text: 'Nastavení › Konektory › Přidat vlastní konektor › URL.',
    title: 'Claude',
  },
  {
    command: `claude mcp add --transport http ontos ${mcpUrl}`,
    id: 'claude-code',
    text: 'Spusťte příkaz v terminálu a pak v Claude Code zadejte /mcp › Authenticate.',
    title: 'Claude Code',
  },
  {
    command: null,
    id: 'vscode',
    text: 'Přidejte MCP server podle URL a přihlaste se v prohlížeči.',
    title: 'VS Code',
  },
  {
    command: null,
    id: 'cursor',
    text: 'Přidejte MCP server podle URL a přihlaste se v prohlížeči.',
    title: 'Cursor',
  },
];

export const localDemoNote =
  'ChatGPT a Claude na webu se k adrese localhost nepřipojí; potřebují veřejnou adresu HTTPS. Na lokálním demu použijte Claude Code nebo VS Code.';
