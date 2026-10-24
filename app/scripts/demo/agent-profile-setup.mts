import { createHash, randomUUID } from 'node:crypto';

import { v1 } from '@authzed/authzed-node';
import { and, desc, eq, sql } from 'drizzle-orm';
import { Context, Effect, FileSystem, Schema } from 'effect';

import { ActionPermission } from '../../packages/core-runtime/src/permissions/service.ts';
import { ActionRuntime } from '../../packages/core-runtime/src/actions/runtime.ts';
import type { TrustedPrincipalContext } from '../../packages/core-runtime/src/actions/principal-context.ts';
import type { CoreDatabase } from '../../packages/core-runtime/src/db/client.ts';
import {
  auditEvents,
  principalCompanyMemberships,
  principals,
  tenantModuleStates,
} from '../../packages/core-runtime/src/db/schema.ts';
import {
  configureAgentAction,
  ConfigureAgentAuditEvidenceSchema,
  ConfigureAgentPayloadSchema,
} from '../../packages/core-runtime/src/modules/actions/configure-agent.action.ts';
import { openDemoAccountGrants } from '../../packages/core-runtime/src/install/demo-account-administration.ts';
import {
  currentAgentProfileRelationships,
  readCurrentAgentNamedPermissions,
} from '../../packages/core-runtime/src/permissions/agent-profile-lifecycle.ts';
import { planAgentScopedRoleReplacement } from '../../packages/core-runtime/src/install/agent-scoped-role-policy.ts';
import { loadSpiceDbConfig } from '../../packages/core-runtime/src/permissions/config.ts';
import { openSpiceDbRpc } from '../../packages/core-runtime/src/permissions/spicedb-transaction-guard.ts';
import { ShellInstalledModuleCatalog } from '../../apps/shell-super-app/api/modules/installed-module-catalog.ts';

const configureOperation = 'configure-agent' as const;
const createOperation = 'create-agent' as const;
export const AgentProfileSetupError = Schema.TaggedError<unknown>()('AgentProfileSetupError', {
  reason: Schema.String,
});
const fail = (reason: string) => new AgentProfileSetupError({ reason });
export class AgentProfileReadDatabase extends Context.Service<
  AgentProfileReadDatabase,
  { readonly executor: Pick<CoreDatabase['Service']['executor'], 'select'> }
>()('AgentProfileReadDatabase') {}

const IdentifierSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('AgentSetupIdentifier'),
  Schema.decodeTo(Schema.String),
);
export const AgentProfileSetupInputSchema = Schema.Struct({
  ...ConfigureAgentPayloadSchema.fields,
  legalEntityId: IdentifierSchema,
  tenantId: IdentifierSchema,
});
export type AgentProfileSetupInput = typeof AgentProfileSetupInputSchema.Type;
export const ReviewedAgentProfilesSchema = Schema.Struct({
  profiles: Schema.Array(
    Schema.Struct({
      description: ConfigureAgentPayloadSchema.fields.description,
      legalEntityId: IdentifierSchema,
      modules: ConfigureAgentPayloadSchema.fields.modules,
      ownerPrincipalId: ConfigureAgentPayloadSchema.fields.ownerPrincipalId,
      principalId: IdentifierSchema,
      tenantId: IdentifierSchema,
      writePolicy: ConfigureAgentPayloadSchema.fields.writePolicy,
    }),
  ).check(Schema.isMinLength(1)),
  schemaVersion: Schema.Literal(2),
});
export const AgentProfileSetupModeSchema = Schema.Literals(['dry-run', 'apply', 'verify']);
export type AgentProfileSetupMode = typeof AgentProfileSetupModeSchema.Type;

export const readReviewedAgentProfiles = Effect.fn('AgentProfileSetup.readReviewed')(function* readReviewed(
  path: string,
  expectedSha256: string,
) {
  if (!/^[a-f0-9]{64}$/u.test(expectedSha256)) {
    return yield* fail('An explicit reviewed agent-profile SHA-256 fingerprint is required');
  }
  const fs = yield* FileSystem.FileSystem;
  const bytes = yield* fs.readFile(path);
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expectedSha256) {
    return yield* fail('Reviewed agent-profile file SHA-256 mismatch; nothing was applied');
  }
  const document = yield* Schema.decodeEffect(Schema.fromJsonString(ReviewedAgentProfilesSchema), {
    onExcessProperty: 'error',
  })(Buffer.from(bytes).toString('utf-8'));
  const identities = document.profiles.map((row) => `${row.tenantId}:${row.legalEntityId}:${row.principalId}`);
  if (new Set(identities).size !== document.profiles.length) {
    return yield* fail('Reviewed agent-profile input contains duplicate scope/principal rows');
  }
  return document;
});

const readProfile = Effect.fn('AgentProfileSetup.readProfile')(function* readProfile(input: {
  readonly legalEntityId: string;
  readonly principalId: string;
  readonly tenantId: string;
}) {
  const { executor } = yield* AgentProfileReadDatabase;
  const [row] = yield* executor
    .select({ evidence: auditEvents.evidenceJson })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.tenantId, input.tenantId),
        eq(auditEvents.legalEntityId, input.legalEntityId),
        eq(auditEvents.eventType, 'action.executed'),
        eq(auditEvents.outcome, 'succeeded'),
        sql`${auditEvents.evidenceJson}->>'actionKey' = 'core.identity.configure-agent'`,
        sql`${auditEvents.evidenceJson}->>'targetPrincipalId' = ${input.principalId}`,
      ),
    )
    .orderBy(sql`(${auditEvents.evidenceJson}->>'revision')::integer desc`, desc(auditEvents.occurredAt))
    .limit(1);
  return row === undefined
    ? undefined
    : yield* Schema.decodeUnknownEffect(ConfigureAgentAuditEvidenceSchema)(row.evidence);
});
const profileMatches = (
  profile: typeof ConfigureAgentAuditEvidenceSchema.Type | undefined,
  input: AgentProfileSetupInput,
) =>
  profile !== undefined &&
  profile.description === input.description &&
  profile.displayName === input.displayName &&
  profile.ownerPrincipalId === input.ownerPrincipalId &&
  profile.writePolicy === input.writePolicy &&
  profile.modules.length === input.modules.length &&
  profile.modules.every(
    (module, index) =>
      module.access === input.modules[index]?.access && module.moduleId === input.modules[index]?.moduleId,
  );

/** Turns reviewed data into configure-only payloads, preserving names/description/owners rather than inventing them. */
export const reviewedProfileInputs = Effect.fn('AgentProfileSetup.reviewedInputs')(function* reviewedInputs(
  document: typeof ReviewedAgentProfilesSchema.Type,
) {
  const { executor } = yield* AgentProfileReadDatabase;
  return yield* Effect.forEach(
    document.profiles,
    Effect.fnUntraced(function* reviewedInput(row) {
      const [principal] = yield* executor
        .select({ displayName: principals.displayName })
        .from(principals)
        .where(
          and(
            eq(principals.tenantId, row.tenantId),
            eq(principals.principalId, row.principalId),
            eq(principals.kind, 'agent'),
          ),
        )
        .limit(1);
      if (principal === undefined) {
        return yield* fail(`Reviewed agent ${row.principalId} does not exist in the exact tenant`);
      }
      const current = yield* readProfile(row);
      const input = {
        ...row,
        displayName: principal.displayName,
        operation: configureOperation,
      };
      if (current !== undefined && !profileMatches(current, input)) {
        return yield* fail(
          'A current native profile differs from the reviewed input; do not overwrite administrator evidence',
        );
      }
      return input;
    }),
    { concurrency: 1 },
  );
});

/** Explicit setup data chooses creation only for a missing principal; existing principals still need native company membership. */
export const explicitProfileInputs = Effect.fn('AgentProfileSetup.explicitInputs')(function* explicitInputs(
  rows: readonly Omit<AgentProfileSetupInput, 'operation'>[],
) {
  const { executor } = yield* AgentProfileReadDatabase;
  return yield* Effect.forEach(
    rows,
    Effect.fnUntraced(function* input(row) {
      const [target] = yield* executor
        .select({ principalId: principals.principalId })
        .from(principals)
        .where(and(eq(principals.tenantId, row.tenantId), eq(principals.principalId, row.principalId)))
        .limit(1);
      const current = yield* readProfile(row);
      return {
        ...row,
        operation:
          target === undefined || current?.operation === createOperation ? createOperation : configureOperation,
      };
    }),
    { concurrency: 1 },
  );
});

/** All writes are the native audited Action, followed by the native scoped-policy materializer. */
export const runAgentProfileSetup = Effect.fn('AgentProfileSetup.run')(function* runAgentProfileSetup(
  actor: TrustedPrincipalContext,
  inputs: readonly AgentProfileSetupInput[],
  mode: AgentProfileSetupMode,
  sourceFingerprint: string,
) {
  const runtime = yield* ActionRuntime;
  const permission = yield* ActionPermission;
  const { executor } = yield* AgentProfileReadDatabase;
  const grants = yield* openDemoAccountGrants;
  const configuration = yield* loadSpiceDbConfig();
  const rpc = yield* Effect.acquireRelease(
    Effect.sync(() => openSpiceDbRpc(configuration, 10_000)),
    (client) => Effect.sync(() => client.close()),
  );
  // Prepare every row before any Action: a bad membership or unmigrated global Action blocks the whole replay.
  const prepared = yield* Effect.forEach(
    inputs,
    Effect.fnUntraced(function* prepare(input) {
      if (input.tenantId !== actor.tenantId) {
        return yield* fail('The authenticated operator tenant does not match the setup input');
      }
      const decision = yield* permission.checkActionPermission({
        actionKey: configureAgentAction.descriptor.actionKey,
        correlationId: randomUUID(),
        legalEntityId: input.legalEntityId,
        principalId: actor.principalId,
        tenantId: input.tenantId,
      });
      if (decision !== 'allowed') {
        return yield* fail('The authenticated operator cannot configure agents in every requested company');
      }
      const [target] = yield* executor
        .select({ kind: principals.kind })
        .from(principals)
        .where(and(eq(principals.tenantId, input.tenantId), eq(principals.principalId, input.principalId)))
        .limit(1);
      if (input.operation === configureOperation) {
        const [membership] = yield* executor
          .select({ affiliation: principalCompanyMemberships.affiliation, status: principalCompanyMemberships.status })
          .from(principalCompanyMemberships)
          .where(
            and(
              eq(principalCompanyMemberships.tenantId, input.tenantId),
              eq(principalCompanyMemberships.legalEntityId, input.legalEntityId),
              eq(principalCompanyMemberships.principalId, input.principalId),
            ),
          )
          .limit(1);
        if (target?.kind !== 'agent' || membership?.status !== 'active' || membership.affiliation !== null) {
          return yield* fail(
            `Agent ${input.principalId} needs its exact active company membership before profile replay`,
          );
        }
      } else if (target !== undefined && !profileMatches(yield* readProfile(input), input)) {
        return yield* fail(`Agent ${input.principalId} already exists; explicit creation cannot adopt it`);
      }
      const principalRelationships = yield* grants.relationshipsOf(input.principalId);
      if (principalRelationships.some((relationship) => relationship.resourceType === 'action')) {
        return yield* fail(
          'Legacy global Action grants remain; complete the reviewed cutover before agent-profile setup',
        );
      }
      const catalog = yield* (yield* ShellInstalledModuleCatalog).load;
      const installedModules = yield* executor
        .select({ moduleKey: tenantModuleStates.moduleKey })
        .from(tenantModuleStates)
        .where(and(eq(tenantModuleStates.tenantId, input.tenantId), eq(tenantModuleStates.state, 'active')));
      const desired = currentAgentProfileRelationships({
        catalog,
        company: { active: true, legalEntityId: input.legalEntityId, profile: input },
        installedModuleKeys: new Set(installedModules.map(({ moduleKey }) => moduleKey)),
        namedPermissions: yield* readCurrentAgentNamedPermissions(rpc, input),
        principalId: input.principalId,
        tenantId: input.tenantId,
      });
      const plan = yield* planAgentScopedRoleReplacement(rpc, {
        ...input,
        currentPrincipalRelationships: principalRelationships.map((relationship) =>
          v1.Relationship.create({
            relation: relationship.relation,
            resource: { objectId: relationship.resourceId, objectType: relationship.resourceType },
            subject: { object: { objectId: input.principalId, objectType: 'principal' } },
          }),
        ),
        desired,
      });
      const graphMatches = plan.updates.length === 0;
      return { desired, graphMatches, input, profileMatches: profileMatches(yield* readProfile(input), input) };
    }),
    { concurrency: 1 },
  );
  if (mode === 'verify') {
    if (prepared.some((row) => !row.graphMatches || !row.profileMatches)) {
      return yield* fail('Native audited profiles or exact scoped role policies differ from the reviewed input');
    }
    return { applied: 0, mode, rows: prepared.length, verified: true };
  }
  if (mode === 'dry-run') {
    return {
      applied: 0,
      changes: prepared
        .filter((row) => !row.graphMatches || !row.profileMatches)
        .map(({ input }) => ({
          legalEntityId: input.legalEntityId,
          operation: input.operation,
          principalId: input.principalId,
          tenantId: input.tenantId,
        })),
      mode,
      rows: prepared.length,
      verified: prepared.every((row) => row.graphMatches && row.profileMatches),
    };
  }
  let applied = 0;
  for (const row of prepared) {
    if (row.graphMatches && row.profileMatches) {
      continue;
    }
    const { input } = row;
    const payload = {
      description: input.description,
      displayName: input.displayName,
      modules: input.modules,
      operation: input.operation,
      ownerPrincipalId: input.ownerPrincipalId,
      principalId: input.principalId,
      writePolicy: input.writePolicy,
    };
    const replayIdentity = `${sourceFingerprint}:${input.tenantId}:${input.legalEntityId}:${input.principalId}`;
    const idempotencyKey = `agent-profile:${createHash('sha256').update(replayIdentity).digest('hex')}`;
    yield* runtime
      .runAction({
        payload,
        principal: { ...actor, legalEntityId: input.legalEntityId },
        registration: configureAgentAction,
        transport: { correlationId: randomUUID(), idempotencyKey },
      })
      .pipe(Effect.catchTag('ActionAlreadyCommitted', () => Effect.void));
    // A prior idempotent commit must still be current; never restore an older reviewed profile over a later admin edit.
    if (!profileMatches(yield* readProfile(input), input)) {
      return yield* fail(
        'The native profile changed after this replay committed; do not overwrite newer administrator evidence',
      );
    }
    yield* grants.replaceAgentGrants({
      desired: row.desired,
      legalEntityId: input.legalEntityId,
      principalId: input.principalId,
      tenantId: input.tenantId,
    });
    applied += 1;
  }
  return { applied, mode, rows: prepared.length, verified: true };
});
