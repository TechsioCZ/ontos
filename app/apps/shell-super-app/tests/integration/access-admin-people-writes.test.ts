import { stableUuid } from '@app/core-runtime/access/catalog';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

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
import {
  TASKS_CAPABILITY_KEY,
  accessAdminTemplateLayer,
  shellHttpFor,
  withAccessAdminCase,
} from '../support/access-admin-real-gate-fixture.ts';
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
const CASE_TIMEOUT = 300_000;
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
  const write = (persona: Persona, path: string, idempotencyKey: string, payload: PeopleWritePayload) =>
    shell.post({ idempotencyKey, path: `${PEOPLE}/${path}`, payload, persona });
  /** The revision of what this persona's Lidé screen shows right now. */
  const revisionOf = (persona: Persona) =>
    Effect.gen(function* readRevision() {
      const answer = yield* shell.post({ path: `${PEOPLE}/list`, payload: { limit: 100 }, persona });
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

const admission = (accessCase: AccessAdminCase) =>
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

      const key = 'admit-newcomer-into-a';
      const admitted = yield* write('owner', 'admit-member', key, admitInto(newcomer, companyA, ownerRevision));
      expectStatus(admitted, 200);
      const answer = yield* decodeBody(AccessPeopleMutationResponseSchema, admitted.text);
      expect(answer.membership).toEqual({ principalId: newcomer, scope: company(companyA), status: 'active' });
      // Exactly the two rows a company decision rests on, named by the key and scope, recorded by the owner.
      const tenantScopeId = yield* accessCase.scopeIdOf();
      const scopeA = yield* accessCase.scopeIdOf(companyA);
      const owner = idOf('owner');
      const admittedRows = yield* membershipsOf(accessCase, newcomer);
      expect(admittedRows).toHaveLength(2);
      expect(admittedRows).toEqual(
        expect.arrayContaining([
          {
            kind: 'member',
            membership_id: mintedMembershipId(accessCase, key, tenantScopeId),
            recorded_by: owner,
            scope_id: tenantScopeId,
            status: 'active',
          },
          {
            kind: 'member',
            membership_id: mintedMembershipId(accessCase, key, scopeA),
            recorded_by: owner,
            scope_id: scopeA,
            status: 'active',
          },
        ]),
      );
      const listed = yield* shell.post({ path: `${PEOPLE}/list`, payload: { limit: 100 }, persona: 'owner' });
      const page = yield* decodeBody(ListAccessPeopleResponseSchema, listed.text);
      expect(page.items.map(({ principalId }) => principalId)).toContain(newcomer);

      // A retry after the commit meets a moved revision, and a live member is no candidate any more.
      const replay = yield* write('owner', 'admit-member', key, admitInto(newcomer, companyA, ownerRevision));
      expectStatus(replay, 409);
      const again = yield* write(
        'owner',
        'admit-member',
        'admit-newcomer-into-a-again',
        admitInto(newcomer, companyA, yield* revisionOf('owner')),
      );
      expectStatus(again, 403);
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
    }),
  );

const coreRefusals = (accessCase: AccessAdminCase) =>
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
      expect({ refused: [409, 422].includes(revived.status), text: revived.text }).toEqual({
        refused: true,
        text: expect.stringMatching(/people_membership_(?:ended|already_active)/u),
      });
      expect(yield* membershipsOf(accessCase, lapsed)).toEqual(before);
      expect(yield* tasksIn('lapsed', companyB)).toBe('DENIED');

      // The manager's delegation names admit-member and end-membership. No command can grant that
      // (the release publishes neither key), so the fixture wrote it by SQL; the gate admits the
      // manager in company A, and Core's permanent-authority rule is what refuses both writes.
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
    }),
  );

const endMembership = (accessCase: AccessAdminCase) =>
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
      const endedRows = yield* rowsOf<{
        readonly ended: boolean;
        readonly ended_by: string | null;
        readonly ended_reason: string | null;
        readonly scope_id: string;
        readonly status: string;
      }>(
        accessCase,
        `select scope_id, status, ended_by, ended_reason, ended_at is not null as ended
       from core.access_memberships where principal_id = '${leaver}' and kind = 'member'`,
      );
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

      // The sole owner cannot end their own tenant membership and leave the tenant unowned.
      const ownerBefore = yield* membershipsOf(accessCase, owner);
      const ownerEnd = yield* write('owner', 'end-membership', 'owner-ends-self', {
        expectedRevision: yield* revisionOf('owner'),
        principalId: owner,
        reason: LEAVER_REASON,
        scope: { kind: 'tenant' },
      });
      expect({ status: ownerEnd.status, text: ownerEnd.text }).toEqual({
        status: 409,
        text: expect.stringMatching(/ownership_transfer_required|people_granted_delegations_live/u),
      });
      expect(yield* membershipsOf(accessCase, owner)).toEqual(ownerBefore);
    }),
  );

const roleAssignment = (accessCase: AccessAdminCase) =>
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

const delegation = (accessCase: AccessAdminCase) =>
  Effect.scoped(
    Effect.gen(function* delegationCase() {
      const shell = yield* shellHttpFor(accessCase);
      const { company, companyA, idOf, revisionOf, tasksIn, write } = scenarioOf(accessCase, shell);
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
      const granted = yield* write(
        'companyAdmin',
        'delegate',
        'delegate-within',
        delegate(yield* revisionOf('companyAdmin'), SPINE_DECLARATION, idOf('member')),
      );
      expectStatus(granted, 200);
      expect(yield* delegations).toBe(delegationsBefore + 1);
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

const ownership = (accessCase: AccessAdminCase) =>
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
    }),
  );

it.layer(accessAdminTemplateLayer, { excludeTestServices: true, timeout: '180 seconds' })(
  'Lidé people writes through the production Shell API',
  (suite) => {
    suite.effect(
      'the owner admits a directory member into one company, and only then can assign there',
      () => withAccessAdminCase(admission),
      CASE_TIMEOUT,
    );

    suite.effect(
      'Core refuses an admission that would revive lapsed authority, and a delegate who may not admit or end',
      () => withAccessAdminCase(coreRefusals),
      CASE_TIMEOUT,
    );

    suite.effect(
      'ending a company membership closes what it carried at once, and re-admission starts clean',
      () => withAccessAdminCase(endMembership),
      CASE_TIMEOUT,
    );

    suite.effect(
      'role assignment needs a member, a reachable role and the current revisions, and revocation ends it',
      () => withAccessAdminCase(roleAssignment),
      CASE_TIMEOUT,
    );

    suite.effect(
      'a delegation is bounded by its grantor, works inside its envelope until revoked, and blocks ending its grantor',
      () => withAccessAdminCase(delegation),
      CASE_TIMEOUT,
    );

    suite.effect(
      'only the owner hands ownership on, and the successor then administers the tenant',
      () => withAccessAdminCase(ownership),
      CASE_TIMEOUT,
    );
  },
);
