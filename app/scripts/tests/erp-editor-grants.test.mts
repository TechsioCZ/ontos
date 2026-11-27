import { Effect, Exit, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { AccessScopeIdSchema, LegalEntityIdSchema } from '../../packages/core-runtime/src/access/ids.ts';
import { AccessMembershipSchema } from '../../packages/core-runtime/src/access/intent/memberships.ts';
import { AssignmentSchema, RoleRevisionSchema, RoleSchema } from '../../packages/core-runtime/src/access/model.ts';
import {
  ERP_EDITOR_ADMISSIONS,
  ERP_EDITOR_LOGINS,
  planAdmission,
  planRetirement,
  RETIRED_ERP_AUTHORITY,
} from '../demo/erp-editor-grants.mts';
import type { DirectoryEntry } from '../demo/erp-editor-grants.mts';

const id = (n: number) => `90000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const AKROS = {
  legalEntityId: 'c0c78a3e-6e2a-57e0-9d0d-86253499fee7',
  tenantId: 'bceaa540-13eb-5508-9ac0-9ed7e40a2ee9',
};
const ESHOP_EMAIL = 'eshop@akros.demo';
const OTHER_COMPANY = id(50);
const AT = new Date('2026-11-27T02:00:00.000Z');
const BEFORE = new Date('2026-11-20T12:00:00.000Z');
const ESHOP = id(11);
const OTHER_PERSON = id(12);
const OWNER = id(1);
const TENANT_SCOPE = AccessScopeIdSchema.make(id(101));
const COMPANY_SCOPE = AccessScopeIdSchema.make(id(102));
const ESHOP_OPERATOR = { email: ESHOP_EMAIL, principalId: ESHOP };

const member = (principalId: string, scopeId: string, n: number, status = 'active') =>
  Schema.decodeUnknownSync(AccessMembershipSchema)({
    createdAt: BEFORE,
    holder: { _tag: 'Principal', principalId },
    id: id(200 + n),
    kind: 'member',
    recordedBy: OWNER,
    scopeId,
    status,
    tenantId: AKROS.tenantId,
    validFrom: BEFORE,
  });

const admissionView = (memberships: readonly ReturnType<typeof member>[]) => ({
  at: AT,
  memberships,
  scopes: [
    { scopeId: TENANT_SCOPE },
    { legalEntityId: LegalEntityIdSchema.make(AKROS.legalEntityId), scopeId: COMPANY_SCOPE },
  ],
  tenantScopeId: TENANT_SCOPE,
});

const admit = (memberships: readonly ReturnType<typeof member>[], directory?: DirectoryEntry) =>
  planAdmission(admissionView(memberships), ESHOP, AKROS.legalEntityId, directory, ESHOP_EMAIL);

it('the AKROS login the stage bootstrap only attaches is admitted to the AKROS seller', () => {
  expect(ERP_EDITOR_ADMISSIONS).toEqual([{ email: ESHOP_EMAIL, ...AKROS }]);
  expect(ERP_EDITOR_ADMISSIONS.every(({ email }) => ERP_EDITOR_LOGINS.includes(email))).toBe(true);
});

it.effect('a fresh stage plans the company directory membership, then admit-member', () =>
  Effect.gen(function* freshStage() {
    const plan = yield* admit([]);
    expect(plan.admit).toBe(true);
    expect(plan.companyScopeId).toBe(COMPANY_SCOPE);
    expect(Option.getOrUndefined(plan.directory)).toEqual({ affiliation: 'employee', expectedRevision: 0 });
  }),
);

it.effect('an invited directory row is activated at its revision; an active one is left for admit-member', () =>
  Effect.gen(function* directoryStates() {
    const invited = yield* admit([], { affiliation: 'external', revision: 3, status: 'invited' });
    expect(Option.getOrUndefined(invited.directory)).toEqual({ affiliation: 'external', expectedRevision: 3 });
    const active = yield* admit([], { affiliation: 'employee', revision: 2, status: 'active' });
    expect(active.admit).toBe(true);
    expect(Option.isNone(active.directory)).toBe(true);
  }),
);

it.effect('a live member of the tenant and the company plans nothing, so a later boot writes nothing', () =>
  Effect.gen(function* alreadyMember() {
    const plan = yield* admit([member(ESHOP, TENANT_SCOPE, 1), member(ESHOP, COMPANY_SCOPE, 2)], {
      affiliation: 'employee',
      revision: 1,
      status: 'active',
    });
    expect(plan.admit).toBe(false);
    expect(Option.isNone(plan.directory)).toBe(true);
  }),
);

it.effect('ended directory rows, company-only access and an unknown company are refused, never revived', () =>
  Effect.gen(function* refusals() {
    const departed = yield* Effect.exit(admit([], { affiliation: 'employee', revision: 4, status: 'departed' }));
    expect(Exit.isFailure(departed)).toBe(true);
    const companyOnly = yield* Effect.exit(admit([member(ESHOP, COMPANY_SCOPE, 1)]));
    expect(Exit.isFailure(companyOnly)).toBe(true);
    const revokedTenant = yield* admit([
      member(ESHOP, TENANT_SCOPE, 1, 'revoked'),
      member(OTHER_PERSON, COMPANY_SCOPE, 2),
    ]);
    expect(revokedTenant.admit).toBe(true);
    const unknown = yield* Effect.exit(planAdmission(admissionView([]), ESHOP, OTHER_COMPANY, undefined, ESHOP_EMAIL));
    expect(Exit.isFailure(unknown)).toBe(true);
  }),
);

const role = (n: number, name: string, keys: readonly string[], legalEntityId?: string) => {
  const identity = { createdAt: BEFORE, createdBy: OWNER, id: id(500 + n), name, tenantId: AKROS.tenantId };
  return {
    revision: Schema.decodeUnknownSync(RoleRevisionSchema)({
      catalogSnapshotId: id(900),
      cells: keys.map((capabilityKey) => ({ capabilityKey, mode: 'run', selector: { _tag: 'all' } })),
      createdAt: BEFORE,
      createdBy: OWNER,
      id: id(600 + n),
      provenance: 'manual',
      revision: 1,
      roleId: id(500 + n),
      tenantId: AKROS.tenantId,
    }),
    role: Schema.decodeUnknownSync(RoleSchema)(legalEntityId === undefined ? identity : { ...identity, legalEntityId }),
  };
};
const assignment = (n: number, roleN: number, principalId: string, status = 'active') =>
  Schema.decodeUnknownSync(AssignmentSchema)({
    assignedAt: BEFORE,
    assignedBy: OWNER,
    holder: { _tag: 'Principal', principalId },
    incarnationId: id(700 + n),
    roleId: id(500 + roleN),
    roleRevisionId: id(600 + roleN),
    scopeId: TENANT_SCOPE,
    status,
    tenantId: AKROS.tenantId,
    validFrom: BEFORE,
  });

const ERP_CELLS = [
  'commerce.catalog.product.update',
  'commerce.inventory.stock-position.receive',
  'commerce.pricing.price.revise',
  'pricing.price-group-catalog.price-group.read.definition',
];
const SHOP_CELLS = ['demo.merchandise.page-products.read', 'demo.merchandise.product.update', 'work.tasks.task.read'];
const HAND = 'AKROS ERP katalog, ceny a sklad';
const SHOP_ADMIN = 'Správce e-shopu';
const akrosRetired = Effect.fromNullishOr(RETIRED_ERP_AUTHORITY.find(({ tenantId }) => tenantId === AKROS.tenantId));

it.effect('the hand-made ERP role is unassigned and only the ERP modules leave Správce e-shopu', () =>
  Effect.gen(function* retires() {
    const retired = yield* akrosRetired;
    const view = {
      assignments: [
        assignment(1, 1, ESHOP),
        assignment(2, 1, ESHOP, 'revoked'),
        assignment(3, 1, OTHER_PERSON),
        assignment(4, 2, ESHOP),
        assignment(5, 4, ESHOP),
      ],
      at: AT,
      roles: [
        role(1, HAND, ERP_CELLS),
        role(2, SHOP_ADMIN, [...ERP_CELLS, ...SHOP_CELLS], AKROS.legalEntityId),
        // Another company's role of the same name and the code-owned editor roles keep every cell.
        role(3, SHOP_ADMIN, ERP_CELLS, OTHER_COMPANY),
        role(4, 'Úpravy produktů z ERP', ERP_CELLS),
        role(5, 'Úpravy produktů z ERP', ERP_CELLS, AKROS.legalEntityId),
      ],
    };
    const plan = yield* planRetirement(view, retired, [ESHOP_OPERATOR]);
    expect(
      plan.unassignments.map(({ assignment: held, email, roleName }) => [held.incarnationId, email, roleName]),
    ).toEqual([[id(701), ESHOP_EMAIL, HAND]]);
    expect(
      plan.revisions.map(({ cells, role: revised }) => [
        revised.role.id,
        cells.map(({ capabilityKey }) => capabilityKey),
      ]),
    ).toEqual([[id(502), SHOP_CELLS]]);
  }),
);

it.effect('once retired nothing is planned, and an ambiguous company role is refused', () =>
  Effect.gen(function* converges() {
    const retired = yield* akrosRetired;
    const done = yield* planRetirement(
      {
        assignments: [assignment(1, 1, ESHOP, 'revoked'), assignment(4, 2, ESHOP)],
        at: AT,
        roles: [role(1, HAND, ERP_CELLS), role(2, SHOP_ADMIN, SHOP_CELLS, AKROS.legalEntityId)],
      },
      retired,
      [ESHOP_OPERATOR],
    );
    expect(done).toEqual({ revisions: [], unassignments: [] });
    const ambiguous = yield* Effect.exit(
      planRetirement(
        {
          assignments: [],
          at: AT,
          roles: [
            role(2, SHOP_ADMIN, SHOP_CELLS, AKROS.legalEntityId),
            role(6, SHOP_ADMIN, ERP_CELLS, AKROS.legalEntityId),
          ],
        },
        retired,
        [ESHOP_OPERATOR],
      ),
    );
    expect(Exit.isFailure(ambiguous)).toBe(true);
  }),
);
