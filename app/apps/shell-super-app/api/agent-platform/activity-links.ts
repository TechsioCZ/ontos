import type { AgentActivityEntry, AgentCommand } from '@app/shared-contracts/agent-proposals';
import { Predicate } from 'effect';

import type { McpModule } from '../mcp/catalog.ts';

type RecordLink = NonNullable<McpModule['recordLinks']>[number];
type RecordReference = NonNullable<AgentActivityEntry['recordReference']>;

const fieldAt = (value: unknown, path: string): unknown => {
  let current = value;
  for (const segment of path.split('.')) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined;
    current = Reflect.get(current, segment);
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
    if (typeof resourceId === 'string' && resourceId !== '') return { resourceId, resourceType: link.resourceType };
  }
  return undefined;
};

/** A route declaration is not authorization: the record must exist in the module's viewer-scoped read. */
export const resolveActivityRecord = (
  links: readonly RecordLink[],
  reference: RecordReference | undefined,
  records: unknown,
): AgentActivityEntry['record'] => {
  if (reference === undefined) return undefined;
  const link = links.find(({ resourceType }) => resourceType === reference.resourceType);
  if (link === undefined) return undefined;
  const items = fieldAt(records, link.recordsPath);
  if (!Array.isArray(items)) return undefined;
  const record: unknown = items.find((item: unknown) => fieldAt(item, link.idField) === reference.resourceId);
  const label = fieldAt(record, link.labelField);
  if (typeof label !== 'string' || label === '') return undefined;
  const query = new URLSearchParams({ [link.queryParam]: reference.resourceId });
  return { label, path: `${link.path}?${query.toString()}` };
};

/** Proposals have exact queue targets; ordinary audit entries remain text until an audit detail route exists. */
export const proposalActivityPath = (proposal: AgentActivityEntry['proposal']): string | undefined =>
  proposal === undefined
    ? undefined
    : `/sprava/ke-schvaleni?${new URLSearchParams({ davka: proposal.batchKey, navrh: proposal.itemKey }).toString()}`;

export interface ActivityLinkAccess {
  readonly canReviewProposals: boolean;
  readonly canOpenModule: boolean;
  readonly canManageAgents: boolean;
  readonly agentExists: boolean;
  readonly identityPage: string | undefined;
  readonly module: McpModule | undefined;
  readonly personExists: boolean;
  readonly records: unknown;
  readonly grants: readonly {
    readonly actingKind: string;
    readonly actingPrincipalId: string;
    readonly grantId: string;
    readonly clientName: string;
    readonly writePolicy: string;
  }[];
}

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
  return {
    ...entry,
    ...(actionPath === undefined ? {} : { actionPath }),
    ...(module?.page === undefined ? {} : { modulePath: module.page }),
    ...(record === undefined ? {} : { record }),
    ...(agentPath === undefined ? {} : { agentPath }),
    ...(grants.length === 0
      ? {}
      : {
          grants: grants.map((grant) => ({
            label: `${grant.clientName} · ${grant.writePolicy === 'approval' ? 'návrhy ke schválení' : grant.writePolicy === 'direct' ? 'přímý zápis' : 'jen čtení'}`,
            path: `/sprava/pripojene-aplikace?grant=${encodeURIComponent(grant.grantId)}`,
          })),
        }),
  };
};
