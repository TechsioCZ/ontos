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

/** `core:<id>` -> `<id>`; anything else -> undefined. */
export const parseCoreKey = (key: string): string | undefined => {
  if (!key.startsWith('core:')) {
    return undefined;
  }
  const id = key.slice('core:'.length);
  return id === '' ? undefined : id;
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

/** Where to read the current state of the entity an approved command changes (undefined: no snapshot needed). */
export const revertBeforeLookup = (appId: string, command: Rec): RevertBeforeLookup | undefined => {
  const tag = command['_tag'];
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
  readonly failed: number;
  readonly reverted: number;
  readonly unavailable: number;
}

/** Czech summary of one „Vrátit vše“ run. */
export const revertResultMessage = ({ failed, reverted, unavailable }: RevertCounts): AgentRevertResponse => {
  if (reverted === 0 && failed === 0 && unavailable === 0) {
    return { message: 'V dávce není žádná provedená změna k vrácení.', outcome: 'failed' };
  }
  const parts = [`Vráceno změn: ${reverted}.`];
  if (unavailable > 0) {
    parts.push(`Nelze automaticky vrátit: ${unavailable}.`);
  }
  if (failed > 0) {
    parts.push(`Vrácení se nepodařilo: ${failed}.`);
  }
  const outcome = reverted === 0 ? 'failed' : failed === 0 && unavailable === 0 ? 'reverted' : 'partial';
  return { message: parts.join(' '), outcome };
};
