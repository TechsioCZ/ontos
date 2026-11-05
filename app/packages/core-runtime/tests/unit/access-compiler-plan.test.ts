import { Option, Result } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  capabilityObjectId,
  capabilitySlot,
  capabilitySlotRelation,
  decodeObjectId,
  grantObjectId,
  isProjectableObjectId,
  recordObjectId,
  roleBindingObjectId,
} from '../../src/access/compiler/object-id.ts';
import { planAccessProjection } from '../../src/access/compiler/plan.ts';
import { relationshipKey } from '../../src/access/compiler/relationship.ts';
import type { DelegatedLimits } from '../../src/access/model.ts';
import {
  ADMIN,
  AGENT,
  ALICE,
  ASSIGNMENT,
  BOB,
  CAP_MARGINS,
  CAP_NOTE,
  CAP_PAY,
  DELEGATION,
  ENTITY,
  AT,
  CAP_OTHER_MODULE,
  MODULE,
  NEXT_REVISION,
  OTHER_MODULE,
  OTHER_ROLE,
  OTHER_SCOPE,
  PREFIX_MODULE,
  REVISION,
  ROLE,
  SCOPE,
  SECOND_ASSIGNMENT,
  SNAPSHOT,
  TENANT,
  UNTIL,
  UNTIL_LATER,
  accessScopeId,
  agentHolder,
  assignment,
  catalogEntry,
  cell,
  ceiling,
  connection,
  declaredPrincipal,
  delegation,
  human,
  installation,
  legalEntityId,
  otherTenantId,
  partyEntry,
  projectionIntent,
  revision,
  scopeIntent,
  targetsSelector,
  tenantId,
} from './access-compiler-fixtures.ts';

const compile = (
  scope: Parameters<typeof projectionIntent>[0] = {},
  tenant: Parameters<typeof projectionIntent>[1] = {},
) => {
  const planned = planAccessProjection(projectionIntent(scope, tenant));
  if (Result.isFailure(planned)) {
    throw new Error(`expected a plan, got ${planned.failure.map((error) => error.code).join(', ')}`);
  }
  return planned.success;
};

const failureCodes = (
  scope: Parameters<typeof projectionIntent>[0] = {},
  tenant: Parameters<typeof projectionIntent>[1] = {},
): readonly string[] => {
  const planned = planAccessProjection(projectionIntent(scope, tenant));
  return Result.isFailure(planned) ? planned.failure.map((error) => error.code) : [];
};

const scopeUnit = (overrides: Parameters<typeof projectionIntent>[0] = {}) => {
  const unit = compile(overrides).units.find((planned) => planned.kind === 'scope');
  if (unit === undefined) {
    throw new Error('expected a scope unit');
  }
  return unit;
};

const relationsOf = (unit: ReturnType<typeof scopeUnit>, relation: string): readonly string[] =>
  unit.relationships
    .filter((relationship) => relationship.relation === relation)
    .map((relationship) => `${relationship.resourceType}#${relationship.subject.objectType}`);

const delegated = (
  overrides: Parameters<typeof assignment>[0] = {},
  envelope: Parameters<typeof delegation>[0] = {},
) => ({
  assignments: [
    assignment({
      delegated: { capabilityKeys: [CAP_PAY], delegationId: DELEGATION, until: UNTIL },
      validUntil: UNTIL,
      ...overrides,
    }),
  ],
  delegations: [delegation(envelope)],
});

/** A delegated assignment with the frozen limits a delegation left behind. */
const delegatedTo = (
  limits: Partial<Pick<DelegatedLimits, 'amountCeiling'>> & Pick<DelegatedLimits, 'capabilityKeys'>,
  envelope: Parameters<typeof delegation>[0] = {},
  until: Date = UNTIL,
) => ({
  assignments: [assignment({ delegated: { ...limits, delegationId: DELEGATION, until }, validUntil: UNTIL })],
  delegations: [delegation({ capabilityKeys: [CAP_PAY, CAP_NOTE], ...envelope })],
});

const tenantEntity = () => ({
  accessAdmins: [ADMIN],
  legalEntityId: ENTITY,
  members: [{ holder: human(ALICE) }],
  suspended: [],
});

it('projects one tenant unit, one legal entity unit and one scope unit with the engine links', () => {
  const plan = compile();
  expect(plan.units.map((unit) => unit.kind)).toEqual(['tenant', 'legal_entity', 'scope']);
  const scope = scopeUnit();
  expect(relationsOf(scope, 'tenant')).toEqual(['access_scope#access_tenant']);
  expect(relationsOf(scope, 'legal_entity')).toEqual(['access_scope#access_legal_entity']);
  expect(relationsOf(scope, 'enabled_scope')).toEqual(['access_installation#access_scope']);
  expect(scope.relationships.every((relationship) => relationship.resourceType.startsWith('access_'))).toBe(true);
  expect(plan.connectionCeilings).toEqual([]);
});

it('refuses a projection that leaves a referenced principal kind undeclared, and accepts declared humans', () => {
  expect(failureCodes({}, { principals: [declaredPrincipal(ADMIN)] })).toContain(
    'access_projection_principal_kind_refused',
  );
  expect(failureCodes()).toEqual([]);
});

it('refuses a service, integration or system principal in any projected relation (O46)', () => {
  for (const kind of ['service', 'integration', 'system'] as const) {
    expect(
      failureCodes(
        {},
        {
          principals: [
            declaredPrincipal(ADMIN, kind),
            declaredPrincipal(ALICE),
            declaredPrincipal(BOB),
            declaredPrincipal(AGENT, 'agent'),
          ],
        },
      ),
      kind,
    ).toContain('access_projection_principal_kind_refused');
  }
});

it('refuses an agent run cell of a sensitive capability and allows the propose cell (O48a)', () => {
  expect(
    failureCodes({
      assignments: [assignment({ holder: agentHolder(AGENT) })],
      roleRevisions: [revision({ cells: [cell({ capabilityKey: CAP_MARGINS, mode: 'run' })] })],
    }),
  ).toContain('access_projection_agent_sensitive_run');
  expect(
    failureCodes({
      assignments: [assignment({ holder: agentHolder(AGENT) })],
      roleRevisions: [
        revision({
          cells: [cell({ capabilityKey: CAP_MARGINS, mode: 'propose' }), cell({ capabilityKey: CAP_PAY, mode: 'run' })],
        }),
      ],
    }),
  ).toEqual([]);
});

it('refuses an agent run cell whose risk intent does not declare', () => {
  expect(
    failureCodes(
      { assignments: [assignment({ holder: agentHolder(AGENT) })] },
      { catalogEntries: [catalogEntry({ key: CAP_NOTE })] },
    ),
  ).toContain('access_projection_agent_sensitive_run');
});

it('shares one binding and one grant cell across every holder of a role (M1)', () => {
  const unit = scopeUnit();
  const binding = roleBindingObjectId(TENANT, SCOPE, ROLE);
  const grant = grantObjectId(TENANT, SCOPE, ROLE, cell({ capabilityKey: CAP_PAY, mode: 'run' }));
  expect(unit.relationships.filter((relationship) => relationship.resourceId === binding)).toHaveLength(2);
  expect(unit.relationships.filter((relationship) => relationship.resourceId === grant)).toHaveLength(2);
  expect(relationsOf(unit, 'run_all_grant')).toEqual(['access_capability#access_grant']);
  expect(relationsOf(unit, 'member')).toEqual(['access_role_binding#access_assignment']);
});

it('adds one member tuple for a second holder and no further grant cell', () => {
  const one = scopeUnit();
  const two = scopeUnit({
    assignments: [assignment(), assignment({ holder: human(BOB), incarnationId: SECOND_ASSIGNMENT })],
  });
  expect(two.relationships.filter((relationship) => relationship.relation === 'member')).toHaveLength(2);
  expect(two.relationships.filter((relationship) => relationship.relation === 'holder')).toHaveLength(2);
  expect(two.relationships.filter((relationship) => relationship.relation === 'run_all_grant')).toHaveLength(1);
  expect(two.relationships.filter((relationship) => relationship.relation === 'binding')).toHaveLength(1);
  expect(two.relationships.length - one.relationships.length).toBe(3);
});

it('stamps an assignment end date as the tuple expiration in whole seconds', () => {
  const holder = scopeUnit({ assignments: [assignment({ validUntil: UNTIL })] }).relationships.find(
    (relationship) => relationship.relation === 'holder',
  );
  expect(holder?.expiresAtEpochSeconds).toBe(Math.floor(UNTIL.getTime() / 1000));
});

it('projects no holder, cell or binding for a revoked assignment', () => {
  const unit = scopeUnit({ assignments: [assignment({ status: 'revoked' })] });
  expect(relationsOf(unit, 'holder')).toEqual([]);
  expect(relationsOf(unit, 'member')).toEqual([]);
  expect(relationsOf(unit, 'run_all_grant')).toEqual([]);
});

it('keeps a capability configurable but unusable when its module is not installed', () => {
  const unit = scopeUnit({ installations: [] });
  expect(relationsOf(unit, 'enabled_scope')).toEqual([]);
  expect(relationsOf(unit, 'installation')).toEqual([]);
  expect(relationsOf(unit, 'run_all_grant')).toEqual(['access_capability#access_grant']);
});

it('keeps agent connections out of the graph and reports their ceilings instead', () => {
  const plan = compile({ connections: [connection()] });
  expect(plan.connectionCeilings).toHaveLength(1);
  expect(plan.connectionCeilings[0]?.connectionId).toBeDefined();
  expect(
    plan.units
      .flatMap((unit) => unit.relationships)
      .some((relationship) => relationship.resourceType.includes('connection')),
  ).toBe(false);
});

it('carries the amount ceiling, the target set and both as cell caveats', () => {
  const amount = scopeUnit({
    roleRevisions: [
      revision({ cells: [cell({ amountCeiling: ceiling(10_000), capabilityKey: CAP_PAY, mode: 'run' })] }),
    ],
  }).relationships.find((relationship) => relationship.relation === 'binding');
  expect(amount?.caveat).toEqual({ context: { limit_currency: 'CZK', limit_minor: 10_000 }, name: 'amount_ceiling' });
  const targetCell = scopeUnit({
    roleRevisions: [
      revision({ cells: [cell({ capabilityKey: CAP_PAY, mode: 'run', selector: targetsSelector(['invoice-1']) })] }),
    ],
  }).relationships.find((relationship) => relationship.relation === 'binding');
  expect(targetCell?.caveat).toEqual({ context: { resource_keys: ['invoice-1'] }, name: 'target_set' });
  const both = scopeUnit({
    roleRevisions: [
      revision({
        cells: [
          cell({
            amountCeiling: ceiling(500),
            capabilityKey: CAP_PAY,
            mode: 'run',
            selector: targetsSelector(['invoice-1']),
          }),
        ],
      }),
    ],
  }).relationships.find((relationship) => relationship.relation === 'binding');
  expect(both?.caveat).toEqual({
    context: { limit_currency: 'CZK', limit_minor: 500, resource_keys: ['invoice-1'] },
    name: 'bounded_target_set',
  });
  const plain = scopeUnit().relationships.find((relationship) => relationship.relation === 'binding');
  expect(plain?.caveat).toBeUndefined();
});

it('maps an explicit target cell onto the all slot, never a new slot', () => {
  expect(capabilitySlot(cell({ capabilityKey: CAP_PAY, mode: 'run', selector: targetsSelector(['a']) }))).toBe('all');
  expect(capabilitySlot(cell({ capabilityKey: CAP_PAY, mode: 'propose', selector: { _tag: 'assigned' } }))).toBe(
    'assigned',
  );
  expect(capabilitySlotRelation(cell({ capabilityKey: CAP_PAY, mode: 'approve', selector: { _tag: 'team' } }))).toBe(
    'approve_team_grant',
  );
});

it('refuses all and targets cells of one capability and mode, which the engine would union', () => {
  expect(
    failureCodes({
      roleRevisions: [
        revision({
          cells: [
            cell({ capabilityKey: CAP_PAY, mode: 'run' }),
            cell({ capabilityKey: CAP_PAY, mode: 'run', selector: targetsSelector(['invoice-1']) }),
          ],
        }),
      ],
    }),
  ).toContain('access_projection_duplicate_cell_slot');
});

it('refuses live assignments of one role that pin different revisions', () => {
  expect(
    failureCodes({
      assignments: [assignment(), assignment({ incarnationId: SECOND_ASSIGNMENT, roleRevisionId: NEXT_REVISION })],
      roleRevisions: [revision(), revision({ id: NEXT_REVISION, revision: 2 })],
    }),
  ).toContain('access_projection_ambiguous_role_revision');
});

it('refuses an assignment that pins an unknown revision or a revision of another role', () => {
  expect(failureCodes({ roleRevisions: [] })).toContain('access_projection_unknown_role_revision');
  expect(failureCodes({ roleRevisions: [revision({ roleId: OTHER_ROLE })] })).toContain(
    'access_projection_unknown_role_revision',
  );
});

it('refuses a scope, assignment or connection of another tenant, scope or unprojected legal entity', () => {
  expect(
    failureCodes({
      scope: { id: SCOPE, scope: { _tag: 'LegalEntity', legalEntityId: legalEntityId(99), tenantId: TENANT } },
    }),
  ).toContain('access_projection_scope_mismatch');
  expect(failureCodes({ assignments: [assignment({ scopeId: OTHER_SCOPE })] })).toContain(
    'access_projection_scope_mismatch',
  );
  expect(failureCodes({ delegations: [delegation({ scopeId: OTHER_SCOPE })] })).toContain(
    'access_projection_scope_mismatch',
  );
  expect(failureCodes({ connections: [connection({ scopeId: OTHER_SCOPE })] })).toContain(
    'access_projection_scope_mismatch',
  );
  expect(failureCodes({ scope: { id: SCOPE, scope: { _tag: 'TenantContext', tenantId: TENANT } } })).toEqual([]);
});

it('refuses a delegated assignment outside its envelope and accepts a contained one', () => {
  expect(failureCodes(delegated())).toEqual([]);
  expect(failureCodes({ ...delegated(), delegations: [] })).toContain('access_projection_delegation_containment');
  expect(failureCodes(delegated({}, { people: [BOB] }))).toContain('access_projection_delegation_containment');
  expect(failureCodes(delegated({}, { roleIds: [OTHER_ROLE] }))).toContain('access_projection_delegation_containment');
  expect(failureCodes(delegated({ validUntil: UNTIL_LATER }))).toContain('access_projection_delegation_containment');
  expect(failureCodes(delegated({}, { capabilityKeys: [CAP_NOTE] }))).toContain(
    'access_projection_delegation_containment',
  );
  expect(
    failureCodes({
      assignments: [
        assignment({
          delegated: { amountCeiling: ceiling(500), capabilityKeys: [CAP_PAY], delegationId: DELEGATION, until: UNTIL },
          validUntil: UNTIL,
        }),
      ],
      delegations: [delegation({ amountCeiling: ceiling(100) })],
      roleRevisions: [
        revision({ cells: [cell({ amountCeiling: ceiling(500), capabilityKey: CAP_PAY, mode: 'run' })] }),
      ],
    }),
  ).toContain('access_projection_delegation_containment');
});

it('links a delegated manager to the capabilities inside the envelope only', () => {
  const unit = scopeUnit({
    delegations: [delegation({ capabilityKeys: [CAP_PAY] })],
    roleRevisions: [
      revision({
        cells: [cell({ capabilityKey: CAP_PAY, mode: 'run' }), cell({ capabilityKey: CAP_NOTE, mode: 'run' })],
      }),
    ],
  });
  const managed = unit.relationships.filter((relationship) => relationship.relation === 'delegated_manager');
  expect(managed).toHaveLength(1);
  expect(managed[0]?.resourceId).toBe(capabilityObjectId(TENANT, SCOPE, CAP_PAY));
  expect(relationsOf(unit, 'manager')).toEqual(['access_delegation#access_human']);
});

it('refuses a duplicate tenant, legal entity or scope in one intent', () => {
  expect(failureCodes({}, { scopes: [scopeIntent(), scopeIntent()] })).toContain('access_projection_duplicate_intent');
  expect(failureCodes({}, { legalEntities: [tenantEntity(), tenantEntity()] })).toContain(
    'access_projection_duplicate_intent',
  );
});

it('reports every violation of one intent at once and produces no plan', () => {
  const codes = failureCodes({ assignments: [assignment({ scopeId: OTHER_SCOPE })] }, { principals: [] });
  expect(new Set(codes)).toContain('access_projection_scope_mismatch');
  expect(new Set(codes)).toContain('access_projection_principal_kind_refused');
  expect(codes.length).toBeGreaterThan(1);
});

it('plans deterministically, so a fingerprint over the canonical lines is stable', () => {
  const forward = compile({
    assignments: [assignment(), assignment({ holder: human(BOB), incarnationId: SECOND_ASSIGNMENT })],
  });
  const reversed = compile({
    assignments: [assignment({ holder: human(BOB), incarnationId: SECOND_ASSIGNMENT }), assignment()],
  });
  expect(forward.lines).toEqual(reversed.lines);
  expect(forward.units.flatMap((unit) => unit.relationships.map(relationshipKey))).toEqual(
    forward.units.flatMap((unit) => unit.relationships.map(relationshipKey)),
  );
});

it('keeps every projected object ID decodable back to the record it came from', () => {
  const planned = compile();
  const objects = planned.units
    .flatMap((unit) => unit.relationships)
    .flatMap((relationship) => [relationship.resourceId, relationship.subject.objectId]);
  for (const objectId of objects.filter(
    (value) => value.startsWith('sc_') || value.startsWith('le_') || value.startsWith('tn_'),
  )) {
    expect(Option.isSome(decodeObjectId(objectId)), objectId).toBe(true);
  }
  expect(Option.isNone(decodeObjectId('not-an-access-id'))).toBe(true);
  expect(isProjectableObjectId('x'.repeat(1025))).toBe(false);
  expect(isProjectableObjectId('sc_abc')).toBe(true);
  expect(accessScopeId(3)).toBe(SCOPE);
  expect(tenantId(1)).toBe(TENANT);
  expect(MODULE).toBe('party.registry');
  expect(REVISION).not.toBe(NEXT_REVISION);
  expect(ASSIGNMENT).not.toBe(SECOND_ASSIGNMENT);
  expect(SNAPSHOT.length).toBe(36);
});

it('keeps a capability configurable but never links a module key it only shares a prefix with (H5, O27)', () => {
  const dotted = scopeUnit();
  expect(relationsOf(dotted, 'installation')).toEqual(['access_capability#access_installation']);

  // The real module key is dotted, so a single-segment module that merely prefixes it enables nothing.
  const prefixOnly = scopeUnit({ installations: [installation(PREFIX_MODULE)] });
  expect(relationsOf(prefixOnly, 'installation')).toEqual([]);
  expect(relationsOf(prefixOnly, 'enabled_scope')).toEqual(['access_installation#access_scope']);
  expect(relationsOf(prefixOnly, 'run_all_grant')).toEqual(['access_capability#access_grant']);

  const twoModules = scopeUnit({
    installations: [installation(MODULE), installation(OTHER_MODULE)],
    roleRevisions: [
      revision({
        cells: [cell({ capabilityKey: CAP_PAY, mode: 'run' }), cell({ capabilityKey: CAP_OTHER_MODULE, mode: 'run' })],
      }),
    ],
  });
  const links = twoModules.relationships.filter((relationship) => relationship.relation === 'installation');
  expect(links).toHaveLength(2);
  expect(new Set(links.map((relationship) => relationship.subject.objectId)).size).toBe(2);
  expect(relationsOf(twoModules, 'enabled_scope')).toEqual([
    'access_installation#access_scope',
    'access_installation#access_scope',
  ]);
});

it('refuses the same module installed twice in one scope', () => {
  expect(failureCodes({ installations: [installation(MODULE), installation(MODULE)] })).toContain(
    'access_projection_duplicate_intent',
  );
});

it('names one record inside its tenant, scope and module, never by the bare record key (H3)', () => {
  const objectId = recordObjectId(TENANT, SCOPE, MODULE, 'invoice-1');
  expect(objectId.startsWith('rc_')).toBe(true);
  expect(isProjectableObjectId(objectId)).toBe(true);
  expect(Option.getOrNull(decodeObjectId(objectId))).toEqual({
    kind: 'record',
    parts: [TENANT, SCOPE, MODULE, 'invoice-1'],
  });
  // The same record key in another tenant, scope or module is another object, so a target check can
  // never be satisfied by a record the decision was not resolved for.
  const ids = [
    objectId,
    recordObjectId(otherTenantId(2), SCOPE, MODULE, 'invoice-1'),
    recordObjectId(TENANT, OTHER_SCOPE, MODULE, 'invoice-1'),
    recordObjectId(TENANT, SCOPE, OTHER_MODULE, 'invoice-1'),
    recordObjectId(TENANT, SCOPE, MODULE, 'invoice-2'),
  ];
  expect(new Set(ids).size).toBe(ids.length);
  expect(objectId).not.toBe('invoice-1');
});

it('refuses a cell the pinned catalog entry does not declare (M5)', () => {
  const onlyPay = { catalogEntries: [{ ...partyEntry(CAP_PAY), amountInput: 'payload.amountMinor' }] };
  // A key outside the pinned snapshot is never granted, whatever the revision says.
  expect(
    failureCodes({ roleRevisions: [revision({ cells: [cell({ capabilityKey: CAP_NOTE, mode: 'run' })] })] }, onlyPay),
  ).toContain('access_projection_unknown_capability');
  // A mode the declaration does not have.
  expect(
    failureCodes(
      { roleRevisions: [revision({ cells: [cell({ capabilityKey: CAP_PAY, mode: 'approve' })] })] },
      { catalogEntries: [{ ...partyEntry(CAP_PAY), modes: ['run'] }] },
    ),
  ).toContain('access_projection_cell_outside_declaration');
  // A named selector the declaration does not support, and a target set on a capability that is not
  // record-scoped at all.
  expect(
    failureCodes(
      {
        roleRevisions: [
          revision({ cells: [cell({ capabilityKey: CAP_PAY, mode: 'run', selector: { _tag: 'team' } })] }),
        ],
      },
      { catalogEntries: [{ ...partyEntry(CAP_PAY), selectors: ['assigned'] }] },
    ),
  ).toContain('access_projection_cell_outside_declaration');
  expect(
    failureCodes(
      {
        roleRevisions: [
          revision({
            cells: [cell({ capabilityKey: CAP_PAY, mode: 'run', selector: targetsSelector(['invoice-1']) })],
          }),
        ],
      },
      { catalogEntries: [{ ...partyEntry(CAP_PAY), selectors: [] }] },
    ),
  ).toContain('access_projection_cell_outside_declaration');
  // A money limit on a capability that declares no amount input.
  expect(
    failureCodes({
      roleRevisions: [
        revision({ cells: [cell({ amountCeiling: ceiling(100), capabilityKey: CAP_NOTE, mode: 'run' })] }),
      ],
    }),
  ).toContain('access_projection_limit_without_amount_input');
  // The declared cell plans.
  expect(
    failureCodes({
      roleRevisions: [
        revision({ cells: [cell({ amountCeiling: ceiling(100), capabilityKey: CAP_PAY, mode: 'run' })] }),
      ],
    }),
  ).toEqual([]);
});

it('refuses a delegated role that grew past the frozen limits (H6)', () => {
  // The frozen limits name only PAY, and a role edit added NOTE: the shared binding would hand the
  // delegated holder a capability the delegate was never given.
  expect(
    failureCodes({
      ...delegatedTo({ capabilityKeys: [CAP_PAY] }),
      roleRevisions: [
        revision({
          cells: [cell({ capabilityKey: CAP_PAY, mode: 'run' }), cell({ capabilityKey: CAP_NOTE, mode: 'run' })],
        }),
      ],
    }),
  ).toContain('access_projection_delegation_containment');
  // Frozen limit 100, role cell 900, envelope 1000.
  expect(
    failureCodes({
      ...delegatedTo({ amountCeiling: ceiling(100), capabilityKeys: [CAP_PAY] }, { amountCeiling: ceiling(1000) }),
      roleRevisions: [
        revision({ cells: [cell({ amountCeiling: ceiling(900), capabilityKey: CAP_PAY, mode: 'run' })] }),
      ],
    }),
  ).toContain('access_projection_delegation_containment');
  // A capped envelope never holds a money cell without a ceiling: that cell is unlimited authority.
  expect(
    failureCodes({
      ...delegatedTo({ capabilityKeys: [CAP_PAY] }, { amountCeiling: ceiling(1000) }),
      roleRevisions: [revision({ cells: [cell({ capabilityKey: CAP_PAY, mode: 'run' })] })],
    }),
  ).toContain('access_projection_delegation_containment');
  // A delegated assignment outliving the limits frozen from its delegation.
  expect(
    failureCodes({
      ...delegatedTo({ capabilityKeys: [CAP_PAY] }, {}, AT),
      roleRevisions: [revision({ cells: [cell({ capabilityKey: CAP_PAY, mode: 'run' })] })],
    }),
  ).toContain('access_projection_delegation_containment');
  // Inside the frozen limits the projection lands.
  expect(
    failureCodes({
      ...delegatedTo({ amountCeiling: ceiling(1000), capabilityKeys: [CAP_PAY] }, { amountCeiling: ceiling(1000) }),
      roleRevisions: [
        revision({ cells: [cell({ amountCeiling: ceiling(900), capabilityKey: CAP_PAY, mode: 'run' })] }),
      ],
    }),
  ).toEqual([]);
});

it('checks the object ID ceiling of a legal entity unit, not only of a scope (L5)', () => {
  const codes = failureCodes(
    {},
    {
      legalEntities: [{ accessAdmins: [], legalEntityId: 'e'.repeat(1200), members: [], suspended: [] }],
      scopes: [],
    },
  );
  expect(codes).toContain('access_projection_identifier_too_long');
  // A capability key the declaration grammar allows still derives a projectable object ID.
  expect(isProjectableObjectId(capabilityObjectId(TENANT, SCOPE, 'a'.repeat(200)))).toBe(true);
});
