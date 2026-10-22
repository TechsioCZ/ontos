/**
 * Agent entities (lane agent-entities): the SpiceDB relationships an agent principal gets in its company. Built from
 * the relationships of the company's role template personas (the same grants human roles use), filtered per module by
 * the access the administrator chose and by the write policy. Pure; `DemoAccountGrants.replaceAgentGrants` writes them.
 */
import { demoAccountObjectIdParts } from './demo-account-administration.ts';
import type { DemoAccountRelationship } from './demo-account-administration.ts';

export type AgentGrantAccess = 'read' | 'write';
export type AgentGrantWritePolicy = 'approval' | 'direct' | 'read_only';
export interface AgentGrantModule {
  readonly access: AgentGrantAccess;
  readonly moduleId: string;
}

const companyScopedTypes: ReadonlySet<string> = new Set(['legal_entity', 'module_access', 'context_permission']);

/** `read_all`, `.read`, `_read` permissions only read; everything else (write_all, assign, …) writes. */
export const isReadPermission = (permission: string): boolean => /(?:^|[._])read(?:_all)?$/u.test(permission);

/** Action key of an `action` object ID (`ak_` + base64url of the key), or undefined. */
export const actionKeyOfObjectId = (objectId: string): string | undefined =>
  objectId.startsWith('ak_') ? Buffer.from(objectId.slice('ak_'.length), 'base64url').toString('utf-8') : undefined;

const belongsToCompany = (relationship: DemoAccountRelationship, legalEntityId: string) =>
  demoAccountObjectIdParts(relationship.resourceId).includes(legalEntityId);
const isCoreModule = (moduleId: string) => moduleId.startsWith('core.');

const companyModules = (
  relationships: readonly DemoAccountRelationship[],
  legalEntityId: string,
): readonly string[] => [
  ...new Set(
    relationships.flatMap((relationship) => {
      if (relationship.resourceType !== 'module_access' || !belongsToCompany(relationship, legalEntityId)) {
        return [];
      }
      const moduleId = demoAccountObjectIdParts(relationship.resourceId)[2];
      return moduleId === undefined ? [] : [moduleId];
    }),
  ),
];

/** Module and access one relationship grants, or undefined when it is not module-specific. */
export const relationshipModuleAccess = (
  relationship: DemoAccountRelationship,
  knownModules: readonly string[],
): AgentGrantModule | undefined => {
  if (relationship.resourceType === 'module_access') {
    const moduleId = demoAccountObjectIdParts(relationship.resourceId)[2];
    return moduleId === undefined ? undefined : { access: 'read', moduleId };
  }
  if (relationship.resourceType === 'context_permission') {
    const parts = demoAccountObjectIdParts(relationship.resourceId);
    const moduleId = parts[3];
    const permission = parts[4];
    return moduleId === undefined || permission === undefined
      ? undefined
      : { access: isReadPermission(permission) ? 'read' : 'write', moduleId };
  }
  if (relationship.resourceType === 'action' && relationship.relation === 'executor') {
    const actionKey = actionKeyOfObjectId(relationship.resourceId);
    if (actionKey === undefined) {
      return undefined;
    }
    const moduleId = knownModules
      .filter((candidate) => actionKey.startsWith(`${candidate}.`))
      .toSorted((left, right) => right.length - left.length)[0];
    return moduleId === undefined ? undefined : { access: 'write', moduleId };
  }
  return undefined;
};

/** Highest access per non-Core module of the company the relationships grant, sorted by module ID. */
export const agentModuleAccessOf = (
  relationships: readonly DemoAccountRelationship[],
  legalEntityId: string,
): readonly AgentGrantModule[] => {
  const known = companyModules(relationships, legalEntityId);
  const access = new Map<string, AgentGrantAccess>();
  for (const relationship of relationships) {
    if (companyScopedTypes.has(relationship.resourceType) && !belongsToCompany(relationship, legalEntityId)) {
      continue;
    }
    const granted = relationshipModuleAccess(relationship, known);
    if (granted === undefined || isCoreModule(granted.moduleId) || !known.includes(granted.moduleId)) {
      continue;
    }
    if (access.get(granted.moduleId) !== 'write') {
      access.set(granted.moduleId, granted.access);
    }
  }
  return [...access.entries()]
    .map(([moduleId, value]) => ({ access: value, moduleId }))
    .toSorted((left, right) => left.moduleId.localeCompare(right.moduleId));
};

/**
 * The complete grant set of one agent entity in `legalEntityId`. `legalEntityWriteRelations` holds, per module, the
 * company-wide relations its writers need (declared by the module's contract); others stay read-only.
 */
export const agentGrantRelationships = (input: {
  readonly legalEntityId: string;
  readonly legalEntityWriteRelations: ReadonlyMap<string, readonly string[]>;
  readonly modules: readonly AgentGrantModule[];
  readonly template: readonly DemoAccountRelationship[];
  readonly writePolicy: AgentGrantWritePolicy;
}): readonly DemoAccountRelationship[] => {
  const known = companyModules(input.template, input.legalEntityId);
  const effective = new Map<string, AgentGrantAccess>(
    input.modules
      .filter(({ moduleId }) => !isCoreModule(moduleId))
      .map(({ access, moduleId }) => [moduleId, input.writePolicy === 'direct' ? access : 'read'] as const),
  );
  const writes = (moduleId: string) => effective.get(moduleId) === 'write';
  const writtenLegalEntityRelations = new Set(
    [...input.legalEntityWriteRelations].flatMap(([moduleId, relations]) => (writes(moduleId) ? relations : [])),
  );
  const keep = (relationship: DemoAccountRelationship): boolean => {
    if (companyScopedTypes.has(relationship.resourceType) && !belongsToCompany(relationship, input.legalEntityId)) {
      return false;
    }
    if (relationship.resourceType === 'tenant') {
      return relationship.relation === 'member' || relationship.relation.endsWith('_reader');
    }
    if (relationship.resourceType === 'legal_entity') {
      return (
        relationship.relation === 'member' ||
        relationship.relation.endsWith('_reader') ||
        writtenLegalEntityRelations.has(relationship.relation)
      );
    }
    if (relationship.resourceType === 'module_access') {
      const moduleId = demoAccountObjectIdParts(relationship.resourceId)[2];
      return moduleId === 'core.shell' || (moduleId !== undefined && effective.has(moduleId));
    }
    if (relationship.resourceType === 'context_permission' || relationship.resourceType === 'action') {
      const granted = relationshipModuleAccess(relationship, known);
      return (
        granted !== undefined &&
        effective.has(granted.moduleId) &&
        (granted.access === 'read' || writes(granted.moduleId))
      );
    }
    return false;
  };
  const key = (relationship: DemoAccountRelationship) =>
    `${relationship.resourceType}|${relationship.resourceId}|${relationship.relation}`;
  return [...new Map(input.template.filter(keep).map((relationship) => [key(relationship), relationship])).values()];
};
