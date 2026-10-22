/**
 * How CRM judges agent proposals for the platform approval queue (the agent review read). CRM clients are private
 * per salesperson: a proposal about a client the reader may not see is hidden from them, history included. The
 * reader's own records answer (clients already narrowed to what they may see, and their viewer rights) decides
 * visibility, who may carry out a change, the before -> after lines and the undo of client edits. Pure.
 */
import { agentFieldLines, agentRecordHolds } from '@app/shared-contracts/agent-diff';
import type { AgentCommand, AgentDiffLine, AgentRevertPlan } from '@app/shared-contracts/agent-proposals';
import { AGENT_REVERT_UNAVAILABLE } from '@app/shared-contracts/agent-proposals';
import type { AgentReviewItem, AgentReviewItemRequest } from '@app/shared-contracts/agent-review';
import {
  AGENT_REVERT_MISSING_BEFORE,
  agentRestoredPatch,
  agentRevertCommands,
  agentRevertNone,
} from '@app/shared-contracts/agent-revert';

type Rec = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Rec => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The reader's CRM rights as their records read reports them. */
export interface CrmReviewViewer {
  readonly assign: boolean;
  readonly readAll: boolean;
  readonly salespersonId?: string | undefined;
  readonly writeAll: boolean;
  readonly writeAssigned: boolean;
}

/** Commands that change one client, keyed by the field holding the client id. */
const CLIENT_ID_FIELD: Readonly<Record<string, string>> = {
  AddContactPerson: 'clientId',
  ArchiveClient: 'id',
  AssignClient: 'clientId',
  LinkClientParty: 'clientId',
  PlanContact: 'clientId',
  RecordVisit: 'clientId',
  RestoreClient: 'id',
  UpdateClient: 'id',
};

/** The client a command changes, or undefined for commands that do not target one client. */
export const clientIdOf = (command: AgentCommand): string | undefined => {
  const tag = command['_tag'];
  const field = typeof tag === 'string' ? CLIENT_ID_FIELD[tag] : undefined;
  const id = field === undefined ? undefined : command[field];
  return typeof id === 'string' && id !== '' ? id : undefined;
};

const CLIENT_LABELS: Readonly<Record<string, string>> = {
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
};
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

export const clientDiff = (command: AgentCommand, before: Rec | undefined): AgentDiffLine[] | undefined => {
  const { patch } = command;
  return command['_tag'] === 'UpdateClient' && isRecord(patch)
    ? agentFieldLines(patch, CLIENT_LABELS, before, new Set(), VALUE_OPTIONS)
    : undefined;
};

/** An edited client gets its previous values back (only when every changed field had a value before). */
export const clientRevert = (command: AgentCommand, before: Rec | undefined): AgentRevertPlan => {
  if (command['_tag'] !== 'UpdateClient') return agentRevertNone();
  const restored = agentRestoredPatch(command['patch'], before);
  return restored === undefined
    ? agentRevertNone(AGENT_REVERT_MISSING_BEFORE)
    : agentRevertCommands([{ _tag: 'UpdateClient', id: command['id'], patch: restored }]);
};

/** Why the reader cannot carry out the command, undefined when they can. */
export const clientBlockedReason = (
  command: AgentCommand,
  viewer: CrmReviewViewer,
  client: Rec | undefined,
): string | undefined => {
  const owns =
    client !== undefined && viewer.salespersonId !== undefined && client['ownerSalespersonId'] === viewer.salespersonId;
  if (command['_tag'] === 'AssignClient' && !viewer.assign) {
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
    const lines = clientDiff(command, undefined);
    return { key, visible, ...(lines === undefined ? {} : { diff: lines }) };
  }
  if (stage === 'undo') {
    const inPlace = command['_tag'] === 'UpdateClient' ? client !== undefined && agentRecordHolds(command['patch'], client) : undefined;
    return { key, visible, ...(inPlace === undefined ? {} : { stillInPlace: inPlace }) };
  }
  const lines = clientDiff(command, client);
  const blocked = clientBlockedReason(command, viewer, client);
  const name = client?.['name'];
  return {
    key,
    revert: clientRevert(command, client),
    visible,
    ...(blocked === undefined ? {} : { blockedReason: blocked }),
    ...(lines === undefined ? {} : { diff: lines }),
    ...(command['_tag'] === 'UpdateClient' ? {} : { revertUnavailableReason: AGENT_REVERT_UNAVAILABLE }),
    ...(typeof name === 'string' && name !== '' ? { targetName: name.slice(0, 300) } : {}),
  };
};
