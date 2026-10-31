/**
 * How CRM judges agent proposals for the platform approval queue (the agent review read). CRM clients are private
 * per salesperson: a proposal about a client the reader may not see is hidden from them, history included. The
 * reader's own records answer (clients already narrowed to what they may see, and their viewer rights) decides
 * visibility, who may carry out a change, the before -> after lines and the undo of client edits. Pure.
 */
import type { ReadEvidenceMetadata } from '@app/core-runtime';
import { agentFieldLines, agentRecordHolds } from '@app/shared-contracts/agent-diff';
import { AgentCommandSourceSchema, AGENT_REVERT_UNAVAILABLE } from '@app/shared-contracts/agent-proposals';
import type { AgentCommand, AgentDiffLine, AgentRevertPlan } from '@app/shared-contracts/agent-proposals';

import type { AgentReviewItem, AgentReviewItemRequest } from '@app/shared-contracts/agent-review';
import {
  AGENT_REVERT_MISSING_BEFORE,
  agentRestoredPatch,
  agentRevertCommands,
  agentRevertNone,
} from '@app/shared-contracts/agent-revert';
import { Predicate, Schema } from 'effect';

const RecSchema = AgentCommandSourceSchema;
type Rec = typeof RecSchema.Type;
const isRecord = Schema.is(RecSchema);

/** The reader's CRM rights as their records read reports them. */
export interface CrmReviewViewer {
  readonly assign: boolean;
  readonly readAll: boolean;
  readonly salespersonId?: string | undefined;
  readonly writeAll: boolean;
  readonly writeAssigned: boolean;
}

/** Commands that change one client, keyed by the field holding the client id. */
const CLIENT_ID_FIELD = new Map(
  Object.entries({
    AddContactPerson: 'clientId',
    ArchiveClient: 'id',
    AssignClient: 'clientId',
    LinkClientParty: 'clientId',
    PlanContact: 'clientId',
    RecordVisit: 'clientId',
    RestoreClient: 'id',
    UpdateClient: 'id',
  }),
);

/** The client a command changes, or undefined for commands that do not target one client. */
export const clientIdOf = (command: AgentCommand): string | undefined => {
  const tag = command['_tag'];
  const field = Schema.is(Schema.String)(tag) ? CLIENT_ID_FIELD.get(tag) : undefined;
  const id = field === undefined ? undefined : command[field];
  return Schema.is(Schema.String)(id) && id !== '' ? id : undefined;
};

/** Records only the exact visible client of a single-record read, never a list or review batch. */
export const clientReadEvidence = (resultCount: number, client?: { readonly id: string }): ReadEvidenceMetadata => {
  if (resultCount !== 1 || client === undefined) {
    return { resultCount };
  }
  return { resultCount, targetResource: { resourceId: client.id, resourceType: 'demo.crm.client' } };
};

const CLIENT_LABELS = {
  address: 'Adresa',
  email: 'E-mail',
  kind: 'Druh klienta',
  name: 'Název',
  note: 'Poznámka',
  phone: 'Telefon',
  regNo: 'IČO',
  segment: 'Segment',
  vatNo: 'DIČ',
  website: 'Web',
} satisfies Readonly<Record<string, string>>;
const VALUE_OPTIONS = {
  valueLabels: {
    kind: { organization: 'Firma', person: 'Osoba' },
    segment: {
      bakery: 'Pekárna',
      cafe: 'Kavárna',
      catering: 'Catering',
      hotel: 'Hotel',
      institution: 'Instituce',
      restaurant: 'Restaurace',
      retail: 'Maloobchod',
      wholesale: 'Velkoobchod',
    },
  },
};

export const clientDiff = (command: AgentCommand, before?: Rec): AgentDiffLine[] | undefined => {
  const { patch } = command;
  return Predicate.isTagged(command, 'UpdateClient') && isRecord(patch)
    ? agentFieldLines(patch, CLIENT_LABELS, before, new Set(), VALUE_OPTIONS)
    : undefined;
};

/** An edited client gets its previous values back (only when every changed field had a value before). */
export const clientRevert = (command: AgentCommand, before: Rec | undefined): AgentRevertPlan => {
  const { id, patch } = command;
  if (!Predicate.isTagged(command, 'UpdateClient')) {
    return agentRevertNone();
  }
  const restored = agentRestoredPatch(patch, before);
  return restored === undefined
    ? agentRevertNone(AGENT_REVERT_MISSING_BEFORE)
    : agentRevertCommands([{ _tag: 'UpdateClient', id, patch: restored }]);
};

/** Why the reader cannot carry out the command, undefined when they can. */
export const clientBlockedReason = (
  command: AgentCommand,
  viewer: CrmReviewViewer,
  client: Rec | undefined,
): string | undefined => {
  const owns =
    client !== undefined && viewer.salespersonId !== undefined && client['ownerSalespersonId'] === viewer.salespersonId;
  if (Predicate.isTagged(command, 'AssignClient') && !viewer.assign) {
    return 'Přidělit klienta jinému obchodníkovi může jen správce nebo vedoucí.';
  }
  const mayWrite =
    client === undefined ? viewer.writeAll || viewer.writeAssigned : viewer.writeAll || (viewer.writeAssigned && owns);
  return mayWrite ? undefined : 'Tohoto klienta nemůžete upravovat, změnu schválí jeho obchodník nebo vedoucí.';
};

/** The reader sees every client, so also all agent activity in CRM. */
export const seesAllClients = (viewer: CrmReviewViewer): boolean => viewer.readAll || viewer.writeAll;

/** One proposal judged against the reader's records answer (`clients`: wire JSON of the clients they may see). */
export const reviewCrmProposal = (
  request: AgentReviewItemRequest,
  viewer: CrmReviewViewer,
  clients: readonly Rec[],
): AgentReviewItem => {
  const { command, key, stage } = request;
  const clientId = clientIdOf(command);
  const client = clientId === undefined ? undefined : clients.find((entry) => entry['id'] === clientId);
  const visible = clientId === undefined || client !== undefined;
  if (stage === 'history') {
    const lines = clientDiff(command);
    const historyItem: AgentReviewItem = { key, visible };
    if (lines !== undefined) {
      Object.assign(historyItem, { diff: lines });
    }
    return historyItem;
  }
  if (stage === 'undo') {
    const { patch } = command;
    const inPlace = Predicate.isTagged(command, 'UpdateClient')
      ? client !== undefined && agentRecordHolds(patch, client)
      : undefined;
    const undoItem: AgentReviewItem = { key, visible };
    if (inPlace !== undefined) {
      Object.assign(undoItem, { stillInPlace: inPlace });
    }
    return undoItem;
  }
  const lines = clientDiff(command, client);
  const blocked = clientBlockedReason(command, viewer, client);
  const name = client?.['name'];
  const item: AgentReviewItem = { key, revert: clientRevert(command, client), visible };
  if (blocked !== undefined) {
    Object.assign(item, { blockedReason: blocked });
  }
  if (lines !== undefined) {
    Object.assign(item, { diff: lines });
  }
  if (!Predicate.isTagged(command, 'UpdateClient')) {
    Object.assign(item, { revertUnavailableReason: AGENT_REVERT_UNAVAILABLE });
  }
  if (Schema.is(Schema.String)(name) && name !== '') {
    Object.assign(item, { targetName: name.slice(0, 300) });
  }
  return item;
};
