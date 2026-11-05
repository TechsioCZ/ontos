import type { CatalogSnapshotEntry } from '../../src/access/model.ts';
import { AccessChangeItemSchema, CatalogSnapshotSchema } from '../../src/access/model.ts';
import { LegalEntityIdSchema, RoleIdSchema } from '../../src/access/ids.ts';
import {
  decisionScopeIssue,
  itemDecisionFactsOf,
  publishedReleaseView,
  roleNamesOf,
} from '../../src/access/changes/commands.ts';
import { describe, expect, test } from 'effect-rstest';
import { Option } from 'effect';

import {
  cell,
  decodeWith,
  entry,
  fixedId,
  instant,
  roleState,
  CATALOG,
  CATALOG_DIGEST,
  LEGAL_ENTITY,
  OTHER_LEGAL_ENTITY,
  OTHER_ROLE,
  ROLE,
} from './access-changes-fixtures.ts';

/*
 * The one batch rule of Novinky (guarantee 2, D7c; P10's safety requirement): an item may be adopted
 * together with others only when it is pending in the very release being adopted, its effective risk
 * is routine, and the adoption widens no role. This is computed in Core from the cells the decision
 * would write — never from the item's risk, and never in the browser.
 */

const ENTRIES = new Map<string, CatalogSnapshotEntry>();

const item = (input: {
  readonly capabilityKey: string;
  readonly catalogSnapshotId?: string;
  readonly kind?: string;
  readonly risk?: string;
  readonly status?: string;
  readonly suggestedRoleIds?: readonly string[];
}) =>
  decodeWith('change item', AccessChangeItemSchema, {
    capabilityKey: input.capabilityKey,
    catalogSnapshotId: input.catalogSnapshotId ?? CATALOG,
    createdAt: instant(9),
    id: fixedId(500),
    kind: input.kind ?? 'new',
    lineageFrom: [],
    risk: input.risk ?? 'routine',
    status: input.status ?? 'pending',
    suggestedRoleIds: input.suggestedRoleIds ?? [ROLE],
    tenantId: fixedId(1),
  });

const withEntry = (value: CatalogSnapshotEntry): ReadonlyMap<string, CatalogSnapshotEntry> =>
  new Map([[value.key, value]]);

describe('Novinky batch rule', () => {
  test('a routine capability a role does not hold yet widens, so it is never a one-click batch', () => {
    const catalogEntry = entry({ key: 'party.registry.party.read', kind: 'read', risk: 'routine' });
    const facts = itemDecisionFactsOf({
      entries: withEntry(catalogEntry),
      item: item({ capabilityKey: 'party.registry.party.read' }),
      releaseId: CATALOG,
      roles: [roleState({ cells: [] })],
    });

    expect(facts.widens).toBe(true);
    expect(facts.batchEligible).toBe(false);
    expect(facts.addedCells).toHaveLength(1);
    expect(facts.removedCells).toHaveLength(0);
    expect(facts.addedCells[0]?.roleId).toBe(ROLE);
  });

  test('a routine capability the role already holds changes nothing, so it carries no widening', () => {
    const catalogEntry = entry({ key: 'party.registry.party.read', kind: 'read', risk: 'routine' });
    const facts = itemDecisionFactsOf({
      entries: withEntry(catalogEntry),
      item: item({ capabilityKey: 'party.registry.party.read' }),
      releaseId: CATALOG,
      roles: [roleState({ cells: [cell('party.registry.party.read')] })],
    });

    expect(facts.widens).toBe(false);
    expect(facts.batchEligible).toBe(true);
    expect(facts.addedCells).toHaveLength(0);
  });

  test('a removed capability only takes cells away, so it stays batchable while it narrows', () => {
    const facts = itemDecisionFactsOf({
      entries: ENTRIES,
      item: item({ capabilityKey: 'party.registry.party.read', kind: 'removed' }),
      releaseId: CATALOG,
      roles: [roleState({ cells: [cell('party.registry.party.read')] })],
    });

    expect(facts.widens).toBe(false);
    expect(facts.batchEligible).toBe(true);
    expect(facts.addedCells).toHaveLength(0);
    expect(facts.removedCells).toHaveLength(1);
  });

  test('a sensitive or critical item is decided alone even when it narrows', () => {
    const facts = itemDecisionFactsOf({
      entries: ENTRIES,
      item: item({ capabilityKey: 'party.registry.party.read', kind: 'removed', risk: 'critical' }),
      releaseId: CATALOG,
      roles: [roleState({ cells: [cell('party.registry.party.read')] })],
    });

    expect(facts.widens).toBe(false);
    expect(facts.batchEligible).toBe(false);
  });

  test('an item of an older release is never batched with the release being adopted', () => {
    const catalogEntry = entry({ key: 'party.registry.party.read', kind: 'read', risk: 'routine' });
    const facts = itemDecisionFactsOf({
      entries: withEntry(catalogEntry),
      item: item({ capabilityKey: 'party.registry.party.read', catalogSnapshotId: fixedId(999) }),
      releaseId: CATALOG,
      roles: [roleState({ cells: [cell('party.registry.party.read')] })],
    });

    expect(facts.batchEligible).toBe(false);
  });

  test('a decided item is never offered again, whatever its risk', () => {
    const catalogEntry = entry({ key: 'party.registry.party.read', kind: 'read', risk: 'routine' });
    for (const status of ['adopted', 'declined', 'undone']) {
      const facts = itemDecisionFactsOf({
        entries: withEntry(catalogEntry),
        item: item({ capabilityKey: 'party.registry.party.read', status }),
        releaseId: CATALOG,
        roles: [roleState({ cells: [cell('party.registry.party.read')] })],
      });
      expect(facts.batchEligible).toBe(false);
    }
  });

  test('a capability with several record scopes cannot be adopted blind, so it is never batchable', () => {
    const catalogEntry = entry({
      key: 'party.registry.party.read',
      kind: 'read',
      risk: 'routine',
      selectors: ['all', 'assigned'],
    });
    const facts = itemDecisionFactsOf({
      entries: withEntry(catalogEntry),
      item: item({ capabilityKey: 'party.registry.party.read' }),
      releaseId: CATALOG,
      roles: [roleState({ cells: [] })],
    });

    expect(facts.widens).toBe(true);
    expect(facts.batchEligible).toBe(false);
    expect(facts.addedCells).toHaveLength(0);
  });

  test('a risk a later release raised leaves the item un-batchable even when nothing widens', () => {
    const catalogEntry = entry({ key: 'party.registry.party.read', kind: 'read', risk: 'critical' });
    const facts = itemDecisionFactsOf({
      entries: withEntry(catalogEntry),
      item: item({ capabilityKey: 'party.registry.party.read', kind: 'risk_changed' }),
      releaseId: CATALOG,
      roles: [roleState({ cells: [cell('party.registry.party.read')] })],
    });

    expect(facts.widens).toBe(false);
    expect(facts.batchEligible).toBe(false);
  });
});

/*
 * The released catalog on its own. A Proč? explanation asks the gate about a declaration the release
 * published, so it needs the release and nothing else: reading a tenant's items, decisions, roles and
 * holder preview to explain one decision would make the cheapest question the most expensive one.
 */
describe('released catalog read', () => {
  const snapshot = decodeWith('catalog snapshot', CatalogSnapshotSchema, {
    digest: CATALOG_DIGEST,
    entries: [entry({ key: 'party.registry.party.read', kind: 'read', risk: 'routine' })],
    id: CATALOG,
    publishedAt: instant(1),
  });

  test('carries the release field for field and nothing of any tenant', () => {
    const published = Option.getOrThrow(publishedReleaseView(Option.some(snapshot)));

    expect(published.catalogSnapshotId).toBe(CATALOG);
    expect(published.digest).toBe(CATALOG_DIGEST);
    expect(published.publishedAt).toEqual(instant(1));
    expect(published.entries.map(({ key }) => key)).toEqual(['party.registry.party.read']);
    expect(Object.keys(published).toSorted()).toEqual(['catalogSnapshotId', 'digest', 'entries', 'publishedAt']);
  });

  test('is absent until a release is published, so no explanation rests on a default catalog', () => {
    expect(Option.isNone(publishedReleaseView(Option.none()))).toBe(true);
  });
});

/*
 * The label read. An explanation names the role that granted a decision it already holds the id of,
 * so it needs every name at once and nothing else: no cells, no holders, no revision history.
 */
describe('role names read', () => {
  test('keys every role of the tenant by id and carries nothing of the cells or the holders', () => {
    const roles = [roleState({ cells: [] }), roleState({ roleId: OTHER_ROLE })];
    const names = roleNamesOf(roles);

    expect(names.size).toBe(2);
    expect(new Set(names.keys())).toEqual(new Set(roles.map(({ role }) => role.id)));
    expect([...names.values()]).toEqual(roles.map(({ role }) => role.name));
  });
});

/*
 * O88: a decision taken for one company reaches that company's roles only - a tenant-wide role is out
 * of reach for a company decision, and so is another company's. Refused and named, never filtered down
 * to the roles that happened to fit, which would leave a half-applied change behind.
 */
describe('decision target', () => {
  const company = decodeWith('legal entity id', LegalEntityIdSchema, LEGAL_ENTITY);
  const companyRole = decodeWith('role id', RoleIdSchema, fixedId(22));
  const tenantRole = decodeWith('role id', RoleIdSchema, ROLE);
  const foreignRole = decodeWith('role id', RoleIdSchema, OTHER_ROLE);
  const roles = [
    roleState({ cells: [] }),
    roleState({ legalEntityId: LEGAL_ENTITY, roleId: fixedId(22) }),
    roleState({ legalEntityId: OTHER_LEGAL_ENTITY, roleId: OTHER_ROLE }),
  ];

  test('a tenant decision is unchanged: tenant authority already covers the roles it covers', () => {
    const issue = decisionScopeIssue({ roleIds: [tenantRole, foreignRole], roles });

    expect(issue).toBeUndefined();
  });

  test('a company decision reaches its own company role only, and names what it cannot reach', () => {
    expect(decisionScopeIssue({ legalEntityId: company, roleIds: [companyRole], roles })).toBeUndefined();

    const tenantWide = decisionScopeIssue({ legalEntityId: company, roleIds: [companyRole, tenantRole], roles });
    expect(tenantWide?.code).toBe('access_changes_target_invalid');
    expect(tenantWide?.reason).toContain(tenantRole);

    const foreign = decisionScopeIssue({ legalEntityId: company, roleIds: [foreignRole], roles });
    expect(foreign?.code).toBe('access_changes_target_invalid');
    expect(foreign?.reason).toContain(foreignRole);
  });
});
