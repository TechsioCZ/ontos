import { expect, it } from 'effect-rstest';

import { ONTOS_SPICEDB_SCHEMA } from '../../src/permissions/schema.ts';

/*
 * Snapshot of the SpiceDB schema split into the two halves tranche 1 must keep apart: the legacy
 * definitions, frozen to their exact vocabulary, and the authorization v2 definitions, which may
 * only use the dedicated human type and agent (O46). The integration suites prove the same claims
 * against a live SpiceDB; this one runs everywhere and fails on an accidental edit.
 */
const FILE_DIRECTIVE = 'use expiration\n\n';
const V2_BOUNDARY = '// Authorization v2 engine';

const schema = ONTOS_SPICEDB_SCHEMA;
const legacyHalf = schema.slice(FILE_DIRECTIVE.length, schema.indexOf(V2_BOUNDARY) - 2);
const v2Half = schema.slice(schema.indexOf(V2_BOUNDARY));

interface Definition {
  readonly name: string;
  readonly permissions: readonly string[];
  readonly relations: ReadonlyMap<string, string>;
}

/** Minimal reader of the compiled-shape schema text: definitions, their relations and permissions. */
const definitionsOf = (source: string): readonly Definition[] => {
  const definitions: { name: string; permissions: string[]; relations: Map<string, string> }[] = [];
  for (const line of source.split('\n')) {
    const definition = /^definition (?<name>\w+) \{\}?$/u.exec(line)?.groups?.['name'];
    const relation = /^ {2}relation (?<name>\w+): (?<types>.+)$/u.exec(line)?.groups;
    const permission = /^ {2}permission (?<name>\w+) = .+$/u.exec(line)?.groups?.['name'];
    const current = definitions.at(-1);
    if (definition !== undefined) {
      definitions.push({ name: definition, permissions: [], relations: new Map() });
    } else if (current !== undefined && relation?.['name'] !== undefined) {
      current.relations.set(relation['name'], relation['types'] ?? '');
    } else if (current !== undefined && permission !== undefined) {
      current.permissions.push(permission);
    }
  }
  return definitions.map(({ name, permissions, relations }) => ({
    name,
    permissions: permissions.toSorted(),
    relations,
  }));
};

/** One definition as `name | relation: types, … | permission, …`, so a diff names what moved. */
const vocabularyOf = ({ name, permissions, relations }: Definition): string =>
  `${name} | ${[...relations]
    .map(([relation, types]) => `${relation}: ${types}`)
    .toSorted()
    .join(', ')} | ${permissions.join(', ')}`;

/** Every distinct subject type a relation accepts, with `with expiration`/`with <caveat>` removed. */
const subjectTypesOf = (types: string): readonly string[] => [
  ...new Set(
    types
      .split('|')
      .map((type) => type.trim().split(' with ')[0] ?? '')
      .filter((type) => type.length > 0),
  ),
];

const legacyDefinitions = definitionsOf(legacyHalf);
const v2Definitions = definitionsOf(v2Half);
const v2Relations = v2Definitions.flatMap(({ name, relations }) =>
  [...relations].map(([relation, types]) => ({ key: `${name}.${relation}`, types: subjectTypesOf(types) })),
);
const v2SubjectTypes = new Set(v2Relations.flatMap(({ types }) => types));

/** The human-only relations of the reference schema: an agent must never reach them (P4, D2). */
const HUMAN_ONLY_RELATIONS = [
  'access_assignment.holder',
  'access_delegation.manager',
  'access_legal_entity.access_admin',
  'access_mandate.executor',
  'access_tenant.owner',
];

it('freezes the whole legacy vocabulary', () => {
  // Change a line here only together with an explicit, reviewed decision to change live legacy
  // authorization. Tranche 1 must leave every one of them exactly as main had it.
  expect(legacyDefinitions.map(vocabularyOf)).toEqual([
    'principal |  | ',
    'tenant | identity_admin: principal, member: principal, party_identity_manager: principal, party_identity_merger: principal, party_identity_reader: principal, party_identity_reviewer: principal, party_relationship_manager: principal, support: principal | access, impersonate, manage_identity, manage_party_identity, manage_party_relationships, merge_party_identity, read_party_identity, review_party_identity',
    'identity_namespace | provisioner: principal, tenant: tenant | provision',
    'legal_entity | counterparty_manager: principal, counterparty_reader: principal, member: principal, tenant: tenant | access, manage_counterparty, read_counterparty',
    'module_access | accessor: principal, legal_entity: legal_entity | access',
    'resource | module: module_access, reader: principal, writer: principal | read, write',
    'tenant_resource | assignee: principal, reader: principal, tenant: tenant, writer: principal | assign, read, write',
    'business_permission | containing_catalog: business_permission, grantee: principal, legal_entity: legal_entity, tenant: tenant | direct_use, use',
    'context_permission | grantee: principal, tenant: tenant | access',
    'action | executor: principal | tenant#member, restriction: action | execute, is_restricted',
  ]);
  // The legacy vocabulary keeps its multi-kind principal; v2 must not reuse it.
  expect(legacyHalf).toMatch(/^ {2}relation member: principal$/mu);
  expect(v2Half).not.toMatch(/^ {2}relation \w+: [^|\n]*principal/u);
});

it('declares exactly the reference v2 vocabulary, keyed by the access_ prefix', () => {
  expect(v2Definitions.map(({ name }) => name).toSorted()).toEqual([
    'access_assignment',
    'access_capability',
    'access_delegation',
    'access_grant',
    'access_human',
    'access_installation',
    'access_legal_entity',
    'access_mandate',
    'access_projection',
    'access_record',
    'access_role_binding',
    'access_scope',
    'access_team',
    'access_tenant',
    'agent',
  ]);
  expect(v2Half).toMatch(/^caveat amount_ceiling\(/mu);
  expect(v2Half).toMatch(/^caveat target_set\(/mu);
  expect(v2Half).toMatch(/^caveat bounded_target_set\(/mu);
  // The type-system guarantee of the tranche: v2 is human or agent only, and no workload principal,
  // integration or system job can satisfy a v2 relation (O46).
  expect([...v2SubjectTypes].filter((type) => type.startsWith('principal'))).toEqual([]);
  expect(v2SubjectTypes.has('access_human')).toBe(true);
  expect(v2SubjectTypes.has('agent')).toBe(true);
  for (const key of HUMAN_ONLY_RELATIONS) {
    expect(v2Relations.find((relation) => relation.key === key)?.types, key).toEqual(['access_human']);
  }
});

it('pins every v2 relation to the human or agent types the reference allows', () => {
  const ALLOWED = new Set([
    'access_assignment',
    'access_assignment#agent_holder',
    'access_assignment#holder',
    'access_capability',
    'access_delegation',
    'access_grant',
    'access_human',
    'access_installation',
    'access_legal_entity',
    'access_projection',
    'access_role_binding',
    'access_scope',
    'access_team',
    'access_tenant',
    'agent',
  ]);
  const unexpected = v2Relations.flatMap(({ key, types }) =>
    types.filter((type) => !ALLOWED.has(type)).map((type) => `${key}: ${type}`),
  );
  expect(unexpected).toEqual([]);
  // Membership, suspension, agent holding, team and record links are the only agent relations.
  expect(
    v2Relations
      .filter(({ types }) => types.includes('agent'))
      .map(({ key }) => key)
      .toSorted(),
  ).toEqual([
    'access_assignment.agent_holder',
    'access_legal_entity.member',
    'access_legal_entity.suspended',
    'access_record.assigned',
    'access_record.creator',
    'access_record.entrusted',
    'access_team.member',
    'access_tenant.member',
    'access_tenant.suspended',
  ]);
});
