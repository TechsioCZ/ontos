import { describe, expect, it } from 'effect-rstest';

import { configureBasesOf } from '../../src/access/changes/authority.ts';
import type { ScopeProjectionIntent, TenantProjectionIntent } from '../../src/access/compiler/intent.ts';
import type { AccessMembership } from '../../src/access/intent/memberships.ts';
import { AccessMembershipSchema } from '../../src/access/intent/memberships.ts';
import { DelegationSchema } from '../../src/access/model.ts';
import {
  LEGAL_ENTITY,
  MANAGER,
  OTHER_PERSON,
  PERSON,
  TENANT,
  brandPrincipalId,
  decodeWith,
  delegation,
  fixedId,
  instant,
  legalEntityScopeRecord,
  tenantIdValue,
  tenantScopeRecord,
} from './access-changes-fixtures.ts';

const actor = brandPrincipalId(PERSON);
const now = instant(12);
const tenantScope = tenantScopeRecord(fixedId(90));
const companyScope = legalEntityScopeRecord();
const companyProjection: ScopeProjectionIntent = {
  assignments: [],
  connections: [],
  delegations: [],
  installations: [],
  roleRevisions: [],
  scope: companyScope,
};
const intent = (overrides: Partial<TenantProjectionIntent> = {}): TenantProjectionIntent => ({
  catalogEntries: [],
  coverage: 'complete',
  legalEntities: [],
  members: [],
  owners: [],
  principals: [],
  scopes: [companyProjection, { ...companyProjection, scope: tenantScope }],
  suspended: [],
  tenantId: tenantIdValue(TENANT),
  ...overrides,
});
const membership = (overrides: Partial<AccessMembership> = {}): AccessMembership =>
  decodeWith('configure membership', AccessMembershipSchema, {
    createdAt: instant(0),
    holder: { _tag: 'Principal', principalId: PERSON },
    id: fixedId(91),
    kind: 'member',
    recordedBy: PERSON,
    scopeId: companyScope.id,
    status: 'active',
    tenantId: TENANT,
    validFrom: instant(0),
    ...overrides,
  });
const tenantMember = membership({ scopeId: tenantScope.id });
const companyMember = membership();
const companyAdmin = membership({ kind: 'access_admin', validUntil: instant(20) });
const bases = (memberships: readonly AccessMembership[], source = intent()) =>
  configureBasesOf({ actor, at: now, intent: source, memberships });

const invalidMembers = [
  { label: 'missing', rows: [] },
  { label: 'suspended', rows: [membership({ status: 'suspended' })] },
  { label: 'revoked', rows: [membership({ status: 'revoked' })] },
  { label: 'ended', rows: [membership({ validUntil: now })] },
  { label: 'future', rows: [membership({ validFrom: instant(13) })] },
  {
    label: 'another person',
    rows: [membership({ holder: { _tag: 'Principal', principalId: brandPrincipalId(OTHER_PERSON) } })],
  },
  { label: 'another scope', rows: [membership({ scopeId: tenantScope.id })] },
];

describe('configure authority requires live operational membership', () => {
  it('retains a company administrator with both memberships', () => {
    expect(bases([tenantMember, companyMember, companyAdmin])).toEqual([
      {
        _tag: 'ScopeAdmin',
        deadlines: [{ legalEntityId: LEGAL_ENTITY, until: instant(20) }],
        legalEntityIds: [LEGAL_ENTITY],
        tenantContext: false,
      },
    ]);
  });

  it.each(invalidMembers)('refuses company authority with $label company membership', ({ rows }) => {
    expect(bases([tenantMember, companyAdmin, ...rows])).toEqual([]);
  });

  it('does not let an active row mask a live suspension of the same company member', () => {
    expect(bases([tenantMember, companyAdmin, companyMember, membership({ status: 'suspended' })])).toEqual([]);
  });

  it('requires tenant membership in addition to company membership', () => {
    expect(bases([companyMember, companyAdmin])).toEqual([]);
  });

  it('bounds company authority by the earlier company membership deadline', () => {
    const result = bases([tenantMember, companyAdmin, membership({ validUntil: instant(14) })]);
    expect(result).toEqual([
      {
        _tag: 'ScopeAdmin',
        deadlines: [{ legalEntityId: LEGAL_ENTITY, until: instant(14) }],
        legalEntityIds: [LEGAL_ENTITY],
        tenantContext: false,
      },
    ]);
  });

  it('bounds company authority by the earlier tenant membership deadline', () => {
    const result = bases([
      membership({ scopeId: tenantScope.id, validUntil: instant(13) }),
      companyAdmin,
      companyMember,
    ]);
    expect(result).toEqual([
      {
        _tag: 'ScopeAdmin',
        deadlines: [{ legalEntityId: LEGAL_ENTITY, until: instant(13) }],
        legalEntityIds: [LEGAL_ENTITY],
        tenantContext: false,
      },
    ]);
  });

  it('requires live tenant membership even for an owner', () => {
    expect(bases([companyMember], intent({ owners: [actor] }))).toEqual([]);
    expect(bases([tenantMember], intent({ owners: [actor] }))).toEqual([{ _tag: 'Owner' }]);
  });

  it('requires company membership for a company delegation without requiring it for tenant ownership', () => {
    const companyDelegation = decodeWith('company delegation', DelegationSchema, {
      ...delegation({ scopeId: companyScope.id }),
      grantedBy: MANAGER,
      managerId: PERSON,
    });
    const source = intent({
      scopes: [
        { ...companyProjection, delegations: [companyDelegation] },
        { ...companyProjection, scope: tenantScope },
      ],
    });
    expect(bases([tenantMember], source)).toEqual([]);
    expect(bases([tenantMember, companyMember], source)).toEqual([
      { _tag: 'DelegatedManager', delegation: companyDelegation, scope: companyScope },
    ]);
  });
});
