import { DateTime, Option, Schema } from 'effect';
/** Pure helpers of the "Připojené aplikace" screens: labels, access drafts and the connect guide. */
import type {
  AgentWritePolicy,
  ConnectionClientKind,
  ConnectionStatus,
  ConnectionSummary,
  ConnectionUpdateRequest,
} from '@app/shared-contracts/agent-access';

import { AgentAccessGrantIdSchema } from '@app/shared-contracts/agent-access';
import { AgentModuleKeySchema } from '@app/shared-contracts/agent-proposals';

import type { ConnectionsFailure } from './connected-apps-client.ts';

export const writePolicyLabel = {
  approval: 'Ke schválení',
  direct: 'Přímo',
  read_only: 'Jen čtení',
} satisfies Record<AgentWritePolicy, string>;

export const writePolicyBadge = {
  approval: 'info',
  direct: 'warning',
  read_only: 'outline',
} satisfies Record<AgentWritePolicy, 'info' | 'outline' | 'warning'>;

export const clientKindLabel = {
  cimd: 'Ověřená aplikace',
  dcr: 'Registrovaná aplikace',
  loopback: 'Běží na tomto počítači',
} satisfies Record<ConnectionClientKind, string>;

export const statusLabel = {
  active: 'Aktivní',
  denied: 'Zamítnuté',
  revoked: 'Odpojené',
  superseded: 'Nahrazené',
} satisfies Record<ConnectionStatus, string>;

export const statusBadge = {
  active: 'success',
  denied: 'outline',
  revoked: 'outline',
  superseded: 'outline',
} satisfies Record<ConnectionStatus, 'outline' | 'success'>;

const revokeReasonLabel = new Map(
  Object.entries({
    admin: 'Odpojil(a) správce firmy',
    agent_disabled: 'Agent byl vypnut',
    operator_removed: 'Osoba už nesmí agenta připojit',
    password_changed: 'Po změně hesla',
    superseded: 'Nahrazeno novým připojením',
    user: 'Odpojil(a) uživatel',
    user_disabled: 'Účet uživatele byl deaktivován',
  }),
);

const connectionTimeFormat = new Intl.DateTimeFormat('cs-CZ', { dateStyle: 'medium', timeStyle: 'short' });

export const formatWhen = (time: DateTime.Utc | Option.Option<DateTime.Utc>): string =>
  Option.match(Option.isOption(time) ? time : Option.some(time), {
    onNone: () => 'Zatím nepoužito',
    onSome: (value) => DateTime.formatIntl(value, connectionTimeFormat),
  });

interface EndedConnectionDetail {
  readonly label: string;
  readonly note: string | null;
  readonly when: string;
}

/** Why and when a connection stopped (admin list); undefined while active. */
export const endedDetail = (c: ConnectionSummary): EndedConnectionDetail | undefined => {
  if (c.status === 'active') {
    return undefined;
  }
  const fallback = c.status === 'denied' ? 'Souhlas byl zamítnut' : 'Bez uvedeného důvodu';
  return {
    label:
      Option.getOrUndefined(Option.map((reason: string) => revokeReasonLabel.get(reason))(c.revokeReason)) ?? fallback,
    note: Option.contains(c.revokeReason, 'admin') ? Option.getOrNull(c.revokeNote) : null,
    when: Option.match(c.revokedAt, { onNone: () => '', onSome: (time) => formatWhen(time) }),
  };
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

const failureMessages = {
  conflict: 'Připojení se mezitím změnilo.',
  error: 'Služba je nedostupná. Zkuste to znovu.',
  forbidden: 'Tuto akci nemůžete provést.',
  invalid: 'Údaje nejsou platné.',
  notFound: 'Připojení už neexistuje. Načtěte stránku znovu.',
  signedOut: 'Přihlášení vypršelo. Přihlaste se znovu.',
} satisfies Record<ConnectionsFailure, string>;

export const failureText = (reason: ConnectionsFailure, detail: string | null): string => {
  if (detail !== null) {
    return detail;
  }
  return failureMessages[reason];
};

/** Answers meaning the row is stale: the connection was revoked or replaced meanwhile, so the list reloads. */
export const isStale = (reason: ConnectionsFailure): boolean => reason === 'conflict' || reason === 'notFound';

export const ModuleChoiceSchema = Schema.Literals(['none', 'read', 'write']);
export type ModuleChoice = typeof ModuleChoiceSchema.Type;

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

const policyOrder = ['read_only', 'approval', 'direct'] satisfies readonly AgentWritePolicy[];

const policyRank = { approval: 1, direct: 2, read_only: 0 } satisfies Record<AgentWritePolicy, number>;

interface PolicyPresentation {
  readonly description: string;
  readonly label: string;
}

const policyPresentation = {
  approval: {
    description: 'Každou změnu nejdřív schválí člověk v Nastavení › Ke schválení.',
    label: 'Navrhovat změny ke schválení (doporučeno)',
  },
  direct: {
    description: 'Změny se projeví hned, jako byste je udělal(a) vy.',
    label: 'Provádět změny přímo',
  },
  read_only: { description: '', label: 'Jen čtení' },
} satisfies Record<AgentWritePolicy, PolicyPresentation>;

/** Highest write policy the panel may offer: the approved one, never above the live rights. */
const policyCeiling = (c: ConnectionSummary): AgentWritePolicy =>
  policyRank[c.granted.writePolicy] < policyRank[c.limits.maxWritePolicy]
    ? c.granted.writePolicy
    : c.limits.maxWritePolicy;

/** Panel description: why nothing above the approved access can be chosen. */
export const widenHint =
  'Přístup můžete jen zúžit. Pro větší přístup aplikaci odpojte a připojte znovu. Změna platí hned od dalšího požadavku, bez nového přihlášení.';

/** Why an option is greyed out; null when only the approved grant limits it (the panel says so once). */
const policyDisabledReason = (c: ConnectionSummary, value: AgentWritePolicy): string | null => {
  if (policyRank[value] > policyRank[c.granted.writePolicy]) {
    return null;
  }
  if (c.acting.kind === 'human') {
    return 'Víc vaše oprávnění nedovolují.';
  }
  if (c.limits.maxWritePolicy === 'approval') {
    return 'Agent smí jen navrhovat změny (nastavení agenta).';
  }
  return 'Agent smí jen číst (nastavení agenta).';
};

interface PolicyChoice {
  readonly description: string;
  readonly disabled: boolean;
  readonly disabledReason: string | null;
  readonly label: string;
  readonly value: AgentWritePolicy;
}

export const policyChoices = (c: ConnectionSummary): readonly PolicyChoice[] =>
  policyOrder.map((value) => {
    const disabled = policyRank[value] > policyRank[policyCeiling(c)];
    return {
      description: policyPresentation[value].description,
      disabled,
      disabledReason: disabled ? policyDisabledReason(c, value) : null,
      label: policyPresentation[value].label,
      value,
    };
  });

/**
 * Modules the panel offers, each with what may still be ticked: within the approved grant (all live modules when it
 * was approved for everything) and within the live rights.
 */
interface ConnectionModuleChoice {
  readonly canRead: boolean;
  readonly canWrite: boolean;
  readonly label: string;
  readonly moduleId: string;
}

export const moduleChoices = (c: ConnectionSummary): readonly ConnectionModuleChoice[] =>
  c.limits.modules.flatMap((limit) => {
    const approved = c.allModules
      ? { access: 'write' as const }
      : c.granted.modules.find((module) => module.moduleId === limit.moduleId);
    if (approved === undefined) {
      return [];
    }
    return [
      {
        canRead: limit.read,
        canWrite: limit.write && approved.access === 'write',
        label: limit.label,
        moduleId: limit.moduleId,
      },
    ];
  });

export const draftProblem = (draft: EditDraft): string | undefined => {
  const nothingChosen = Object.values(draft.modules).every((choice) => choice === 'none');
  return !draft.allModules && nothingChosen ? 'Vyberte alespoň jeden modul.' : undefined;
};

export const draftToRequest = (grantId: string, draft: EditDraft): ConnectionUpdateRequest => ({
  allModules: draft.allModules,
  grantId: AgentAccessGrantIdSchema.make(grantId),
  modules: draft.allModules
    ? []
    : Object.entries(draft.modules)
        .flatMap(([moduleId, choice]) =>
          choice === 'none' ? [] : [{ access: choice, moduleId: AgentModuleKeySchema.make(moduleId) }],
        )
        .toSorted((a, b) => a.moduleId.localeCompare(b.moduleId)),
  writePolicy: draft.writePolicy,
});
