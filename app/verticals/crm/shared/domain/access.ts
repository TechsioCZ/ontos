// Server-side ACL model (C00) expressed over the canonical Authorization v2 capabilities (ADR-0030).
// The owner reads no permission key of its own: the one access gate answers the three CRM
// declarations below, and every projection and reducer still goes through these helpers, so hiding
// a button is never the authorization.
//
//   demo.crm.api-records.read     the record-scoped records read. The granted record selector is the
//                                 caller's reach over the company's clients:
//                                   all        Správce, Vedoucí: every client, visit, order, batch
//                                   assigned   Obchodník: only the clients whose owner is the caller
//                                   entrusted  externí partner: only the clients entrusted to them
//   demo.crm.apply-command.write  the one CRM write capability. A scope-wide Action cannot carry a
//                                 holder-relative selector (R5a-7), so the owner applies the caller's
//                                 *read* reach to the record it changes: you may change a client you
//                                 may read, and the write capability only says "may change CRM at all".
//   demo.crm.client-owner.assign  the reassignment field group of that Action (Správce, Vedoucí):
//                                 a payload that names the new owner asks for this authority on top.
import { Predicate, Schema } from 'effect';
import type { ListAccessPredicate } from '@app/core-runtime/access/decision/list-access';
import { EntityIdSchema, PrincipalIdSchema } from './common.ts';
import type { EntityId, PrincipalId } from './common.ts';

/** The records read; its declared selectors are the reviewed reach of every CRM role. */
export const crmRecordsReadCapability = 'demo.crm.api-records.read' as const;
/** The one CRM write Action; scope-wide, because a holder-relative Action selector is unsupported. */
export const crmApplyCommandCapability = 'demo.crm.apply-command.write' as const;
/** The `field_write` group that keeps owner reassignment separately authorized. */
export const crmClientOwnerAssignCapability = 'demo.crm.client-owner.assign' as const;
/** The record selectors the CRM records read declares; a Role cell names exactly one of them. */
export const crmRecordSelectors = ['all', 'assigned', 'entrusted'] as const;
export type CrmRecordSelector = (typeof crmRecordSelectors)[number];

/**
 * What the one access gate answered about the caller's CRM reach. `readSelector` is the record
 * selector the gate resolved for {@link crmRecordsReadCapability}; `undefined` means the caller may
 * read no client at all, so it may change none either.
 */
export interface CrmGrants {
  readonly assign: boolean;
  readonly readSelector?: CrmRecordSelector;
  readonly write: boolean;
}

/**
 * The record selector a resolved list predicate stands for: no clause at all is the whole company, an
 * entrusted or assigned clause is that reach, and a predicate the owner cannot describe is no reach at
 * all — an authority that cannot say which rows it covers never widens into "every row" (guarantee 10).
 */
export const crmRecordSelectorOf = (
  predicate: ListAccessPredicate,
  principalId: string,
): CrmRecordSelector | undefined => {
  let selector: CrmRecordSelector = 'all';
  for (const group of predicate.groups) {
    // An all-scope alternative makes just this OR group unconstrained, not the other AND groups.
    if (
      group.clauses.some(
        (clause) =>
          clause.conditions.length > 0 &&
          clause.conditions.every((condition) => Predicate.isTagged(condition, 'AllInScope')),
      )
    ) {
      continue;
    }
    if (group.clauses.length === 0) {
      return undefined;
    }
    for (const clause of group.clauses) {
      if (clause.conditions.length === 0) {
        return undefined;
      }
      for (const condition of clause.conditions) {
        if (
          (!Predicate.isTagged(condition, 'AssignedTo') && !Predicate.isTagged(condition, 'EntrustedTo')) ||
          !Predicate.isTagged(condition.holder, 'Principal') ||
          condition.holder.principalId !== principalId
        ) {
          // Never drop a target/ceiling/team restriction or substitute the caller for another holder.
          return undefined;
        }
        selector = Predicate.isTagged(condition, 'EntrustedTo') ? 'entrusted' : 'assigned';
      }
    }
  }
  return selector;
};

export const CrmViewerSchema = Schema.Struct({
  assign: Schema.Boolean,
  principalId: PrincipalIdSchema,
  readAll: Schema.Boolean,
  readAssigned: Schema.Boolean,
  /** The principal's own salesperson record, when it has one. */
  salespersonId: Schema.optionalKey(EntityIdSchema),
  writeAll: Schema.Boolean,
  writeAssigned: Schema.Boolean,
});
export type CrmViewer = typeof CrmViewerSchema.Type;

/**
 * The ACL subject of every read and command: the gate's answer plus the principal's salesperson
 * record. The write reach follows the read reach — a scope-wide write capability says only that the
 * caller may change CRM, and the client it may change is one it may read — so no caller is ever
 * granted "all" and then filtered silently.
 */
export const viewerFor = (grants: CrmGrants, principalId: PrincipalId, salespersonId?: EntityId): CrmViewer => {
  const readAll = grants.readSelector === 'all';
  const readAssigned = grants.readSelector === 'assigned' || grants.readSelector === 'entrusted';
  const base = {
    assign: grants.assign,
    principalId,
    readAll,
    readAssigned,
    writeAll: grants.write && readAll,
    writeAssigned: grants.write && readAssigned,
  };
  return salespersonId === undefined ? base : { ...base, salespersonId };
};

interface OwnedClient {
  readonly ownerSalespersonId?: string | undefined;
}

const ownsClient = (viewer: CrmViewer, client: OwnedClient) =>
  viewer.salespersonId !== undefined && client.ownerSalespersonId === viewer.salespersonId;

/** May the viewer see this client (and therefore its contacts, visits, plan items and paired orders)? */
export const canReadClient = (viewer: CrmViewer, client: OwnedClient): boolean =>
  viewer.readAll || viewer.writeAll || ((viewer.readAssigned || viewer.writeAssigned) && ownsClient(viewer, client));

/** May the viewer change this client, its contacts, visits and plan items? */
export const canWriteClient = (viewer: CrmViewer, client: OwnedClient): boolean =>
  viewer.writeAll || (viewer.writeAssigned && ownsClient(viewer, client));

export const canWriteAnything = (viewer: CrmViewer): boolean => viewer.writeAll || viewer.writeAssigned;
export const canSeeEverything = (viewer: CrmViewer): boolean => viewer.readAll || viewer.writeAll;
