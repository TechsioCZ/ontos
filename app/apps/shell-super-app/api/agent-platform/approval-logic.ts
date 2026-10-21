/**
 * Pure helpers of the platform approval layer: which modules a person may open or change (from SpiceDB
 * relationships), where the "before" snapshot for a revert plan is read from, key parsing and the Czech revert summary.
 */
import { agentModuleAccessOf } from '@app/core-runtime';
import type { DemoAccountRelationship } from '@app/core-runtime';
import type { AgentRevertResponse } from '@app/shared-contracts/agent-proposals';

type Rec = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Rec => typeof value === 'object' && value !== null && !Array.isArray(value);

export interface ModuleAccessSets {
  /** Module keys (e.g. `demo.crm`) the person can open in the company. */
  readonly access: ReadonlySet<string>;
  /** Module keys the person may change, i.e. approve or revert agent proposals for. */
  readonly write: ReadonlySet<string>;
}

export const moduleAccessSets = (
  relationships: readonly DemoAccountRelationship[],
  legalEntityId: string,
): ModuleAccessSets => {
  const modules = agentModuleAccessOf(relationships, legalEntityId);
  return {
    access: new Set(modules.map(({ moduleId }) => moduleId)),
    write: new Set(modules.filter(({ access }) => access === 'write').map(({ moduleId }) => moduleId)),
  };
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** `core:<uuid>` -> `<uuid>`; anything else (including malformed ids) -> undefined. */
export const parseCoreKey = (key: string): string | undefined => {
  if (!key.startsWith('core:')) {
    return undefined;
  }
  const id = key.slice('core:'.length);
  return UUID.test(id) ? id.toLowerCase() : undefined;
};

export interface RevertBeforeLookup {
  /** Body for POST `<module>/reads/records`. */
  readonly query: Rec;
  /** Picks the target entity (wire JSON) from the records response, or undefined. */
  readonly pick: (body: unknown) => Rec | undefined;
}

const resourceIdOf = (ref: unknown): string | undefined =>
  isRecord(ref) && typeof ref['resourceId'] === 'string' ? ref['resourceId'] : undefined;

const findIn = (body: unknown, listKey: string, matches: (entry: Rec) => boolean): Rec | undefined => {
  if (!isRecord(body)) {
    return undefined;
  }
  const list = body[listKey];
  if (!Array.isArray(list)) {
    return undefined;
  }
  for (const entry of list as readonly unknown[]) {
    if (isRecord(entry) && matches(entry)) {
      return entry;
    }
  }
  return undefined;
};

/** CRM commands that change one client, keyed by the field holding the client id. */
const CRM_CLIENT_ID_FIELD: Readonly<Record<string, string>> = {
  AddContactPerson: 'clientId',
  ArchiveClient: 'id',
  AssignClient: 'clientId',
  LinkClientParty: 'clientId',
  PlanContact: 'clientId',
  RecordVisit: 'clientId',
  RestoreClient: 'id',
  UpdateClient: 'id',
};

/** The CRM client a command changes, or undefined for commands that do not target one client. */
export const crmClientIdOf = (command: Rec): string | undefined => {
  const tag = command['_tag'];
  const field = typeof tag === 'string' ? CRM_CLIENT_ID_FIELD[tag] : undefined;
  const id = field === undefined ? undefined : command[field];
  return typeof id === 'string' && id !== '' ? id : undefined;
};

/** Clients of a CRM records response (already narrowed to what the reader may see). */
export const crmClientsOf = (body: unknown): readonly Rec[] => {
  const state = isRecord(body) ? body['state'] : undefined;
  const clients = isRecord(state) ? state['clients'] : undefined;
  const items = isRecord(clients) ? clients['items'] : undefined;
  return Array.isArray(items) ? items.filter(isRecord) : [];
};

/** Where to read the current state of the entity an approved command changes (undefined: no snapshot needed). */
export const revertBeforeLookup = (appId: string, command: Rec): RevertBeforeLookup | undefined => {
  const tag = command['_tag'];
  if (appId === 'crm') {
    const clientId = crmClientIdOf(command);
    return clientId === undefined
      ? undefined
      : {
          pick: (body) => crmClientsOf(body).find((client) => client['id'] === clientId),
          query: { clientId },
        };
  }
  if (appId === 'work-tasks' && (tag === 'UpdateTask' || tag === 'ChangeTaskState' || tag === 'AssignTask')) {
    const resourceId = resourceIdOf(command['taskRef']);
    return resourceId === undefined
      ? undefined
      : {
          pick: (body) => findIn(body, 'items', (task) => resourceIdOf(task['ref']) === resourceId),
          query: { includeArchived: true, resourceId },
        };
  }
  if (appId === 'merchandise' && (tag === 'ChangePrice' || tag === 'UpdateProduct')) {
    const id = command['id'];
    return typeof id !== 'string'
      ? undefined
      : {
          pick: (body) => findIn(body, 'products', (product) => product['id'] === id),
          query: { view: { productId: id } },
        };
  }
  if (appId === 'property-leasing' && (tag === 'SetRentTerms' || tag === 'UpdateDraft')) {
    const resourceId = resourceIdOf(command['occupancyRef']);
    return resourceId === undefined
      ? undefined
      : {
          pick: (body) =>
            findIn(body, 'occupancies', (occupancy) => resourceIdOf(occupancy['occupancyRef']) === resourceId),
          query: { resourceId },
        };
  }
  return undefined;
};

export interface RevertCounts {
  /** Changes left alone because someone changed the record after the approval. */
  readonly changed: number;
  readonly failed: number;
  readonly reverted: number;
  readonly unavailable: number;
}

/** Czech summary of one „Vrátit vše“ run. */
export const revertResultMessage = ({ changed, failed, reverted, unavailable }: RevertCounts): AgentRevertResponse => {
  if (reverted === 0 && failed === 0 && unavailable === 0 && changed === 0) {
    return { message: 'V dávce není žádná provedená změna k vrácení.', outcome: 'failed' };
  }
  const parts = [`Vráceno změn: ${reverted}.`];
  if (changed > 0) {
    parts.push(`Záznam se mezitím změnil, ponecháno beze změny: ${changed}.`);
  }
  if (unavailable > 0) {
    parts.push(`Nelze automaticky vrátit: ${unavailable}.`);
  }
  if (failed > 0) {
    parts.push(`Vrácení se nepodařilo: ${failed}.`);
  }
  const outcome =
    reverted === 0 ? 'failed' : failed === 0 && unavailable === 0 && changed === 0 ? 'reverted' : 'partial';
  return { message: parts.join(' '), outcome };
};

/** Merchandise commands that change the catalog or prices (records `canManageCatalog`) or edit orders. */
const MERCHANDISE_CATALOG_COMMANDS: ReadonlySet<string> = new Set([
  'ArchiveDemoProduct',
  'BulkUpdateProducts',
  'ChangePrice',
  'CreateProduct',
  'UpdateCategory',
  'UpdateProduct',
]);

/** The record a command changes, read as one person (`available: false` when the module read failed). */
export type TargetRead =
  | { readonly needed: false }
  | {
      readonly available: boolean;
      readonly body: unknown;
      readonly needed: true;
      readonly value: Rec | undefined;
    };

export type ApproverCheck =
  | { readonly ok: true }
  /** `hidden`: the person may not even see the record, so the proposal is not shown to them at all. */
  | { readonly hidden: boolean; readonly ok: false; readonly reason: string };

const ALLOWED: ApproverCheck = { ok: true };
const blocked = (reason: string, hidden = false): ApproverCheck => ({ hidden, ok: false, reason });

/**
 * Can this person carry out the stored command? Approval runs as the approver, so a person whose module read says
 * they cannot write, cannot run this command, or cannot see this record must not get the approve button (the
 * proposal would only fail and be used up). `moduleBody` is the person's records read of the module (undefined when
 * it could not be read; the module itself then decides), `target` the record the command changes, read as them.
 */
export const approverCheck = (
  appId: string,
  command: Rec,
  moduleBody: unknown,
  target: TargetRead = { needed: false },
): ApproverCheck => {
  if (target.needed && target.available && target.value === undefined) {
    return blocked('Záznam, který návrh mění, nevidíte nebo už neexistuje.', true);
  }
  if (!isRecord(moduleBody)) {
    return ALLOWED;
  }
  const tag = typeof command['_tag'] === 'string' ? command['_tag'] : '';
  if (appId === 'crm') {
    const viewer = isRecord(moduleBody['viewer']) ? moduleBody['viewer'] : {};
    const clientId = crmClientIdOf(command);
    const client =
      clientId === undefined ? undefined : crmClientsOf(moduleBody).find((entry) => entry['id'] === clientId);
    if (clientId !== undefined && client === undefined) {
      return blocked('Tohoto klienta v CRM nevidíte.', true);
    }
    const writeAll = viewer['writeAll'] === true;
    const owns =
      client !== undefined &&
      typeof viewer['salespersonId'] === 'string' &&
      client['ownerSalespersonId'] === viewer['salespersonId'];
    if (tag === 'AssignClient' && viewer['assign'] !== true) {
      return blocked('Přidělit klienta jinému obchodníkovi může jen správce nebo vedoucí.');
    }
    if (
      client !== undefined
        ? !(writeAll || (viewer['writeAssigned'] === true && owns))
        : !writeAll && viewer['writeAssigned'] !== true
    ) {
      return blocked('Tohoto klienta nemůžete upravovat, změnu schválí jeho obchodník nebo vedoucí.');
    }
    return ALLOWED;
  }
  if (moduleBody['canWrite'] === false) {
    return blocked('V tomto modulu nemáte oprávnění k zápisu.');
  }
  if (appId === 'merchandise') {
    if (MERCHANDISE_CATALOG_COMMANDS.has(tag) && moduleBody['canManageCatalog'] === false) {
      return blocked('Změny katalogu a cen schvaluje jen člověk se správou katalogu.');
    }
    if (tag === 'EditOrder' && moduleBody['canEditOrders'] === false) {
      return blocked('Úpravy objednávek schvaluje jen člověk s oprávněním k úpravám objednávek.');
    }
  }
  return ALLOWED;
};

/** Czech text for an English framework problem detail (also used for failures stored before this mapping). */
export const czechModuleFailure = (detail: string, status?: number): string => {
  if (status === 409 || /revision|conflict|changed/iu.test(detail)) {
    return 'Záznam se od návrhu změnil nebo už byl vyřízen. Obnovte seznam; zastaralý návrh zamítněte.';
  }
  if (status === 403 || /forbidden|denied|not allowed|permission/iu.test(detail)) {
    return 'K této změně nemáte v modulu oprávnění.';
  }
  if (status === 404 || /not found/iu.test(detail)) {
    return 'Záznam, který návrh mění, nebyl nalezen, nebo k němu nemáte přístup.';
  }
  if (status === 400 || status === 422 || /invalid|malformed/iu.test(detail)) {
    return 'Modul návrh odmítl jako neplatný (údaje neodpovídají jeho pravidlům). Návrh zamítněte a požádejte o nový.';
  }
  if (status !== undefined && status >= 500) {
    return 'Modul teď neodpovídá. Zkuste to prosím za chvíli znovu.';
  }
  return 'Modul změnu odmítl. Návrh zamítněte nebo to zkuste později.';
};

/** English (plain ASCII) problem texts come from the framework; Czech module texts are shown as they are. */
export const isGenericProblemText = (text: string): boolean => /^[\u0020-\u007E]*$/u.test(text);
