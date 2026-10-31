import {
  AgentCommandValueSchema,
  AgentRecordReferenceSchema,
  AgentResourceIdSchema,
  AgentResourceTypeSchema,
} from '@app/shared-contracts/agent-proposals';
import type { AgentActivityEntry, AgentCommand } from '@app/shared-contracts/agent-proposals';
import { Predicate, Schema } from 'effect';

import type { McpModule } from '../mcp/catalog.ts';

type RecordLink = NonNullable<McpModule['recordLinks']>[number];
type RecordReference = NonNullable<AgentActivityEntry['recordReference']>;

const fieldAt = (value: Schema.Json | undefined, path: string): Schema.Json | undefined => {
  let current = value;
  for (const segment of path.split('.')) {
    if (!Schema.is(Schema.JsonObject)(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
};

/** No command or resource names belong to the Shell: their owner declares the reference. */
export const commandRecordReference = (
  links: readonly RecordLink[],
  command: AgentCommand,
): RecordReference | undefined => {
  for (const link of links) {
    const target = link.commands.find(({ tag }) => Predicate.isTagged(command, tag));
    const resourceId = target === undefined ? undefined : fieldAt(command, target.idField);
    if (Schema.is(Schema.String)(resourceId) && resourceId !== '') {
      return AgentRecordReferenceSchema.make({
        resourceId: AgentResourceIdSchema.make(resourceId),
        resourceType: AgentResourceTypeSchema.make(link.resourceType),
      });
    }
  }
  return undefined;
};

/** A route declaration is not authorization: the record must exist in the module's viewer-scoped read. */
export const resolveActivityRecord = (
  links: readonly RecordLink[],
  reference: RecordReference | undefined,
  records: Schema.Json | undefined,
): AgentActivityEntry['record'] => {
  if (reference === undefined) {
    return undefined;
  }
  const link = links.find(({ resourceType }) => resourceType === reference.resourceType);
  if (link === undefined) {
    return undefined;
  }
  const items = fieldAt(records, link.recordsPath);
  if (!Schema.is(Schema.Array(AgentCommandValueSchema))(items)) {
    return undefined;
  }
  const record: Schema.Json | undefined = items.find(
    (item: Schema.Json) => fieldAt(item, link.idField) === reference.resourceId,
  );
  const label = fieldAt(record, link.labelField);
  if (!Schema.is(Schema.String)(label) || label === '') {
    return undefined;
  }
  const query = new URLSearchParams({ [link.queryParam]: reference.resourceId });
  return { label, path: `${link.path}?${query.toString()}` };
};

/** Proposals have exact queue targets; ordinary audit entries remain text until an audit detail route exists. */
export const proposalActivityPath = (proposal: AgentActivityEntry['proposal']): string | undefined =>
  proposal === undefined
    ? undefined
    : `/sprava/ke-schvaleni?${new URLSearchParams({ davka: proposal.batchKey, navrh: proposal.itemKey }).toString()}`;

export interface ActivityLinkAccess {
  readonly agentExists: boolean;
  readonly canManageAgents: boolean;
  readonly canOpenModule: boolean;
  readonly canReviewProposals: boolean;
  readonly grants: readonly {
    readonly actingKind: string;
    readonly actingPrincipalId: string;
    readonly clientName: string;
    readonly grantId: string;
    readonly writePolicy: string;
  }[];
  readonly identityPage: string | undefined;
  readonly module: McpModule | undefined;
  readonly personExists: boolean;
  readonly records: Schema.Json | undefined;
}

const grantPolicyLabel = (policy: string): string => {
  if (policy === 'approval') {
    return 'návrhy ke schválení';
  }
  return policy === 'direct' ? 'přímý zápis' : 'jen čtení';
};

/** All paths are resolved server-side from current permissions and existing targets, never from display labels. */
export const resolveActivityLinks = (entry: AgentActivityEntry, access: ActivityLinkAccess): AgentActivityEntry => {
  const module = access.canOpenModule ? access.module : undefined;
  const record =
    module === undefined
      ? undefined
      : resolveActivityRecord(module.recordLinks ?? [], entry.recordReference, access.records);
  const actionPath = access.canReviewProposals ? proposalActivityPath(entry.proposal) : undefined;
  const grants = access.canManageAgents
    ? access.grants.filter((grant) => grant.actingPrincipalId === entry.agentPrincipalId)
    : [];
  // OAuth may act as a person, not a standalone agent. Link that real identity, never an unrelated agent by name.
  const personKind = access.personExists ? 'person' : undefined;
  const identityKind = access.agentExists ? 'agent' : personKind;
  const agentPath =
    access.canManageAgents && access.identityPage !== undefined && identityKind !== undefined
      ? `${access.identityPage}?${identityKind}=${encodeURIComponent(entry.agentPrincipalId)}`
      : undefined;
  let linked = { ...entry };
  if (actionPath !== undefined) {
    linked = { ...linked, actionPath };
  }
  if (module?.page !== undefined) {
    linked = { ...linked, modulePath: module.page };
  }
  if (record !== undefined) {
    linked = { ...linked, record };
  }
  if (agentPath !== undefined) {
    linked = { ...linked, agentPath };
  }
  if (grants.length > 0) {
    linked = {
      ...linked,
      grants: grants.map((grant) => ({
        label: `${grant.clientName} · ${grantPolicyLabel(grant.writePolicy)}`,
        path: `/sprava/pripojene-aplikace?grant=${encodeURIComponent(grant.grantId)}`,
      })),
    };
  }
  return linked;
};
