import type { LegalEntityScope, OperationalScope } from '@app/core-runtime';
import type {
  AccessChangesCommandsService,
  AccessChangesItemView,
  AccessChangesPreview,
  AccessChangesView,
  RoleSummary,
} from '@app/core-runtime/access/changes/commands';
import {
  AccessChangesCommands,
  AccessPreviewFingerprintSchema,
  CellSchema,
} from '@app/core-runtime/access/changes/commands';
import type { AccessDecision } from '@app/core-runtime/access/decision/contract';
import type { AccessDecisionService, GateInput } from '@app/core-runtime/access/enforcement';
import { AccessDecisionGate } from '@app/core-runtime/access/enforcement';
import {
  AccessChangeDecisionIdSchema,
  AccessChangeItemIdSchema,
  AssignmentIncarnationIdSchema,
  CapabilityKeySchema,
  CatalogDigestSchema,
  CatalogSnapshotIdSchema,
  LegalEntityIdSchema,
  PrincipalIdSchema,
  RoleIdSchema,
  RoleRevisionIdSchema,
  TenantIdSchema,
} from '@app/core-runtime/access/ids';
import { Context, DateTime, Effect, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import type {
  AccessAdminProblem,
  DecideAccessChangesPayload,
  PreviewAccessChangesPayload,
} from '../../shared/access-admin-api.ts';
import {
  AccessChangesWriteAvailability,
  accessChangesDeclarations,
  makeAccessChangesBff,
} from '../../api/access-admin/changes.ts';
import { AccessAdminSession } from '../../api/access-admin/session.ts';

/*
 * O88 for NOVINKY: the release list, the preview and every decision on it.
 *
 * A tenant-context manager whose envelope holds a Novinky key is admitted in the tenant context, but a
 * company's roles belong to that company. The BFF therefore asks each company the same declaration in
 * its own `required` scope, exactly as the Role editor does, and shows a role only when its company
 * admitted it — and an item only when every role it reaches is shown. Everything here is mock-bound: a
 * scripted gate answers by declaration key and scope, and the command seam is a scripted port. What is
 * proved is this module's own narrowing, not Core's configuration basis or the live engine.
 */

const decode = Schema.decodeUnknownSync;
const uuid = (index: number): string => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const instant = (hour: number): Date => DateTime.toDateUtc(DateTime.makeUnsafe(Date.UTC(2026, 10, 5, hour)));

const TENANT = decode(TenantIdSchema)(uuid(1));
const PERSON = decode(PrincipalIdSchema)(uuid(2));
const CATALOG = decode(CatalogSnapshotIdSchema)(uuid(3));
const COMPANY_A = decode(LegalEntityIdSchema)(uuid(10));
const COMPANY_B = decode(LegalEntityIdSchema)(uuid(11));

const TENANT_ROLE = decode(RoleIdSchema)(uuid(20));
const A_ROLE = decode(RoleIdSchema)(uuid(21));
const B_ROLE = decode(RoleIdSchema)(uuid(22));
const B_REVISION = decode(RoleRevisionIdSchema)(uuid(32));
const B_HOLDER = decode(PrincipalIdSchema)(uuid(42));
const B_ROLE_NAME = 'Skladník B';

const TENANT_ITEM = decode(AccessChangeItemIdSchema)(uuid(50));
const A_ITEM = decode(AccessChangeItemIdSchema)(uuid(51));
const B_ITEM = decode(AccessChangeItemIdSchema)(uuid(52));
/** An item that reaches a role of A and a role of B: deciding it would write into company B. */
const MIXED_ITEM = decode(AccessChangeItemIdSchema)(uuid(53));
const UNKNOWN_ITEM = decode(AccessChangeItemIdSchema)(uuid(59));

const CAPABILITY = decode(CapabilityKeySchema)('party.registry.party.read');
const FINGERPRINT = decode(AccessPreviewFingerprintSchema)('a'.repeat(64));
const CELL = decode(CellSchema)({ capabilityKey: CAPABILITY, mode: 'run', selector: { _tag: 'all' } });

const tenantScope: OperationalScope = {
  authContextRef: 'better-auth-session:unit-test',
  authMethod: 'session',
  correlationId: 'o88-novinky',
  principalId: PERSON,
  tenantId: TENANT,
};

const holderOf = (index: number) => decode(PrincipalIdSchema)(uuid(40 + index));
const revisionOf = (index: number) => decode(RoleRevisionIdSchema)(uuid(30 + index));

const role = (input: {
  readonly index: number;
  readonly legalEntityId?: typeof COMPANY_A;
  readonly name: string;
  readonly roleId: typeof TENANT_ROLE;
}): RoleSummary => {
  const base = {
    cells: [CELL],
    headRevision: {
      catalogSnapshotId: CATALOG,
      cells: [CELL],
      createdAt: instant(1),
      createdBy: PERSON,
      provenance: 'manual' as const,
      revision: 1,
      roleRevisionId: revisionOf(input.index),
    },
    holderCount: 1,
    name: input.name,
    roleId: input.roleId,
  };
  return input.legalEntityId === undefined
    ? { ...base, scope: 'tenant' }
    : { ...base, legalEntityId: input.legalEntityId, scope: 'company' };
};

const ROLES: readonly RoleSummary[] = [
  role({ index: 0, name: 'Účetní', roleId: TENANT_ROLE }),
  role({ index: 1, legalEntityId: COMPANY_A, name: 'Skladník A', roleId: A_ROLE }),
  role({ index: 2, legalEntityId: COMPANY_B, name: B_ROLE_NAME, roleId: B_ROLE }),
];

const indexOfRole = (roleId: string): number => ROLES.findIndex((one) => one.roleId === roleId);

/** One release item reaching exactly the given roles: its cells and holders come from those roles. */
const item = (id: typeof TENANT_ITEM, roleIds: readonly (typeof TENANT_ROLE)[]): AccessChangesItemView => ({
  addedCells: roleIds.map((roleId) => ({ cell: CELL, roleId })),
  batchEligible: false,
  capabilityKey: CAPABILITY,
  catalogSnapshotId: CATALOG,
  createdAt: instant(2),
  holders: roleIds.map((roleId) => ({
    assignmentIncarnationId: decode(AssignmentIncarnationIdSchema)(uuid(60 + indexOfRole(roleId))),
    holder: { _tag: 'Principal', principalId: holderOf(indexOfRole(roleId)) },
    roleId,
  })),
  id,
  kind: 'new',
  lineageFrom: [],
  removedCells: [],
  requiresIndividualDecision: false,
  risk: 'routine',
  status: 'pending',
  suggestedRoleIds: roleIds,
  widens: true,
});

/** B's own item sorts FIRST, so an un-narrowed page of one would have carried it. */
const ITEMS: readonly AccessChangesItemView[] = [
  item(B_ITEM, [B_ROLE]),
  item(MIXED_ITEM, [A_ROLE, B_ROLE]),
  item(TENANT_ITEM, [TENANT_ROLE]),
  item(A_ITEM, [A_ROLE]),
];

const view = (): AccessChangesView => ({
  decisions: [],
  items: ITEMS,
  preview: { agentCount: 0, fingerprint: FINGERPRINT, holders: [], humanCount: 4, items: [] },
  release: {
    catalogSnapshotId: CATALOG,
    digest: decode(CatalogDigestSchema)('c'.repeat(64)),
    entries: [],
    publishedAt: instant(1),
  },
  roles: ROLES,
  tenantId: TENANT,
});

/** Core's preview of exactly the items asked for, as the scripted seam answers it. */
const previewOf = (itemIds: readonly string[], overrides: Partial<AccessChangesPreview> = {}): AccessChangesPreview => {
  const items = ITEMS.filter(({ id }) => itemIds.includes(id));
  return {
    addedCells: items.flatMap(({ addedCells }) => addedCells),
    individualItemIds: [],
    items,
    preview: { agentCount: 0, fingerprint: FINGERPRINT, holders: [], humanCount: 1, items: [] },
    removedCells: [],
    roleChanges: [],
    skipped: [],
    token: FINGERPRINT,
    ...overrides,
  };
};

const receipt = () =>
  Effect.succeed({
    catalogSnapshotId: CATALOG,
    decisionIds: [decode(AccessChangeDecisionIdSchema)(uuid(70))],
    skipped: [],
    tenantId: TENANT,
  });

const scriptedCommands = (options: { readonly preview?: Partial<AccessChangesPreview> } = {}) => {
  const calls = { adopt: 0, decline: 0, preview: 0, undo: 0 };
  const service: AccessChangesCommandsService = {
    adopt: () => {
      calls.adopt += 1;
      return receipt();
    },
    decline: () => {
      calls.decline += 1;
      return receipt();
    },
    preview: (_scope, input) => {
      calls.preview += 1;
      return Effect.succeed(previewOf(input.itemIds, options.preview));
    },
    read: () => Effect.succeed(view()),
    readRelease: () => Effect.succeed(Option.none()),
    roleNames: () => Effect.succeed(new Map()),
    undo: () => {
      calls.undo += 1;
      return receipt();
    },
  };
  return { calls, service };
};

/** What one scripted question may answer: exactly the outcomes the narrowing tells apart. */
const SCRIPT_ANSWERS = Schema.Literals(['allow', 'deny', 'unavailable']);
type Answer = typeof SCRIPT_ANSWERS.Type;

/** The script: the tenant context by declaration key, and each company's own scope by declaration key. */
interface Script {
  readonly companies?: Readonly<Record<string, Readonly<Record<string, Answer>>>>;
  readonly tenant?: Readonly<Record<string, Answer>>;
}

interface Asked {
  readonly key: string;
  readonly legalEntityId?: string;
  readonly legalEntityScope: LegalEntityScope;
}

const decisionOf = (answer: Answer): AccessDecision => {
  if (answer === 'unavailable') {
    return { evidence: [], outcome: 'UNAVAILABLE', reasons: [{ code: 'unavailable.intent' }], selectors: [] };
  }
  return answer === 'deny'
    ? { evidence: [], outcome: 'DENIED', reasons: [{ code: 'deny.insufficient_grant' }], selectors: [] }
    : { evidence: [], outcome: 'ALLOWED', reasons: [{ code: 'allow.granted' }], selectors: [] };
};

/**
 * A gate that answers the keys the suite scripted for the scope it was asked in. As the live gate, it
 * refuses a `required` question without a company and denies a declaration the script does not name.
 */
const gateOf = (script: Script) => {
  const asked: Asked[] = [];
  const answerFor = (input: GateInput): Answer => {
    const key = input.carrier.accessDeclaration?.key;
    if (key === undefined || (input.legalEntityScope === 'required' && input.scope.legalEntityId === undefined)) {
      return 'deny';
    }
    const company = input.scope.legalEntityId;
    return company === undefined ? (script.tenant?.[key] ?? 'deny') : (script.companies?.[company]?.[key] ?? 'deny');
  };
  const service: AccessDecisionService = {
    decide: (input) => {
      const base = { key: input.carrier.accessDeclaration?.key ?? '', legalEntityScope: input.legalEntityScope };
      asked.push(
        input.scope.legalEntityId === undefined ? base : { ...base, legalEntityId: input.scope.legalEntityId },
      );
      return Effect.succeed(decisionOf(answerFor(input)));
    },
    decideMany: () => Effect.die('this suite asks one declaration at a time'),
    list: () => Effect.die('Novinky reads no list predicate'),
    selectableLegalEntities: () => Effect.succeed([]),
  };
  return { asked, service };
};

const LIST = accessChangesDeclarations.list?.key ?? '';
const PREVIEW = accessChangesDeclarations.previewTenant?.key ?? '';
const DECIDE = accessChangesDeclarations.decideTenant?.key ?? '';

/** A tenant-context manager allowed every Novinky key, admitted in company A and refused in company B. */
const MANAGER: Script = {
  companies: {
    [COMPANY_A]: { [DECIDE]: 'allow', [LIST]: 'allow', [PREVIEW]: 'allow' },
    [COMPANY_B]: { [DECIDE]: 'deny', [LIST]: 'deny', [PREVIEW]: 'deny' },
  },
  tenant: { [DECIDE]: 'allow', [LIST]: 'allow', [PREVIEW]: 'allow' },
};

const fixture = (script: Script = MANAGER, options: { readonly preview?: Partial<AccessChangesPreview> } = {}) => {
  const commands = scriptedCommands(options);
  const gate = gateOf(script);
  const bff = makeAccessChangesBff(
    Context.make(AccessChangesCommands, commands.service).pipe(
      Context.add(AccessAdminSession, { requireTenantContext: () => Effect.succeed(tenantScope) }),
      Context.add(AccessDecisionGate, gate.service),
      Context.add(AccessChangesWriteAvailability, { available: true, reason: 'proven by the real-gate suite' }),
    ),
  );
  return { asked: gate.asked, bff, calls: commands.calls };
};

const headers = () => new Headers({ 'idempotency-key': 'novinky-o88' });

/** A selection as the wire contract carries it: never empty. */
type ItemIds = PreviewAccessChangesPayload['itemIds'];

const previewPayload = (itemIds: ItemIds, decision: 'adopt' | 'undo' = 'adopt'): PreviewAccessChangesPayload => ({
  catalogSnapshotId: CATALOG,
  decision,
  itemIds,
  legalEntityId: null,
});

const decidePayload = (
  itemIds: ItemIds,
  decision: DecideAccessChangesPayload['decision'],
): DecideAccessChangesPayload => ({
  catalogSnapshotId: CATALOG,
  decision,
  itemIds,
  legalEntityId: null,
  previewToken: FINGERPRINT,
});

/** Nothing that names company B's role reaches the browser: id, name, revision or holder. */
const expectNothingOfCompanyB = (text: string) => {
  for (const secret of [B_ROLE, B_ROLE_NAME, B_REVISION, B_HOLDER, B_ITEM, MIXED_ITEM]) {
    expect(text).not.toContain(secret);
  }
};

const sorted = (values: readonly string[]) => values.toSorted((left, right) => left.localeCompare(right));

it.effect('lists only the roles and items whose companies admitted the list, before the page is cut', () =>
  Effect.gen(function* listsReadableNovinky() {
    const { asked, bff } = fixture();
    const listed = yield* bff.list(headers(), { limit: 10 });

    expect(sorted(listed.roles.map(({ id }) => id))).toEqual(sorted([TENANT_ROLE, A_ROLE]));
    expect(sorted(listed.items.map(({ id }) => id))).toEqual(sorted([TENANT_ITEM, A_ITEM]));
    expectNothingOfCompanyB(JSON.stringify(listed));
    // Every company that holds a role was asked the list declaration in its own required scope.
    expect(
      sorted(asked.flatMap((one) => (one.legalEntityScope === 'required' ? [one.legalEntityId ?? ''] : []))),
    ).toEqual(sorted([COMPANY_A, COMPANY_B]));
    expect(asked.every(({ key }) => key === LIST)).toBe(true);

    // One item per page: the cursor counts the narrowed list, so B's item shifts no cursor.
    const first = yield* bff.list(headers(), { limit: 1 });
    const second = yield* bff.list(headers(), { cursor: '1', limit: 1 });
    expect(first.nextCursor).toBe('1');
    expect(second.nextCursor).toBeNull();
    expect(sorted([...first.items, ...second.items].map(({ id }) => id))).toEqual(sorted([TENANT_ITEM, A_ITEM]));
  }),
);

it.effect('refuses a preview of company B’s items exactly like an item that does not exist', () =>
  Effect.gen(function* previewIsBoundToTheItemsCompanies() {
    const { bff, calls } = fixture();
    const missing = yield* Effect.flip(bff.preview(headers(), previewPayload([UNKNOWN_ITEM])));
    for (const decision of ['adopt', 'undo'] as const) {
      const selections: readonly ItemIds[] = [[B_ITEM], [MIXED_ITEM], [A_ITEM, B_ITEM]];
      for (const itemIds of selections) {
        const refusal = yield* Effect.flip(bff.preview(headers(), previewPayload(itemIds, decision)));
        // The refusal echoes the caller's own selection, and nothing else of it.
        const unechoed = (refusal.detail ?? '').replace(itemIds.join(', '), '');
        expect(refusal.status).toBe(missing.status);
        expect(unechoed).toBe((missing.detail ?? '').replace(UNKNOWN_ITEM, ''));
        expectNothingOfCompanyB(unechoed);
      }
    }
    // Core never planned an item outside the authority, so no Core refusal could name its role.
    expect(calls.preview).toBe(0);

    const own = yield* bff.preview(headers(), previewPayload([A_ITEM]));
    expect(own.items.map(({ id }) => id)).toEqual([A_ITEM]);
    expect(calls.preview).toBe(1);
  }),
);

it.effect('refuses a preview whose Core answer names a role outside the caller’s authority', () =>
  Effect.gen(function* previewNeverCarriesAHiddenRole() {
    // An undo is described by the roles its adoption wrote; if one of them is B's, nothing is answered.
    const { bff } = fixture(MANAGER, {
      preview: {
        roleChanges: [{ after: [], before: [CELL], expectedRevisionId: B_REVISION, roleId: B_ROLE }],
      },
    });
    const refusal: AccessAdminProblem = yield* Effect.flip(bff.preview(headers(), previewPayload([A_ITEM], 'undo')));
    expect(refusal.status).toBe(409);
    expectNothingOfCompanyB(JSON.stringify(refusal));
  }),
);

it.effect('never adopts, declines or undoes company B’s items, and refuses them like missing items', () =>
  Effect.gen(function* decideIsBoundToTheItemsCompanies() {
    const { bff, calls } = fixture();
    for (const decision of ['adopt', 'decline', 'undo'] as const) {
      const missing = yield* Effect.flip(bff.decide(headers(), decidePayload([UNKNOWN_ITEM], decision)));
      const selections: readonly ItemIds[] = [[B_ITEM], [MIXED_ITEM]];
      for (const itemIds of selections) {
        const refusal = yield* Effect.flip(bff.decide(headers(), decidePayload(itemIds, decision)));
        expect(refusal.status).toBe(missing.status);
        expect((refusal.detail ?? '').replace(itemIds.join(', '), '')).toBe(
          (missing.detail ?? '').replace(UNKNOWN_ITEM, ''),
        );
      }
    }
    expect(calls).toEqual({ adopt: 0, decline: 0, preview: 0, undo: 0 });

    // The manager's own company is still theirs to decide.
    yield* bff.decide(headers(), decidePayload([A_ITEM], 'adopt'));
    expect(calls.adopt).toBe(1);
  }),
);

it.effect('answers 503 — never a shorter list — when a company’s authority cannot be read', () =>
  Effect.gen(function* unavailableStaysRetryable() {
    const { bff } = fixture({
      companies: { [COMPANY_A]: { [LIST]: 'allow' }, [COMPANY_B]: { [LIST]: 'unavailable' } },
      tenant: { [LIST]: 'allow' },
    });
    const failure = yield* Effect.flip(bff.list(headers(), { limit: 10 }));
    expect(failure.status).toBe(503);
  }),
);
