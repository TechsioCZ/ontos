import { DateTime, Option, Result } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { FULL_ACCESS_ROLE_TEMPLATE_KEY, compileFullAccessRole } from '../../src/access/bootstrap/full-access-role.ts';
import {
  buildAccessCatalogRelease,
  buildDeploymentCatalogRelease,
  catalogReleaseDigest,
  catalogReleaseId,
} from '../../src/access/catalog/release.ts';
import { orderCatalogRelease } from '../../src/access/catalog/release-ordering.ts';
import type { RoleWithRevision } from '../../src/access/changes/role-edits.ts';
import {
  CapabilityKeySchema,
  ModuleKeySchema,
  PrincipalIdSchema,
  RoleIdSchema,
  RoleRevisionIdSchema,
  RoleTemplateKeySchema,
  TenantIdSchema,
} from '../../src/access/ids.ts';
import type { AccessChangeItem, Cell, CatalogSnapshot, CatalogSnapshotEntry } from '../../src/access/model.ts';
import { planTenantReleaseFollow, releaseActorId } from '../../src/access/release/activation.ts';
import type { AccessCatalogModule, AccessDeclarationInput } from '../../src/authorization/access-declaration.ts';
import { defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';

/*
 * Release activation (ADR-0030): the deployment's catalog becomes the newest release only when it is newer,
 * "Plný přístup" follows it by additions alone, and every other role gets Novinky instead of grants.
 */
const uid = (value: number) => `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;
const tenantId = TenantIdSchema.make(uid(1));
const owner = PrincipalIdSchema.make(uid(2));
const at = DateTime.toDateUtc(DateTime.makeUnsafe('2026-11-10T12:00:00Z'));
const MODULE = 'billing.invoices';

const entry = (key: string, overrides: Partial<CatalogSnapshotEntry> = {}): CatalogSnapshotEntry => ({
  key: CapabilityKeySchema.make(key),
  kind: 'action',
  modes: ['run', 'propose'],
  moduleKey: ModuleKeySchema.make(MODULE),
  placement: { group: 'invoices', level: 'manage' },
  risk: 'sensitive',
  selectors: [],
  ...overrides,
});

const releaseOf = (entries: readonly CatalogSnapshotEntry[], publishedAt = at): CatalogSnapshot => {
  const digest = catalogReleaseDigest(entries);
  return { digest, entries: [...entries], id: catalogReleaseId(digest), publishedAt };
};

const READ = 'billing.invoices.invoice.read';
const APPROVE = 'billing.invoices.invoice.approve';
const VOID = 'billing.invoices.invoice.void';

const first = releaseOf([
  entry(READ, { kind: 'read', modes: ['run'], placement: { group: 'invoices', level: 'basic' }, risk: 'routine' }),
]);
const second = releaseOf([...first.entries, entry(APPROVE)]);
const third = releaseOf([...second.entries, entry(VOID, { modes: ['run', 'propose', 'approve'], risk: 'critical' })]);

const cellsOf = (release: CatalogSnapshot): readonly Cell[] => Result.getOrThrow(compileFullAccessRole(release)).cells;

const manualRole = (input: {
  readonly cells: readonly Cell[];
  readonly id: number;
  readonly pinned: CatalogSnapshot;
  readonly provenance: 'customer_changed' | 'manual' | 'template';
}): RoleWithRevision => ({
  revision: {
    catalogSnapshotId: input.pinned.id,
    cells: [...input.cells],
    createdAt: at,
    createdBy: owner,
    id: RoleRevisionIdSchema.make(uid(input.id + 100)),
    provenance: input.provenance,
    revision: 1,
    roleId: RoleIdSchema.make(uid(input.id)),
    tenantId,
  },
  role: {
    createdAt: at,
    createdBy: owner,
    id: RoleIdSchema.make(uid(input.id)),
    name: `Role ${String(input.id)}`,
    tenantId,
  },
});

const role = (input: Parameters<typeof manualRole>[0]): RoleWithRevision => {
  const built = manualRole(input);
  if (input.provenance === 'manual') {
    return built;
  }
  const revision = { ...built.revision, templateKey: RoleTemplateKeySchema.make(FULL_ACCESS_ROLE_TEMPLATE_KEY) };
  return { ...built, revision };
};

const planned = (
  roles: readonly RoleWithRevision[],
  newest: CatalogSnapshot,
  pinned: readonly CatalogSnapshot[] = [],
  items: readonly AccessChangeItem[] = [],
) =>
  planTenantReleaseFollow({
    createdAt: at,
    newest,
    pinnedReleases: new Map(pinned.map((release) => [release.id, release] as const)),
    state: { items, roles },
    tenantId,
  });
const plan = (...input: Parameters<typeof planned>) => Result.getOrThrow(planned(...input));

const keysOf = (cells: readonly Cell[]) => [...new Set(cells.map(({ capabilityKey }) => capabilityKey))].toSorted();

describe('ordering a deployment catalog against the published releases', () => {
  it('publishes the first release and a wider one, and recognises the newest one', () => {
    expect(orderCatalogRelease({ candidate: first, newest: Option.none(), publishedDigests: new Set() })).toEqual({
      _tag: 'Publish',
    });
    const published = new Set([first.digest]);
    expect(orderCatalogRelease({ candidate: second, newest: Option.some(first), publishedDigests: published })).toEqual(
      {
        _tag: 'Publish',
      },
    );
    expect(orderCatalogRelease({ candidate: first, newest: Option.some(first), publishedDigests: published })).toEqual({
      _tag: 'Current',
    });
  });

  it('never lets an older catalog become the newest release again', () => {
    // A deployment that already published its release and restarts while a newer one serves.
    expect(
      orderCatalogRelease({
        candidate: first,
        newest: Option.some(second),
        publishedDigests: new Set([first.digest, second.digest]),
      }),
    ).toEqual({ _tag: 'Superseded', reason: 'published_before' });
    // An older deployment whose own activation never published: narrower than the newest release.
    expect(
      orderCatalogRelease({
        candidate: second,
        newest: Option.some(third),
        publishedDigests: new Set([first.digest, third.digest]),
      }),
    ).toEqual({ _tag: 'Superseded', reason: 'not_a_successor' });
  });

  it('never publishes an older catalog that still holds what the newest release renamed or narrowed', () => {
    // The newest release renamed `void` to `cancel`; an older deployment never published still declares `void`.
    const cancel = entry('billing.invoices.invoice.cancel', {
      lineage: { renamedFrom: [CapabilityKeySchema.make(VOID)] },
      modes: ['run', 'propose', 'approve'],
      risk: 'critical',
    });
    const renamed = releaseOf([...second.entries, cancel]);
    expect(
      orderCatalogRelease({
        candidate: third,
        newest: Option.some(renamed),
        publishedDigests: new Set([renamed.digest]),
      }),
    ).toEqual({
      _tag: 'Superseded',
      reason: 'not_a_successor',
    });
    // The rename itself moved `void` along declared lineage, so it was a successor of the release before.
    expect(
      orderCatalogRelease({
        candidate: renamed,
        newest: Option.some(third),
        publishedDigests: new Set([third.digest]),
      }),
    ).toEqual({
      _tag: 'Publish',
    });
    // Dropping a mode the newest release declares is a narrowing, whatever else the catalog adds.
    const narrowed = releaseOf([
      ...first.entries,
      entry(APPROVE, { modes: ['propose'] }),
      entry('billing.invoices.invoice.export', { kind: 'read', modes: ['run'] }),
    ]);
    expect(
      orderCatalogRelease({
        candidate: narrowed,
        newest: Option.some(second),
        publishedDigests: new Set([second.digest]),
      }),
    ).toEqual({
      _tag: 'Superseded',
      reason: 'not_a_successor',
    });
  });

  it('withholds a plain removal, which stays inert in the newest release', () => {
    expect(
      orderCatalogRelease({
        candidate: first,
        newest: Option.some(second),
        publishedDigests: new Set([second.digest]),
      }),
    ).toEqual({
      _tag: 'Superseded',
      reason: 'not_a_successor',
    });
  });

  it('keeps the newest release when the newer deployment restarts after an older one tried', () => {
    const published = new Set([first.digest, third.digest]);
    expect(
      orderCatalogRelease({ candidate: second, newest: Option.some(third), publishedDigests: published })._tag,
    ).toBe('Superseded');
    expect(orderCatalogRelease({ candidate: third, newest: Option.some(third), publishedDigests: published })).toEqual({
      _tag: 'Current',
    });
  });

  it('publishes a catalog whose entries changed even when it declares the same keys', () => {
    const riskier = releaseOf([
      first.entries[0] ?? entry(READ),
      entry(APPROVE, { modes: ['run', 'propose'], risk: 'critical' }),
    ]);
    expect(
      orderCatalogRelease({
        candidate: riskier,
        newest: Option.some(second),
        publishedDigests: new Set([second.digest]),
      }),
    ).toEqual({
      _tag: 'Publish',
    });
  });
});

const declaration = (key: string): AccessDeclarationInput => ({
  key,
  kind: 'read',
  modes: ['run'],
  placement: { group: 'g', level: 'basic' },
  risk: 'routine',
  selectors: [],
});

const moduleOf = (moduleId: string): AccessCatalogModule => ({
  descriptors: [
    {
      accessDeclaration: declaration(`${moduleId}.record.read`),
      entrypoint: defineTenantModuleEntrypoint({
        access: 'read',
        authorization: { kind: 'protected' },
        entrypointKey: `${moduleId}.api.records`,
        moduleKey: moduleId,
        role: 'api',
      }),
    },
  ],
  moduleId,
});

describe('the deployment release', () => {
  const modules = [moduleOf('alpha.ledger'), moduleOf('beta.ledger')];

  it('declares every module of the deployment, installed anywhere or not', () => {
    const deployment = Result.getOrThrow(buildDeploymentCatalogRelease({ modules, publishedAt: at }));
    expect(deployment.entries.map(({ key }) => key)).toEqual(['alpha.ledger.record.read', 'beta.ledger.record.read']);
    // The initial release of one tenant still publishes only what that tenant installed.
    const installed = Result.getOrThrow(
      buildAccessCatalogRelease({ installedModuleKeys: ['alpha.ledger'], modules, publishedAt: at }),
    );
    expect(installed.entries.map(({ key }) => key)).toEqual(['alpha.ledger.record.read']);
  });
});

describe('a tenant following the newest release', () => {
  it('extends "Plný přístup" by exactly the new cells, and only by additions', () => {
    const preset = role({ cells: cellsOf(first), id: 10, pinned: first, provenance: 'template' });
    const followed = plan([preset], third);
    const edit = Option.getOrThrow(followed.presetEdit);
    expect(edit.removedCells).toEqual([]);
    expect(keysOf(edit.addedCells)).toEqual([APPROVE, VOID]);
    // Every mode each new capability declares: approve(run, propose) + void(run, propose, approve).
    expect(edit.addedCells).toHaveLength(5);
    expect(keysOf(edit.cells)).toEqual([APPROVE, READ, VOID]);
    expect(edit.sourceRevisionId).toBe(preset.revision.id);
    // A preset with no other role in the tenant leaves nothing for Novinky.
    expect(followed.items).toEqual([]);
  });

  it('is idempotent: the same release plans the same successor, and a preset that took it plans nothing', () => {
    const preset = role({ cells: cellsOf(first), id: 10, pinned: first, provenance: 'template' });
    expect(Option.getOrThrow(plan([preset], third).presetEdit).targetRevisionId).toBe(
      Option.getOrThrow(plan([preset], third).presetEdit).targetRevisionId,
    );
    const followed = role({ cells: cellsOf(third), id: 10, pinned: third, provenance: 'template' });
    const again = plan([followed], third);
    expect(Option.isNone(again.presetEdit)).toBe(true);
    expect(again.items).toEqual([]);
  });

  it('gives every other role Novinky instead of grants, with stable item identities', () => {
    const preset = role({ cells: cellsOf(first), id: 10, pinned: first, provenance: 'template' });
    const custom = role({ cells: cellsOf(first), id: 20, pinned: first, provenance: 'manual' });
    const followed = plan([preset, custom], second, [first]);
    expect(followed.items.map(({ capabilityKey, kind, status }) => [capabilityKey, kind, status])).toEqual([
      [APPROVE, 'new', 'pending'],
    ]);
    // The preset follows by itself, so the item never suggests adopting into it.
    expect(followed.items.flatMap(({ suggestedRoleIds }) => suggestedRoleIds)).not.toContain(preset.role.id);
    expect(plan([preset, custom], second, [first]).items.map(({ id }) => id)).toEqual(
      followed.items.map(({ id }) => id),
    );
    // Once recorded, the same release plans no item again.
    expect(plan([preset, custom], second, [first], followed.items).items).toEqual([]);
    // A role created against the newest release already chose from it.
    const current = role({ cells: [], id: 30, pinned: second, provenance: 'manual' });
    expect(plan([preset, current], second, [first]).items).toEqual([]);
  });

  it('treats a preset a person changed as a role like any other', () => {
    const changed = role({ cells: cellsOf(first), id: 10, pinned: first, provenance: 'customer_changed' });
    const followed = plan([changed], second, [first]);
    expect(Option.isNone(followed.presetEdit)).toBe(true);
    expect(followed.items.map(({ capabilityKey }) => capabilityKey)).toEqual([APPROVE]);
  });

  it('keeps a capability the newest release no longer declares, inert and reported, never removed', () => {
    const preset = role({ cells: cellsOf(third), id: 10, pinned: third, provenance: 'template' });
    const narrower = releaseOf([
      ...first.entries,
      entry('billing.invoices.invoice.export', { kind: 'read', modes: ['run'] }),
    ]);
    const followed = plan([preset], narrower);
    expect(followed.inertKeys).toEqual([APPROVE, VOID]);
    const edit = Option.getOrThrow(followed.presetEdit);
    expect(edit.removedCells).toEqual([]);
    expect(keysOf(edit.addedCells)).toEqual(['billing.invoices.invoice.export']);
  });

  it('lists every change since the release each role is pinned to, even across a skipped release', () => {
    const preset = role({ cells: cellsOf(third), id: 10, pinned: third, provenance: 'template' });
    // One role stayed on the first release while the tenant never saw the second one.
    const behind = role({ cells: cellsOf(first), id: 20, pinned: first, provenance: 'manual' });
    const current = role({ cells: cellsOf(second), id: 30, pinned: second, provenance: 'manual' });
    const followed = plan([preset, behind, current], third, [first, second]);
    expect(followed.items.map(({ capabilityKey, kind }) => [capabilityKey, kind])).toEqual([
      [APPROVE, 'new'],
      [VOID, 'new'],
    ]);
    // A release a role is pinned to that was never published is a refusal, never a silent skip.
    expect(Result.isFailure(planned([preset, behind], third, [second]))).toBe(true);
  });

  it('names one release actor per tenant', () => {
    expect(releaseActorId(tenantId)).toBe(releaseActorId(tenantId));
    expect(releaseActorId(tenantId)).not.toBe(releaseActorId(uid(9)));
  });
});
