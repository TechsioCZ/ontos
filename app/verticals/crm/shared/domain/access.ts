// Server-side ACL model (C00). The read server and the command handler both compute a CrmViewer from the
// principal's context permissions and its salesperson record; every projection and reducer goes through these
// helpers. Hiding a button is never the authorization.
//
//   demo.crm.read_all        Správce, Vedoucí: every client, visit, order, import batch
//   demo.crm.write_all       Správce, Vedoucí: write every client, import CSV, pair orders
//   demo.crm.read_assigned   Obchodník: only clients whose ownerSalespersonId is the principal's salesperson
//   demo.crm.write_assigned  Obchodník: write only those clients (contacts, visits, plan)
//   demo.crm.assign          Správce, Vedoucí: (re)assign a client to a salesperson
import { Schema } from 'effect';
import { EntityIdSchema, PrincipalIdSchema } from './common.ts';

export const crmPermissionKeys = [
  'demo.crm.read_all',
  'demo.crm.write_all',
  'demo.crm.read_assigned',
  'demo.crm.write_assigned',
  'demo.crm.assign',
] as const;
export type CrmPermissionKey = (typeof crmPermissionKeys)[number];

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
