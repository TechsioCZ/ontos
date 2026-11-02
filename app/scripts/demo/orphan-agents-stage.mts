#!/usr/bin/env node
/** Exact-two stage orphan archival. SELECT-only evidence; existing tenant-scoped non-human status Action only. */
import { createHash, randomUUID } from 'node:crypto';
import { NodeServices } from '@effect/platform-node';
import { v1 } from '@authzed/authzed-node';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { Config, Console, Effect, FileSystem, Option, Schema } from 'effect';
import { Command, Flag } from 'effect/cli';
import { ActionRuntime } from '../../packages/core-runtime/src/actions/runtime.ts';
import {
  agentProposals,
  auditEvents,
  oauthConnectionGrants,
  principalAuthBindings,
  principalCompanyMemberships,
  principals,
} from '../../packages/core-runtime/src/db/schema.ts';
import { openDemoAccountGrants } from '../../packages/core-runtime/src/install/demo-account-administration.ts';
import { changePrincipalStatusAction } from '../../packages/core-runtime/src/modules/actions/change-principal-status.action.ts';
import { fullyConsistent } from '../../packages/core-runtime/src/permissions/client.ts';
import { loadSpiceDbConfig } from '../../packages/core-runtime/src/permissions/config.ts';
import { openSpiceDbRpc } from '../../packages/core-runtime/src/permissions/spicedb-transaction-guard.ts';
import { demoAgentProfileSetup } from '../../apps/shell-super-app/api/auth/demo-seed/agent-profiles.ts';
import { AgentProfileReadDatabase } from './agent-profile-setup.mts';
import { AgentProfileOperatorLive, authenticateAgentProfileOperator } from './agent-profile-operator.mts';
import { refuseDeadAfterWrite } from './agent-policies-stage.mts';
import { demoTenantId } from './fixture-ids.mts';
import { DemoSeedError } from './seed-client.mts';

const targets = ['24c3628e-d340-46d1-a87b-5d8f98d0fa87', '301134e3-1bb2-4430-a865-01599ef12df8'];
const IdentifierSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('OrphanArchiveIdentifier'),
  Schema.decodeTo(Schema.String),
);
const RowSchema = Schema.Struct({
  activeBindings: Schema.Int,
  activeOAuthGrants: Schema.Int,
  companyMemberships: Schema.Int,
  directAuthority: Schema.Int,
  displayName: Schema.String,
  historyIds: Schema.Array(IdentifierSchema),
  kind: Schema.String,
  openProposals: Schema.Int,
  principalId: IdentifierSchema,
  scopedRoles: Schema.Int,
  sourceDeclared: Schema.Boolean,
  status: Schema.String,
});
const PlanSchema = Schema.Struct({
  rows: Schema.Array(RowSchema),
  sourceDigest: Schema.String,
  tenantId: Schema.Literal(demoTenantId),
  visibilityEvidenceSha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
});
const failure = (reason: string) => new DemoSeedError({ reason });
type Row = typeof RowSchema.Type;
export const orphanArchivalSafe = (row: Row): boolean =>
  targets.includes(row.principalId) &&
  row.displayName === 'Asistent provozu' &&
  row.kind === 'agent' &&
  ['active', 'archived'].includes(row.status) &&
  !row.sourceDeclared &&
  row.companyMemberships === 0 &&
  row.activeBindings === 0 &&
  row.activeOAuthGrants === 0 &&
  row.directAuthority === 0 &&
  row.scopedRoles === 0 &&
  row.openProposals === 0;
const fingerprint = (plan: typeof PlanSchema.Type) =>
  Schema.encodeEffect(Schema.fromJsonString(PlanSchema))(plan).pipe(
    Effect.map((text) => createHash('sha256').update(text).digest('hex')),
  );
const inspectRows = Effect.gen(function* inspectExactOrphans() {
  const { executor } = yield* AgentProfileReadDatabase;
  const grants = yield* openDemoAccountGrants;
  const configuration = yield* loadSpiceDbConfig();
  const rpc = yield* Effect.acquireRelease(
    Effect.sync(() => openSpiceDbRpc(configuration, 10_000)),
    (channel) => Effect.sync(() => channel.close()),
  );
  const rows: Row[] = [];
  for (const principalId of targets) {
    const scoped = <
      T extends { readonly principalId: typeof principals.principalId; readonly tenantId: typeof principals.tenantId },
    >(
      table: T,
    ) => and(eq(table.tenantId, demoTenantId), eq(table.principalId, principalId));
    const [target] = yield* executor.select().from(principals).where(scoped(principals));
    if (target === undefined) {
      return yield* failure('A reviewed orphan principal is missing; no substitutes or creation allowed');
    }
    const companies = yield* executor
      .select({ id: principalCompanyMemberships.legalEntityId })
      .from(principalCompanyMemberships)
      .where(
        and(
          eq(principalCompanyMemberships.tenantId, demoTenantId),
          eq(principalCompanyMemberships.principalId, principalId),
        ),
      );
    const bindings = yield* executor
      .select({ id: principalAuthBindings.principalAuthBindingId })
      .from(principalAuthBindings)
      .where(
        and(
          eq(principalAuthBindings.tenantId, demoTenantId),
          eq(principalAuthBindings.principalId, principalId),
          inArray(principalAuthBindings.status, ['active', 'pending']),
        ),
      );
    const oauth = yield* executor
      .select({ id: oauthConnectionGrants.grantId })
      .from(oauthConnectionGrants)
      .where(
        and(
          eq(oauthConnectionGrants.tenantId, demoTenantId),
          eq(oauthConnectionGrants.actingPrincipalId, principalId),
          inArray(oauthConnectionGrants.status, ['active', 'draft']),
        ),
      );
    const proposals = yield* executor
      .select({ id: agentProposals.proposalId })
      .from(agentProposals)
      .where(
        and(
          eq(agentProposals.tenantId, demoTenantId),
          eq(agentProposals.agentPrincipalId, principalId),
          inArray(agentProposals.status, ['pending', 'applied', 'revert_failed']),
        ),
      );
    const history = yield* executor
      .select({ id: auditEvents.auditEventId })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.tenantId, demoTenantId),
          sql`${auditEvents.evidenceJson}->>'targetPrincipalId' = ${principalId}`,
        ),
      )
      .orderBy(auditEvents.auditEventId);
    const direct = yield* grants.relationshipsOf(principalId);
    const roles = yield* rpc.readRelationships(
      v1.ReadRelationshipsRequest.create({
        consistency: fullyConsistent,
        relationshipFilter: {
          optionalSubjectFilter: { optionalSubjectId: principalId, subjectType: 'principal' },
          resourceType: 'scoped_role',
        },
      }),
    );
    rows.push({
      activeBindings: bindings.length,
      activeOAuthGrants: oauth.length,
      companyMemberships: companies.length,
      directAuthority: direct.filter(
        (edge) =>
          !(
            edge.resourceType === 'tenant' &&
            edge.resourceId === demoTenantId &&
            ['member', 'company_member'].includes(edge.relation)
          ),
      ).length,
      displayName: target.displayName,
      historyIds: history.map((entry) => entry.id),
      kind: target.kind,
      openProposals: proposals.length,
      principalId,
      scopedRoles: roles.length,
      sourceDeclared: demoAgentProfileSetup.some((entry) => entry.principalId === principalId),
      status: target.status,
    });
  }
  return rows;
}).pipe(Effect.scoped);
const run = (mode: 'plan' | 'apply' | 'verify', path: string, visibility: string, reviewed: Option.Option<string>) =>
  Effect.gen(function* archiveReviewedOrphans() {
    yield* Config.schema(Schema.Literal('stage'), 'ULTRAMODERN_DEPLOYMENT_ENVIRONMENT');
    yield* Config.schema(Schema.Literal('https://ontos-stage.web-revolution.cz'), 'ONTOS_PUBLIC_ORIGIN');
    const fs = yield* FileSystem.FileSystem;
    const operator = yield* Effect.acquireRelease(authenticateAgentProfileOperator, (session) =>
      session.close.pipe(Effect.ignore),
    );
    if (operator.principal.tenantId !== demoTenantId) {
      return yield* failure('Wrong authenticated tenant');
    }
    const sourceDigest = createHash('sha256')
      .update(yield* fs.readFileString(new URL('orphan-agents-stage.mts', import.meta.url).pathname))
      .digest('hex');
    const current = yield* Schema.decodeUnknownEffect(PlanSchema)({
      rows: yield* inspectRows,
      sourceDigest,
      tenantId: demoTenantId,
      visibilityEvidenceSha256: visibility,
    });
    if (mode === 'plan') {
      yield* fs.writeFileString(path, yield* Schema.encodeEffect(Schema.fromJsonString(PlanSchema))(current), {
        flag: 'wx',
        mode: 0o600,
      });
      return yield* Console.log({
        fingerprint: yield* fingerprint(current),
        mode,
        rows: current.rows,
        safe: current.rows.every(orphanArchivalSafe),
      });
    }
    const saved = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PlanSchema))(yield* fs.readFileString(path));
    if (
      Option.isNone(reviewed) ||
      reviewed.value !== (yield* fingerprint(saved)) ||
      saved.sourceDigest !== sourceDigest ||
      saved.visibilityEvidenceSha256 !== visibility ||
      !saved.rows.every(orphanArchivalSafe)
    ) {
      return yield* failure('Exact safe reviewed orphan plan/fingerprint/visibility evidence required');
    }
    if (mode === 'apply') {
      if ((yield* fingerprint(current)) !== reviewed.value) {
        return yield* failure('Orphan safety evidence changed; no write');
      }
      const runtime = yield* ActionRuntime;
      for (const row of saved.rows) {
        const live = (yield* inspectRows).find((entry) => entry.principalId === row.principalId);
        if (live === undefined || !orphanArchivalSafe(live)) {
          return yield* failure('Fresh orphan preconditions fail; stop');
        }
        if (live.status === 'archived') {
          continue;
        }
        const payload = yield* Schema.decodeUnknownEffect(changePrincipalStatusAction.descriptor.payloadSchema)({
          expectedStatus: 'active',
          newStatus: 'archived',
          principalId: row.principalId,
          reason:
            'Archivace viditelné nepřiřazené duplicitní ukázkové identity; bez přístupů a otevřených návrhů. Historie zachována.',
        });
        yield* runtime
          .runAction({
            payload,
            principal: operator.principal,
            registration: changePrincipalStatusAction,
            transport: {
              correlationId: randomUUID(),
              idempotencyKey: `orphan-archive:${reviewed.value}:${row.principalId}`,
            },
          })
          .pipe(Effect.catchTag('ActionAlreadyCommitted', () => Effect.void));
        yield* refuseDeadAfterWrite;
      }
    }
    const after = yield* inspectRows;
    for (const row of after) {
      const before = saved.rows.find((entry) => entry.principalId === row.principalId);
      if (
        !orphanArchivalSafe(row) ||
        row.status !== 'archived' ||
        before === undefined ||
        before.historyIds.some((id) => !row.historyIds.includes(id))
      ) {
        return yield* failure('Archival or unchanged safety/history not verified; stop');
      }
    }
    return yield* Console.log({ historyPreserved: true, mode, rows: after, safe: true });
  }).pipe(Effect.scoped);
const command = Command.make(
  'orphan-agents-stage',
  {
    mode: Flag.Literals('mode', ['plan', 'apply', 'verify']),
    plan: Flag.String('plan'),
    reviewed: Flag.String('reviewed-plan-sha256').pipe(Flag.optional),
    visibility: Flag.String('visibility-sha256'),
  },
  ({ mode, plan, reviewed, visibility }) => run(mode, plan, visibility, reviewed),
).pipe(Command.provide(AgentProfileOperatorLive));
if (import.meta.main) {
  await Effect.runPromise(Command.run(command, { version: '1.0.0' }).pipe(Effect.provide(NodeServices.layer)));
}
