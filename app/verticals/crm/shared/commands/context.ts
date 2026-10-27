// Shared command plumbing (owned by crm-scaffold). Area reducers receive a CommandContext and return a
// CommandChange or fail with one of the CRM domain errors via the helpers below.
import { Effect, Schema } from 'effect';
import { canWriteAnything, canWriteClient } from '../domain/access.ts';
import type { CrmViewer } from '../domain/access.ts';

import { EntityIdSchema, makeEntityId } from '../domain/common.ts';
import type { IsoTimeSchema, EntityId } from '../domain/common.ts';

import type { Client } from '../domain/clients.ts';
import type { CrmState } from '../domain/state.ts';
import { CrmLifecycleConflict } from '../errors/crm-lifecycle-conflict.ts';
import { CrmNotFound } from '../errors/crm-not-found.ts';
import { CrmPermissionDenied } from '../errors/crm-permission-denied.ts';
import { CrmReferenceIneligible } from '../errors/crm-reference-ineligible.ts';

/** A Counterparty the server read from Party Registry for this command (CUSTOMER of the scoped company). */
export const VerifiedPartySchema = Schema.Struct({
  counterpartyId: EntityIdSchema,
  displayName: Schema.optionalKey(Schema.String),
  partyId: EntityIdSchema,
});
export type VerifiedParty = typeof VerifiedPartySchema.Type;

export interface CommandContext {
  /** Core action invocation id; unique per command. */
  readonly invocationId: string;
  /** ISO timestamp of the command. */
  readonly now: typeof IsoTimeSchema.Type;
  /**
   * Party Registry links verified by the server before the reducer runs, keyed by counterpartyId. A command that
   * carries a partyRef without a verified entry is refused (the browser's claim alone is never stored).
   */
  readonly verifiedParties?: ReadonlyMap<string, VerifiedParty>;
  readonly viewer: CrmViewer;
}

export interface CommandChange {
  /** Ids created or touched, returned to the caller (first = primary entity). */
  readonly entityIds: readonly EntityId[];
  readonly state: CrmState;
}

export type CrmCommandFailure = CrmLifecycleConflict | CrmNotFound | CrmPermissionDenied | CrmReferenceIneligible;
export type Reducer<C> = (
  state: CrmState,
  command: C,
  context: CommandContext,
) => Effect.Effect<CommandChange, CrmCommandFailure>;

/** Deterministic new id for the n-th entity a command creates. */
export const newId = (context: CommandContext, suffix: string | number = 0) =>
  makeEntityId(`${context.invocationId}-${suffix}`);

export const notFound = (reason: string) => Effect.fail(new CrmNotFound({ code: 'crm_not_found', reason }));
export const denied = (reason: string) =>
  Effect.fail(new CrmPermissionDenied({ code: 'crm_permission_denied', reason }));
export const conflict = (reason: string) =>
  Effect.fail(new CrmLifecycleConflict({ code: 'crm_lifecycle_conflict', reason }));
export const invalid = (reason: string) =>
  Effect.fail(new CrmReferenceIneligible({ code: 'crm_reference_ineligible', reason }));

/**
 * The client a command touches, if the viewer may write it. A client the viewer may not see answers
 * "not found" (no existence leak through foreign ids, C00).
 */
export const requireWritableClient = (state: CrmState, context: CommandContext, clientId: string) => {
  const client: Client | undefined = state.clients.items.find((entry) => entry.id === clientId);
  if (client === undefined || !canWriteClient(context.viewer, client)) {
    return client !== undefined && context.viewer.readAll
      ? denied('Klienta smí upravovat jen přidělený obchodník nebo vedení')
      : notFound('Klient neexistuje nebo k němu nemáte přístup');
  }
  return Effect.succeed(client);
};

export const requireWriteAll = (context: CommandContext) =>
  context.viewer.writeAll ? Effect.void : denied('Tuto operaci smí provést jen správce nebo vedoucí obchodu');

export const requireAssign = (context: CommandContext) =>
  context.viewer.assign ? Effect.void : denied('Přidělovat klienty smí jen správce nebo vedoucí obchodu');

export const requireAnyWrite = (context: CommandContext) =>
  canWriteAnything(context.viewer) ? Effect.void : denied('Nemáte oprávnění k zápisu v CRM');

/** Copy optional keys only when they carry a value (keeps exactOptionalPropertyTypes happy). */
export const definedOnly = <T extends object>(value: T) => {
  const defined: { [K in keyof T]?: Exclude<T[K], undefined> } = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined && entry !== '') {
      Object.defineProperty(defined, key, { configurable: true, enumerable: true, value: entry, writable: true });
    }
  }
  return defined;
};
