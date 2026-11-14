import { stableUuid } from '@app/core-runtime/access/catalog';
import { Effect, Schema } from 'effect';
import { expect } from 'effect-rstest';
import {
  AccessPeopleMutationResponseSchema,
  ListAccessPeopleOptionsResponseSchema,
  ListAccessPeopleResponseSchema,
} from '../../shared/access-admin-api.ts';
import type {
  AdmitAccessMemberPayloadSchema,
  AssignAccessRolePayloadSchema,
  CreateAccessDelegationPayloadSchema,
  EndAccessMembershipPayloadSchema,
  RevokeAccessAssignmentPayloadSchema,
  RevokeAccessDelegationPayloadSchema,
  SetAccessTeamMembershipPayloadSchema,
  TransferAccessOwnershipPayloadSchema,
} from '../../shared/access-admin-api.ts';
import { TASKS_CAPABILITY_KEY, shellHttpFor } from '../support/access-admin-real-gate-fixture.ts';
import type {
  AccessAdminCase,
  Persona,
  ShellHttp,
  ShellHttpAnswer,
} from '../support/access-admin-real-gate-fixture.ts';

/*
 * The evidence that opens Lidé's write gate (`api/access-admin/people-write-gate.ts`): every people
 * write, driven over HTTP through the Shell API runtime `api/index.ts` builds for production, against
 * one real-gate case database and the real SpiceDB. Nothing here chooses a gate or a store: if the
 * composition ships the Lidé gate closed, every write below is a 503 and this suite is red.
 *
 * Each case is one cloned database and one tenant, so the scenarios are grouped into six: admission,
 * the refusals only Core can make, ending a membership, role assignment, delegation, and ownership.
 * After a write, the real gate (`accessCase.decide`) and the rows Core
 * persisted are read back; a 2xx alone proves nothing.
 */

const PEOPLE = '/shell/access/people';
export const CASE_TIMEOUT = 300_000;
const LEAVER_REASON = 'P14: the person left company A';
/** Inside the seeded delegation (it ends 2031-01-01), so a delegated assignment ends with it. */
const DELEGATED_UNTIL = '2030-06-01T00:00:00.000Z';
const DELEGATION_END = '2030-12-01T00:00:00.000Z';
/** A published administration capability the company administrator holds through its role. */
const SPINE_DECLARATION = 'core.modules.tenant-module.change-state';

const decodeBody = <Value, Encoded>(schema: Schema.Codec<Value, Encoded>, text: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(text).pipe(Effect.orDie);

/** One expected status; a mismatch prints the whole problem the server answered. */
const expectStatus = (answer: ShellHttpAnswer, status: number) => {
  expect({ status: answer.status, text: answer.status === status ? '' : answer.text }).toEqual({ status, text: '' });
};

/** A refusal with its status and the Core code its detail names. */
const expectRefusal = (answer: ShellHttpAnswer, status: number, code: string) => {
  expect({ named: answer.text.includes(code), status: answer.status, text: answer.text }).toEqual({
    named: true,
    status,
    text: answer.text,
  });
};

interface MembershipRow {
  readonly kind: string;
  readonly membership_id: string;
  readonly recorded_by: string;
  readonly scope_id: string;
  readonly status: string;
}

/** Reads one case's persisted intent back with the case's admin connection. */
const rowsOf = <Row extends object>(accessCase: AccessAdminCase, sql: string) =>
  accessCase.admin.unsafe<Row>(sql).pipe(Effect.orDie);

const membershipsOf = (accessCase: AccessAdminCase, principalId: string) =>
  rowsOf<MembershipRow>(
    accessCase,
    `select membership_id, scope_id, kind, status, recorded_by from core.access_memberships
     where principal_id = '${principalId}' order by created_at, membership_id`,
  );

const statusOf = (accessCase: AccessAdminCase, table: string, idColumn: string, id: string) =>
  rowsOf<{ readonly status: string }>(accessCase, `select status from core.${table} where ${idColumn} = '${id}'`).pipe(
    Effect.map((rows) => rows[0]?.status),
  );

const countOf = (accessCase: AccessAdminCase, sql: string) =>
  rowsOf<{ readonly count: string }>(accessCase, `select count(*)::text as count from (${sql}) counted`).pipe(
    Effect.map((rows) => Number(rows[0]?.count ?? 'NaN')),
  );

/** One person's `member` rows in one scope, as id and status. */
const memberRowsIn = (accessCase: AccessAdminCase, principalId: string, scopeId: string) =>
  rowsOf<{ readonly id: string; readonly status: string }>(
    accessCase,
    `select membership_id as id, status from core.access_memberships
     where principal_id = '${principalId}' and scope_id = '${scopeId}' and kind = 'member'`,
  );

interface MemberEndRow {
  readonly ended: boolean;
  readonly ended_by: string | null;
  readonly ended_reason: string | null;
  readonly scope_id: string;
  readonly status: string;
}

/** Who ended each of one person's `member` rows, when and why, as Core recorded it. */
const memberEndsOf = (accessCase: AccessAdminCase, principalId: string) =>
  rowsOf<MemberEndRow>(
    accessCase,
    `select scope_id, status, ended_by, ended_reason, ended_at is not null as ended
     from core.access_memberships where principal_id = '${principalId}' and kind = 'member'
`,
  );

/** A `member` row nobody ended, as `memberEndsOf` reads it. */
const liveMemberRow = (scopeId: string): MemberEndRow => ({
  ended: false,
  ended_by: null,
  ended_reason: null,
  scope_id: scopeId,
  status: 'active',
});

/** The statuses of one person's tenant ownership rows. */
const ownerRowsOf = (accessCase: AccessAdminCase, principalId: string) =>
  rowsOf<{ readonly status: string }>(
    accessCase,
    `select status from core.access_memberships
     where tenant_id = '${accessCase.tenantId}' and principal_id = '${principalId}' and kind = 'owner'`,
  ).pipe(Effect.map((rows) => rows.map(({ status }) => status)));

/** The membership id the Shell mints for one admission key in one scope. */
const mintedMembershipId = (accessCase: AccessAdminCase, key: string, scopeId: string) =>
  stableUuid(['ontos.shell.access-people.membership', accessCase.tenantId, key, scopeId].join(':'));

/** Every Lidé write payload, as the browser sends it. */
type PeopleWritePayload =
  | typeof AdmitAccessMemberPayloadSchema.Encoded
  | typeof AssignAccessRolePayloadSchema.Encoded
  | typeof CreateAccessDelegationPayloadSchema.Encoded
  | typeof EndAccessMembershipPayloadSchema.Encoded
  | typeof RevokeAccessAssignmentPayloadSchema.Encoded
  | typeof RevokeAccessDelegationPayloadSchema.Encoded
  | typeof SetAccessTeamMembershipPayloadSchema.Encoded
  | typeof TransferAccessOwnershipPayloadSchema.Encoded;

/** The case's actors and the helpers every scenario writes through. */
const scenarioOf = (accessCase: AccessAdminCase, shell: ShellHttp) => {
  const [companyA = '', companyB = ''] = accessCase.companies;
  const idOf = (persona: Persona) => accessCase.ids.get(persona)?.principalId ?? '';
  /** One write by a persona, in the tenant context or with the named company selected in the Shell. */
  const write = (
    persona: Persona,
    path: string,
    idempotencyKey: string,
    payload: PeopleWritePayload,
    legalEntityId?: string,
  ) =>
    shell.post(
      legalEntityId === undefined
        ? { idempotencyKey, path: `${PEOPLE}/${path}`, payload, persona }
        : { idempotencyKey, legalEntityId, path: `${PEOPLE}/${path}`, payload, persona },
    );
  /** The revision of what this persona's Lidé screen shows right now, in the session's company. */
  const revisionOf = (persona: Persona, legalEntityId?: string) =>
    Effect.gen(function* readRevision() {
      const request = { path: `${PEOPLE}/list`, payload: { limit: 100 }, persona };
      const answer = yield* shell.post(legalEntityId === undefined ? request : { ...request, legalEntityId });
      expectStatus(answer, 200);
      return (yield* decodeBody(ListAccessPeopleResponseSchema, answer.text)).revision;
    });
  const tasksIn = (persona: Persona, legalEntityId: string) =>
    accessCase
      .decide({ declarationKey: TASKS_CAPABILITY_KEY, legalEntityId, persona, scope: 'legal-entity' })
      .pipe(Effect.map(({ outcome }) => outcome));
  return {
    company: (legalEntityId: string) => ({ kind: 'company' as const, legalEntityId }),
    companyA,
    companyB,
    idOf,
    revisionOf,
    tasksIn,
    write,
  };
};

export const admission = (accessCase: AccessAdminCase) =>
  Effect.scoped(
    Effect.gen(function* admissionCase() {
      const shell = yield* shellHttpFor(accessCase);
      const { company, companyA, companyB, idOf, revisionOf, tasksIn, write } = scenarioOf(accessCase, shell);
      const newcomer = idOf('directoryMember');
      const foreignNewcomer = accessCase.foreignIds.get('directoryMember')?.principalId ?? '';

      const options = yield* shell.post({
        path: `${PEOPLE}/options`,
        payload: { limit: 100 },
        persona: 'owner',
      });
      expectStatus(options, 200);
      const offered = yield* decodeBody(ListAccessPeopleOptionsResponseSchema, options.text);
      expect(offered.writeAvailability.canAdmitMember).toBe(true);
      expect(offered.writeAvailability.canEndMembership).toBe(true);
      const candidates = offered.admissionCandidates.map(({ principalId, scope }) => ({ principalId, scope }));
      expect(candidates).toContainEqual({ principalId: newcomer, scope: company(companyA) });
      // Departed, already a live member there, or another tenant's person: never offered.
      for (const absent of [idOf('departed'), idOf('member'), foreignNewcomer]) {
        expect(candidates).not.toContainEqual({ principalId: absent, scope: company(companyA) });
      }

      const ownerRevision = yield* revisionOf('owner');
      const admitInto = (principalId: string, legalEntityId: string, expectedRevision: string) => ({
        expectedRevision,
        principalId,
        scope: company(legalEntityId),
      });

      const anonymous = yield* shell.post({
        idempotencyKey: 'admit-anonymous',
        path: `${PEOPLE}/admit-member`,
        payload: admitInto(newcomer, companyA, ownerRevision),
      });
      expectStatus(anonymous, 401);

      // Refused before anything is written: no authority there, or nobody the directory admits.
      const refusals: readonly (readonly [Persona, string, string, string])[] = [
        ['companyAdmin', newcomer, companyB, yield* revisionOf('companyAdmin')],
        ['member', newcomer, companyA, ownerRevision],
        ['agent', newcomer, companyA, ownerRevision],
        ['foreignOwner', newcomer, companyA, yield* revisionOf('foreignOwner')],
        ['owner', foreignNewcomer, companyA, ownerRevision],
        ['owner', idOf('departed'), companyA, ownerRevision],
        // In company A's directory only: never a member of company B's.
        ['owner', idOf('departed'), companyB, ownerRevision],
      ];
      for (const [persona, principalId, legalEntityId, revision] of refusals) {
        const refused = yield* write(
          persona,
          'admit-member',
          `refused-${persona}-${principalId}-${legalEntityId}`,
          admitInto(principalId, legalEntityId, revision),
        );
        expect({ legalEntityId, persona, principalId, status: refused.status }).toEqual({
          legalEntityId,
          persona,
          principalId,
          status: 403,
        });
      }
      expect(yield* membershipsOf(accessCase, newcomer)).toEqual([]);
      expect(yield* membershipsOf(accessCase, idOf('departed'))).toEqual([]);
      expect(yield* membershipsOf(accessCase, foreignNewcomer)).toEqual([]);

      // Company A's own administrator admits: permanent authority over that company, offered company A's
      // candidates only, and Core writes the tenant row as well (owner decision), both recorded by them.
      const adminOptions = yield* shell.post({
        path: `${PEOPLE}/options`,
        payload: { limit: 100 },
        persona: 'companyAdmin',
      });
      expectStatus(adminOptions, 200);
      const adminOffered = yield* decodeBody(ListAccessPeopleOptionsResponseSchema, adminOptions.text);
      expect({
        canAdmitMember: adminOffered.writeAvailability.canAdmitMember,
        canEndMembership: adminOffered.writeAvailability.canEndMembership,
        outsideA: adminOffered.admissionCandidates.filter(({ scope }) => scope.legalEntityId !== companyA),
      }).toEqual({ canAdmitMember: true, canEndMembership: true, outsideA: [] });
      expect(adminOffered.admissionCandidates.map(({ principalId, scope }) => ({ principalId, scope }))).toContainEqual(
        { principalId: newcomer, scope: company(companyA) },
      );

      const key = 'admit-newcomer-into-a';
      const adminRevision = yield* revisionOf('companyAdmin');
      const admitted = yield* write('companyAdmin', 'admit-member', key, admitInto(newcomer, companyA, adminRevision));
      expectStatus(admitted, 200);
      const answer = yield* decodeBody(AccessPeopleMutationResponseSchema, admitted.text);
      expect(answer.membership).toEqual({ principalId: newcomer, scope: company(companyA), status: 'active' });
      // Exactly the two rows a company decision rests on, named by the key and scope, recorded by the
      // company administrator who admitted.
      const tenantScopeId = yield* accessCase.scopeIdOf();
      const scopeA = yield* accessCase.scopeIdOf(companyA);
      const scopeB = yield* accessCase.scopeIdOf(companyB);
      const owner = idOf('owner');
      const companyAdmin = idOf('companyAdmin');
      const admittedRows = yield* membershipsOf(accessCase, newcomer);
      expect(admittedRows).toHaveLength(2);
      expect(admittedRows).toEqual(
        expect.arrayContaining([
          {
            kind: 'member',
            membership_id: mintedMembershipId(accessCase, key, tenantScopeId),
            recorded_by: companyAdmin,
            scope_id: tenantScopeId,
            status: 'active',
          },
          {
            kind: 'member',
            membership_id: mintedMembershipId(accessCase, key, scopeA),
            recorded_by: companyAdmin,
            scope_id: scopeA,
            status: 'active',
          },
        ]),
      );
      const listed = yield* shell.post({ path: `${PEOPLE}/list`, payload: { limit: 100 }, persona: 'owner' });
      const page = yield* decodeBody(ListAccessPeopleResponseSchema, listed.text);
      expect(page.items.map(({ principalId }) => principalId)).toContain(newcomer);

      // A retry after the commit meets a moved revision, and a new key for a live member is a moved row
      // the screen repairs by re-reading (design: 409 people_membership_already_active), never a second row.
      const replay = yield* write('companyAdmin', 'admit-member', key, admitInto(newcomer, companyA, adminRevision));
      expectStatus(replay, 409);
      const again = yield* write(
        'owner',
        'admit-member',
        'admit-newcomer-into-a-again',
        admitInto(newcomer, companyA, yield* revisionOf('owner')),
      );
      expectRefusal(again, 409, 'people_membership_already_active');
      expect(yield* membershipsOf(accessCase, newcomer)).toEqual(admittedRows);

      // Admission grants nothing by itself; an assignment after it does, in that company only.
      expect(yield* tasksIn('directoryMember', companyA)).toBe('DENIED');
      const assigned = yield* write('owner', 'assign', 'assign-newcomer-tasks-a', {
        expectedRevision: yield* revisionOf('owner'),
        expectedRoleRevisionId: accessCase.seeded.tasksRoleA.roleRevisionId,
        principalId: newcomer,
        roleId: accessCase.seeded.tasksRoleA.roleId,
        scope: company(companyA),
      });
      expectStatus(assigned, 200);
      expect(yield* tasksIn('directoryMember', companyA)).toBe('ALLOWED');
      expect(yield* tasksIn('directoryMember', companyB)).toBe('DENIED');

      // The payload has no kind: one smuggled in never reaches Core, and company B gains only its
      // member row (the live tenant row is reused, never doubled).
      const smuggled = yield* shell.post({
        idempotencyKey: 'admit-newcomer-into-b',
        path: `${PEOPLE}/admit-member`,
        payload: { ...admitInto(newcomer, companyB, yield* revisionOf('owner')), kind: 'owner' },
        persona: 'owner',
      });
      expectStatus(smuggled, 200);
      const rows = yield* membershipsOf(accessCase, newcomer);
      expect(rows.map(({ kind }) => kind)).toEqual(['member', 'member', 'member']);
      expect(rows.filter(({ scope_id: scopeId }) => scopeId === tenantScopeId)).toHaveLength(1);

      // Company A's administrator ends the newcomer's company-A membership: the end is theirs, the role
      // there ends with it, and the tenant and company-B rows stay live.
      const endedInA = yield* write('companyAdmin', 'end-membership', 'admin-ends-newcomer-in-a', {
        expectedRevision: yield* revisionOf('companyAdmin'),
        principalId: newcomer,
        reason: LEAVER_REASON,
        scope: company(companyA),
      });
      expectStatus(endedInA, 200);
      const endedByAdmin = {
        ended: true,
        ended_by: companyAdmin,
        ended_reason: LEAVER_REASON,
        scope_id: scopeA,
        status: 'revoked',
      };
      const afterAdminEnd = yield* memberEndsOf(accessCase, newcomer);
      expect(afterAdminEnd).toHaveLength(3);
      expect(afterAdminEnd).toEqual(
        expect.arrayContaining([liveMemberRow(tenantScopeId), endedByAdmin, liveMemberRow(scopeB)]),
      );
      expect(yield* tasksIn('directoryMember', companyA)).toBe('DENIED');

      // The owner with company A selected in the Shell, as the stage apply and the screens run: ending the
      // tenant membership closes company B with it, and a fresh admission writes a new tenant row again.
      const endedTenant = yield* write(
        'owner',
        'end-membership',
        'owner-in-a-ends-newcomer',
        {
          expectedRevision: yield* revisionOf('owner', companyA),
          principalId: newcomer,
          reason: LEAVER_REASON,
          scope: { kind: 'tenant' },
        },
        companyA,
      );
      expectStatus(endedTenant, 200);
      const endedByOwner = (scopeId: string) => ({
        ended: true,
        ended_by: owner,
        ended_reason: LEAVER_REASON,
        scope_id: scopeId,
        status: 'revoked',
      });
      const afterTenantEnd = yield* memberEndsOf(accessCase, newcomer);
      expect(afterTenantEnd).toHaveLength(3);
      expect(afterTenantEnd).toEqual(
        expect.arrayContaining([endedByOwner(tenantScopeId), endedByAdmin, endedByOwner(scopeB)]),
      );
      const rejoinKey = 'owner-in-a-readmits-newcomer';
      const rejoined = yield* write(
        'owner',
        'admit-member',
        rejoinKey,
        admitInto(newcomer, companyA, yield* revisionOf('owner', companyA)),
        companyA,
      );
      expectStatus(rejoined, 200);
      const rejoinedRows = (yield* membershipsOf(accessCase, newcomer)).filter(({ status }) => status === 'active');
      expect(rejoinedRows).toHaveLength(2);
      expect(rejoinedRows).toEqual(
        expect.arrayContaining([
          {
            kind: 'member',
            membership_id: mintedMembershipId(accessCase, rejoinKey, tenantScopeId),
            recorded_by: owner,
            scope_id: tenantScopeId,
            status: 'active',
          },
          {
            kind: 'member',
            membership_id: mintedMembershipId(accessCase, rejoinKey, scopeA),
            recorded_by: owner,
            scope_id: scopeA,
            status: 'active',
          },
        ]),
      );
      expect(yield* tasksIn('directoryMember', companyA)).toBe('DENIED');
    }),
  );

export const coreRefusals = (accessCase: AccessAdminCase) =>
  Effect.scoped(
    Effect.gen(function* coreRefusalsCase() {
      const shell = yield* shellHttpFor(accessCase);
      const { company, companyA, companyB, idOf, revisionOf, tasksIn, write } = scenarioOf(accessCase, shell);

      // Skeptic S1: the lapsed person's tenant row expired while company B's row and B role stay
      // active. A fresh tenant row written for company A would switch B back on, in a company the
      // acting administrator does not administer.
      const lapsed = idOf('lapsed');
      const before = yield* membershipsOf(accessCase, lapsed);
      expect(yield* tasksIn('lapsed', companyB)).toBe('DENIED');
      const revived = yield* write('companyAdmin', 'admit-member', 'admit-lapsed-into-a', {
        expectedRevision: yield* revisionOf('companyAdmin'),
        principalId: lapsed,
        scope: company(companyA),
      });
      // Core's dormant-row rule answers, not a Shell-side conflict that never reached it.
      expectRefusal(revived, 422, 'people_membership_ended');
      expect(yield* membershipsOf(accessCase, lapsed)).toEqual(before);
      expect(yield* tasksIn('lapsed', companyB)).toBe('DENIED');

      // The manager's delegation names admit-member and end-membership. No command can grant that
      // (the release publishes neither key), so the fixture wrote it by SQL; the gate admits the
      // manager in company A, and Core's permanent-authority rule is what refuses both writes. The
      // options never offer the manager either write, so the screen shows no control Core would refuse.
      const managerOptions = yield* shell.post({
        path: `${PEOPLE}/options`,
        payload: { limit: 100 },
        persona: 'manager',
      });
      expectStatus(managerOptions, 200);
      const managerOffered = yield* decodeBody(ListAccessPeopleOptionsResponseSchema, managerOptions.text);
      expect({
        admissionCandidates: managerOffered.admissionCandidates,
        canAdmitMember: managerOffered.writeAvailability.canAdmitMember,
        canEndMembership: managerOffered.writeAvailability.canEndMembership,
      }).toEqual({ admissionCandidates: [], canAdmitMember: false, canEndMembership: false });
      const managerRevision = yield* revisionOf('manager');
      const admitted = yield* write('manager', 'admit-member', 'manager-admits', {
        expectedRevision: managerRevision,
        principalId: idOf('directoryMember'),
        scope: company(companyA),
      });
      expectRefusal(admitted, 403, 'people_authority_missing');
      expect(yield* membershipsOf(accessCase, idOf('directoryMember'))).toEqual([]);
      const membersBefore = yield* membershipsOf(accessCase, idOf('member'));
      const ended = yield* write('manager', 'end-membership', 'manager-ends', {
        expectedRevision: managerRevision,
        principalId: idOf('member'),
        reason: LEAVER_REASON,
        scope: company(companyA),
      });
      expectRefusal(ended, 403, 'people_authority_missing');
      expect(yield* membershipsOf(accessCase, idOf('member'))).toEqual(membersBefore);

      // Skeptic S4: ending a co-administrator's company row would end their administration too, which
      // only the tenant owner decides. The member becomes company A's second access administrator here
      // (fixture SQL, as the seeds hold only one), so company A's own administrator may not end them.
      const coAdmin = idOf('member');
      const scopeA = yield* accessCase.scopeIdOf(companyA);
      yield* rowsOf(
        accessCase,
        `insert into core.access_memberships
           (membership_id, tenant_id, scope_id, principal_id, kind, status, valid_from, recorded_by)
         values (gen_random_uuid(), '${accessCase.tenantId}', '${scopeA}', '${coAdmin}', 'access_admin', 'active',
                 now() - interval '1 day', '${idOf('owner')}')`,
      );
      const coAdminBefore = yield* membershipsOf(accessCase, coAdmin);
      const byCompanyAdmin = yield* write('companyAdmin', 'end-membership', 'company-admin-ends-co-admin', {
        expectedRevision: yield* revisionOf('companyAdmin'),
        principalId: coAdmin,
        reason: LEAVER_REASON,
        scope: company(companyA),
      });
      expectRefusal(byCompanyAdmin, 403, 'people_authority_missing');
      expect(yield* membershipsOf(accessCase, coAdmin)).toEqual(coAdminBefore);
      // The tenant owner may: the company row and the administration standing on it end together,
      // while the co-administrator's tenant and company-B rows stay.
      const byOwner = yield* write('owner', 'end-membership', 'owner-ends-co-admin', {
        expectedRevision: yield* revisionOf('owner'),
        principalId: coAdmin,
        reason: LEAVER_REASON,
        scope: company(companyA),
      });
      expectStatus(byOwner, 200);
      const coAdminAfter = yield* membershipsOf(accessCase, coAdmin);
      expect(
        coAdminAfter
          .filter(({ scope_id: scopeId }) => scopeId === scopeA)
          .map(({ kind, status }) => ({ kind, status }))
          .toSorted((left, right) => left.kind.localeCompare(right.kind)),
      ).toEqual([
        { kind: 'access_admin', status: 'revoked' },
        { kind: 'member', status: 'revoked' },
      ]);
      expect(coAdminAfter.filter(({ scope_id: scopeId }) => scopeId !== scopeA).map(({ status }) => status)).toEqual([
        'active',
        'active',
      ]);
    }),
  );

export const endMembership = (accessCase: AccessAdminCase) =>
  Effect.scoped(
    Effect.gen(function* endMembershipCase() {
      const shell = yield* shellHttpFor(accessCase);
      const { company, companyA, idOf, revisionOf, tasksIn, write } = scenarioOf(accessCase, shell);
      const { managerDelegationId, managerTasksAssignmentId, teamId } = accessCase.seeded;
      const leaver = idOf('manager');
      const owner = idOf('owner');
      const tenantScopeId = yield* accessCase.scopeIdOf();
      const scopeA = yield* accessCase.scopeIdOf(companyA);
      const companyRowsOf = () => memberRowsIn(accessCase, leaver, scopeA);
      const [seededRow] = yield* companyRowsOf();
      const directoryRow = rowsOf<{
        readonly revision: number;
        readonly status: string;
        readonly updated_at: Date;
      }>(
        accessCase,
        `select status, revision, updated_at from core.principal_company_memberships
       where legal_entity_id = '${companyA}' and principal_id = '${leaver}'`,
      );
      const directoryBefore = yield* directoryRow;
      expect(yield* tasksIn('manager', companyA)).toBe('ALLOWED');

      // A company administrator never reaches the tenant context, so never ends a tenant row.
      const tenantEnd = yield* write('companyAdmin', 'end-membership', 'company-admin-ends-tenant', {
        expectedRevision: yield* revisionOf('companyAdmin'),
        principalId: leaver,
        reason: LEAVER_REASON,
        scope: { kind: 'tenant' },
      });
      expectStatus(tenantEnd, 403);

      const ended = yield* write('owner', 'end-membership', 'owner-ends-manager-in-a', {
        expectedRevision: yield* revisionOf('owner'),
        principalId: leaver,
        reason: LEAVER_REASON,
        scope: company(companyA),
      });
      expectStatus(ended, 200);
      const answer = yield* decodeBody(AccessPeopleMutationResponseSchema, ended.text);
      expect(answer.membership).toEqual({ principalId: leaver, scope: company(companyA), status: 'revoked' });
      // Who, when and why, on the row that ended; the tenant row stays live.
      const endedRows = yield* memberEndsOf(accessCase, leaver);
      expect(endedRows).toHaveLength(2);
      expect(endedRows).toEqual(
        expect.arrayContaining([
          { ended: true, ended_by: owner, ended_reason: LEAVER_REASON, scope_id: scopeA, status: 'revoked' },
          { ended: false, ended_by: null, ended_reason: null, scope_id: tenantScopeId, status: 'active' },
        ]),
      );
      // In the same transaction: the assignment, the team place and the managed delegation end.
      expect(yield* statusOf(accessCase, 'access_assignments', 'incarnation_id', managerTasksAssignmentId)).not.toBe(
        'active',
      );
      expect(
        yield* countOf(
          accessCase,
          `select 1 from core.access_team_members where team_id = '${teamId}' and principal_id = '${leaver}'`,
        ),
      ).toBe(0);
      expect(yield* statusOf(accessCase, 'access_delegations', 'delegation_id', managerDelegationId)).not.toBe(
        'active',
      );
      // Access ended; the company directory did not.
      expect(yield* directoryRow).toEqual(directoryBefore);
      expect(yield* tasksIn('manager', companyA)).toBe('DENIED');

      // Re-admission is a fresh membership: a new row, the old one still ended, no role back.
      const readmitKey = 'owner-readmits-manager-into-a';
      const readmitted = yield* write('owner', 'admit-member', readmitKey, {
        expectedRevision: yield* revisionOf('owner'),
        principalId: leaver,
        scope: company(companyA),
      });
      expectStatus(readmitted, 200);
      const companyRows = yield* companyRowsOf();
      expect(companyRows).toHaveLength(2);
      expect(companyRows).toEqual(
        expect.arrayContaining([
          { id: seededRow?.id, status: 'revoked' },
          { id: mintedMembershipId(accessCase, readmitKey, scopeA), status: 'active' },
        ]),
      );
      expect(yield* statusOf(accessCase, 'access_assignments', 'incarnation_id', managerTasksAssignmentId)).not.toBe(
        'active',
      );
      expect(yield* tasksIn('manager', companyA)).toBe('DENIED');

      // The sole owner cannot end their own tenant membership. While a delegation they granted is live,
      // that is the refusal; once they revoked it, the last-owner rule answers, and nothing is written.
      const ownerBefore = yield* membershipsOf(accessCase, owner);
      const ownerEnd = (idempotencyKey: string) =>
        Effect.flatMap(revisionOf('owner'), (expectedRevision) =>
          write('owner', 'end-membership', idempotencyKey, {
            expectedRevision,
            principalId: owner,
            reason: LEAVER_REASON,
            scope: { kind: 'tenant' },
          }),
        );
      expectRefusal(yield* ownerEnd('owner-ends-self-while-granting'), 409, 'people_granted_delegations_live');
      const grants = yield* rowsOf<{ readonly delegation_id: string }>(
        accessCase,
        `select delegation_id::text from core.access_delegations
         where tenant_id = '${accessCase.tenantId}' and granted_by = '${owner}' and status = 'active'`,
      );
      expect(grants.length).toBeGreaterThan(0);
      for (const { delegation_id: delegationId } of grants) {
        const revoked = yield* write('owner', 'revoke-delegation', `owner-revokes-${delegationId}`, {
          delegationId,
          expectedRevision: yield* revisionOf('owner'),
          reason: 'P14: the owner leaves nothing granted behind',
        });
        expectStatus(revoked, 200);
      }
      expectRefusal(yield* ownerEnd('owner-ends-self'), 409, 'ownership_transfer_required');
      expect(yield* membershipsOf(accessCase, owner)).toEqual(ownerBefore);
    }),
  );

export const roleAssignment = (accessCase: AccessAdminCase) =>
  Effect.scoped(
    Effect.gen(function* roleAssignmentCase() {
      const shell = yield* shellHttpFor(accessCase);
      const { company, companyA, idOf, revisionOf, tasksIn, write } = scenarioOf(accessCase, shell);
      const { tasksRoleA, tasksRoleB, teamId } = accessCase.seeded;
      const member = idOf('member');
      const assignTasks = (principalId: string, expectedRevision: string, roleRevisionId: string) => ({
        expectedRevision,
        expectedRoleRevisionId: roleRevisionId,
        principalId,
        roleId: tasksRoleA.roleId,
        scope: company(companyA),
      });
      const assignmentsOf = (principalId: string) =>
        countOf(accessCase, `select 1 from core.access_assignments where principal_id = '${principalId}'`);

      // Holding a role needs a live membership in its company: the lapsed person has none in A.
      const lapsedBefore = yield* assignmentsOf(idOf('lapsed'));
      const notMember = yield* write(
        'owner',
        'assign',
        'assign-lapsed',
        assignTasks(idOf('lapsed'), yield* revisionOf('owner'), tasksRoleA.roleRevisionId),
      );
      expectRefusal(notMember, 422, 'people_holder_not_a_member');
      expect(yield* assignmentsOf(idOf('lapsed'))).toBe(lapsedBefore);

      // Company B's role is not company A's administrator's to hand out.
      const foreignRole = yield* write('companyAdmin', 'assign', 'assign-b-role', {
        expectedRevision: yield* revisionOf('companyAdmin'),
        expectedRoleRevisionId: tasksRoleB.roleRevisionId,
        principalId: member,
        roleId: tasksRoleB.roleId,
        scope: company(companyA),
      });
      expectStatus(foreignRole, 403);

      const ownerRevision = yield* revisionOf('owner');
      const staleRole = yield* write(
        'owner',
        'assign',
        'assign-stale-role',
        assignTasks(member, ownerRevision, globalThis.crypto.randomUUID()),
      );
      expectStatus(staleRole, 409);
      expect(yield* assignmentsOf(member)).toBe(0);

      const assigned = yield* write(
        'owner',
        'assign',
        'assign-member',
        assignTasks(member, ownerRevision, tasksRoleA.roleRevisionId),
      );
      expectStatus(assigned, 200);
      const incarnationId =
        (yield* decodeBody(AccessPeopleMutationResponseSchema, assigned.text)).assignment?.incarnationId ?? '';
      expect(yield* tasksIn('member', companyA)).toBe('ALLOWED');
      // A second write on the same screen revision is stale: the first one moved it.
      const delegateBefore = yield* assignmentsOf(idOf('delegate'));
      const sameRevision = yield* write(
        'owner',
        'assign',
        'assign-delegate',
        assignTasks(idOf('delegate'), ownerRevision, tasksRoleA.roleRevisionId),
      );
      expectStatus(sameRevision, 409);
      expect(yield* assignmentsOf(idOf('delegate'))).toBe(delegateBefore);

      const revoke = {
        expectedRevision: yield* revisionOf('owner'),
        incarnationId,
        reason: 'P14: role no longer needed',
      };
      const revoked = yield* write('owner', 'revoke-assignment', 'revoke-member', revoke);
      expectStatus(revoked, 200);
      expect(yield* statusOf(accessCase, 'access_assignments', 'incarnation_id', incarnationId)).toBe('revoked');
      expect(yield* tasksIn('member', companyA)).toBe('DENIED');
      const replay = yield* write('owner', 'revoke-assignment', 'revoke-member', revoke);
      expectStatus(replay, 409);

      // A team place is authority too: only for a live member of the team's company.
      const teamPlaces = (principalId: string) =>
        countOf(
          accessCase,
          `select 1 from core.access_team_members where team_id = '${teamId}' and principal_id = '${principalId}'`,
        );
      const outsider = yield* write('owner', 'team-membership', 'team-lapsed', {
        action: 'join',
        expectedRevision: yield* revisionOf('owner'),
        principalId: idOf('lapsed'),
        teamId,
      });
      expectRefusal(outsider, 422, 'people_holder_not_a_member');
      expect(yield* teamPlaces(idOf('lapsed'))).toBe(0);
      const joined = yield* write('owner', 'team-membership', 'team-member', {
        action: 'join',
        expectedRevision: yield* revisionOf('owner'),
        principalId: member,
        teamId,
      });
      expectStatus(joined, 200);
      expect(yield* teamPlaces(member)).toBe(1);
    }),
  );

export const delegation = (accessCase: AccessAdminCase) =>
  Effect.scoped(
    Effect.gen(function* delegationCase() {
      const shell = yield* shellHttpFor(accessCase);
      const { company, companyA, companyB, idOf, revisionOf, tasksIn, write } = scenarioOf(accessCase, shell);
      const { managerDelegationId, tasksRoleA } = accessCase.seeded;
      const delegations = countOf(accessCase, 'select 1 from core.access_delegations');
      const delegationsBefore = yield* delegations;
      const delegate = (
        expectedRevision: string,
        capabilityKey: string,
        managerId: string,
      ): typeof CreateAccessDelegationPayloadSchema.Encoded => ({
        capabilityKeys: [capabilityKey],
        expectedRevision,
        managerId,
        people: [idOf('delegate')],
        roleIds: [tasksRoleA.roleId],
        scope: company(companyA),
        validUntil: DELEGATION_END,
      });

      // The company administrator holds the administrator role, not the tasks capability.
      const adminRevision = yield* revisionOf('companyAdmin');
      const beyond = yield* write(
        'companyAdmin',
        'delegate',
        'delegate-beyond',
        delegate(adminRevision, TASKS_CAPABILITY_KEY, idOf('member')),
      );
      expectRefusal(beyond, 403, 'delegation_outside_grantor_authority');
      const self = yield* write(
        'companyAdmin',
        'delegate',
        'delegate-self',
        delegate(adminRevision, TASKS_CAPABILITY_KEY, idOf('companyAdmin')),
      );
      expectRefusal(self, 403, 'delegation_self_grant');
      expect(yield* delegations).toBe(delegationsBefore);

      // The manager assigns inside the owner's envelope (the tasks role, to the member) and nowhere else.
      const managerRevision = yield* revisionOf('manager');
      const assignAsManager = (principalId: string, key: string, expectedRevision: string) =>
        write('manager', 'assign', key, {
          expectedRevision,
          expectedRoleRevisionId: tasksRoleA.roleRevisionId,
          principalId,
          roleId: tasksRoleA.roleId,
          scope: company(companyA),
          validUntil: DELEGATED_UNTIL,
        });
      const inside = yield* assignAsManager(idOf('member'), 'manager-assigns-member', managerRevision);
      expectStatus(inside, 200);
      expect(yield* tasksIn('member', companyA)).toBe('ALLOWED');
      const outside = yield* assignAsManager(
        idOf('delegate'),
        'manager-assigns-delegate',
        yield* revisionOf('manager'),
      );
      expectRefusal(outside, 422, 'delegation_holder_outside_envelope');
      expect(yield* tasksIn('delegate', companyA)).toBe('DENIED');

      const revoked = yield* write('owner', 'revoke-delegation', 'owner-revokes-manager', {
        delegationId: managerDelegationId,
        expectedRevision: yield* revisionOf('owner'),
        reason: 'P14: delegation over',
      });
      expectStatus(revoked, 200);
      expect(yield* statusOf(accessCase, 'access_delegations', 'delegation_id', managerDelegationId)).toBe('revoked');
      const afterRevoke = yield* assignAsManager(idOf('member'), 'manager-after-revoke', managerRevision);
      expectStatus(afterRevoke, 403);

      // A delegation inside the grantor's authority: an administration key they hold, over the tasks role.
      const administersIn = (legalEntityId: string) =>
        accessCase
          .decide({ declarationKey: SPINE_DECLARATION, legalEntityId, persona: 'member', scope: 'legal-entity' })
          .pipe(Effect.map(({ outcome }) => outcome));
      expect(yield* administersIn(companyA)).toBe('DENIED');
      const granted = yield* write(
        'companyAdmin',
        'delegate',
        'delegate-within',
        delegate(yield* revisionOf('companyAdmin'), SPINE_DECLARATION, idOf('member')),
      );
      expectStatus(granted, 200);
      expect(yield* delegations).toBe(delegationsBefore + 1);
      const grantedId = (yield* decodeBody(AccessPeopleMutationResponseSchema, granted.text)).delegation?.delegationId;
      const scopeA = yield* accessCase.scopeIdOf(companyA);
      // Persisted as asked: the grantor, the manager, the person, the role, the key and the scope.
      expect(
        yield* rowsOf(
          accessCase,
          `select granted_by::text, manager_id::text, people::text[] as people, role_ids::text[] as role_ids,
                  capability_keys::text[] as capability_keys, scope_id::text, status,
                  until = '${DELEGATION_END}'::timestamptz as ends_as_asked
           from core.access_delegations where delegation_id = '${grantedId ?? ''}'`,
        ),
      ).toEqual([
        {
          capability_keys: [SPINE_DECLARATION],
          ends_as_asked: true,
          granted_by: idOf('companyAdmin'),
          manager_id: idOf('member'),
          people: [idOf('delegate')],
          role_ids: [tasksRoleA.roleId],
          scope_id: scopeA,
          status: 'active',
        },
      ]);
      // And the real gate follows it: the manager now holds that key in company A through the delegation,
      // and nowhere else.
      expect(yield* administersIn(companyA)).toBe('ALLOWED');
      expect(yield* administersIn(companyB)).toBe('DENIED');
      // While it is live its grantor is not ended: the owner decision is refuse, never cascade.
      const grantorRows = yield* membershipsOf(accessCase, idOf('companyAdmin'));
      const grantorEnd = yield* write('owner', 'end-membership', 'owner-ends-grantor', {
        expectedRevision: yield* revisionOf('owner'),
        principalId: idOf('companyAdmin'),
        reason: LEAVER_REASON,
        scope: company(companyA),
      });
      expectRefusal(grantorEnd, 409, 'people_granted_delegations_live');
      expect(yield* membershipsOf(accessCase, idOf('companyAdmin'))).toEqual(grantorRows);
    }),
  );

export const ownership = (accessCase: AccessAdminCase) =>
  Effect.scoped(
    Effect.gen(function* ownershipCase() {
      const shell = yield* shellHttpFor(accessCase);
      const { idOf, revisionOf, write } = scenarioOf(accessCase, shell);
      const owner = idOf('owner');
      const member = idOf('member');
      const transferTo = (
        toPrincipalId: string,
        expectedRevision: string,
      ): typeof TransferAccessOwnershipPayloadSchema.Encoded => ({
        expectedRevision,
        fromPrincipalId: owner,
        scopes: [{ kind: 'tenant' }],
        toPrincipalId,
      });
      const owners = countOf(
        accessCase,
        "select 1 from core.access_memberships where kind = 'owner' and status = 'active'",
      );
      const ownersBefore = yield* owners;

      const toSelf = yield* write(
        'owner',
        'transfer-ownership',
        'transfer-to-self',
        transferTo(owner, yield* revisionOf('owner')),
      );
      expectRefusal(toSelf, 422, 'ownership_transfer_self');
      // A company administrator never reaches the tenant's ownership.
      const byAdmin = yield* write(
        'companyAdmin',
        'transfer-ownership',
        'transfer-by-admin',
        transferTo(member, yield* revisionOf('companyAdmin')),
      );
      expectStatus(byAdmin, 403);
      expect(yield* owners).toBe(ownersBefore);

      const administersTenant = accessCase
        .decide({ declarationKey: SPINE_DECLARATION, persona: 'member', scope: 'tenant' })
        .pipe(Effect.map(({ outcome }) => outcome));
      expect(yield* administersTenant).toBe('DENIED');
      const transferred = yield* write(
        'owner',
        'transfer-ownership',
        'transfer-to-member',
        transferTo(member, yield* revisionOf('owner')),
      );
      expectStatus(transferred, 200);
      // The successor now administers the tenant structurally, with no role cell behind it.
      expect(yield* administersTenant).toBe('ALLOWED');
      // Handed on, never doubled: the old owner's row ended and the tenant still has one owner.
      expect(yield* owners).toBe(ownersBefore);
      expect(yield* ownerRowsOf(accessCase, owner)).toEqual(['revoked']);
      expect(yield* ownerRowsOf(accessCase, member)).toEqual(['active']);
    }),
  );
