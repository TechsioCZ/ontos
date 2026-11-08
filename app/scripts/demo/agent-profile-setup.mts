import { createHash, randomUUID } from 'node:crypto';

import { and, desc, eq, sql } from 'drizzle-orm';
import { Context, Effect, FileSystem, Option, Schema } from 'effect';

import {
  ActionRuntime,
  configureAgentAction,
  ConfigureAgentAuditEvidenceSchema,
  ConfigureAgentPayloadSchema,
} from '@app/core-runtime';
import type { CoreDatabase } from '@app/core-runtime/db/client';
import { auditEvents, principalCompanyMemberships, principals } from '../../packages/core-runtime/src/db/schema.ts';
import {
  AgentProfileSetupError,
  requireAgentSetupAuthority,
  selectAgentOperatorCompany,
} from './agent-operator-session.mts';
import type { AgentOperatorSession } from './agent-operator-session.mts';

export { AgentProfileSetupError } from './agent-operator-session.mts';

const profileIdempotencyInput = Schema.fromJsonString(
  Schema.Tuple([Schema.String, Schema.String, Schema.String, Schema.String]),
);

const configureOperation = 'configure-agent' as const;
const createOperation = 'create-agent' as const;
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

export const readProfile = Effect.fn('AgentProfileSetup.readProfile')(function* readProfile(input: {
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
    .orderBy(
      sql`(${auditEvents.evidenceJson}->>'revision')::integer desc`,
      desc(auditEvents.occurredAt),
      desc(auditEvents.auditEventId),
    )
    .limit(1);
  if (row === undefined) {
    return Option.none<typeof ConfigureAgentAuditEvidenceSchema.Type>();
  }
  const evidence = yield* Schema.decodeUnknownEffect(ConfigureAgentAuditEvidenceSchema)(row.evidence);
  if (evidence.targetPrincipalId !== input.principalId || evidence.legalEntityId !== input.legalEntityId) {
    return yield* fail('Native profile evidence belongs to another principal or company');
  }
  return Option.some(evidence);
}, Effect.map(Option.getOrUndefined));
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
        .select({ displayName: principals.displayName, kind: principals.kind })
        .from(principals)
        .where(and(eq(principals.tenantId, row.tenantId), eq(principals.principalId, row.principalId)))
        .limit(1);
      const current = yield* readProfile(row);
      if (target !== undefined && target.kind !== 'agent') {
        return yield* fail('Explicit agent setup cannot adopt a non-agent principal');
      }
      return {
        ...row,
        displayName: target?.displayName ?? row.displayName,
        operation:
          target === undefined || current?.operation === createOperation ? createOperation : configureOperation,
      };
    }),
    { concurrency: 1 },
  );
});

/**
 * Identity/profile metadata only. Modules and writePolicy remain audited display information, never grants.
 * Role assignments, consent and connection authority belong to Core's access lifecycle, not this Action.
 */
export const runAgentProfileSetup = Effect.fn('AgentProfileSetup.run')(function* runAgentProfileSetup(
  operator: AgentOperatorSession,
  inputs: readonly AgentProfileSetupInput[],
  mode: AgentProfileSetupMode,
  sourceFingerprint: string,
) {
  if (!/^[a-f0-9]{64}$/u.test(sourceFingerprint)) {
    return yield* fail('An explicit source SHA-256 fingerprint is required');
  }
  const identities = inputs.map((input) => `${input.tenantId}:${input.legalEntityId}:${input.principalId}`);
  if (new Set(identities).size !== inputs.length) {
    return yield* fail('Agent-profile setup contains duplicate scope/principal rows');
  }
  const runtime = yield* ActionRuntime;
  const { executor } = yield* AgentProfileReadDatabase;
  // Prepare every company and complete payload before any Action. A denied row blocks the whole batch.
  const prepared = yield* Effect.forEach(
    inputs,
    Effect.fnUntraced(function* prepare(raw) {
      const input = yield* Schema.decodeUnknownEffect(AgentProfileSetupInputSchema, {
        onExcessProperty: 'error',
      })(raw);
      if (input.tenantId !== operator.principal.tenantId) {
        return yield* fail('The authenticated operator tenant does not match the setup input');
      }
      const principal = yield* selectAgentOperatorCompany(operator, input.legalEntityId);
      yield* requireAgentSetupAuthority(principal, configureAgentAction.descriptor.actionKey);
      const [target] = yield* executor
        .select({ kind: principals.kind, status: principals.status })
        .from(principals)
        .where(and(eq(principals.tenantId, input.tenantId), eq(principals.principalId, input.principalId)))
        .limit(1);
      const current = yield* readProfile(input);
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
        if (
          target?.kind !== 'agent' ||
          target.status === 'archived' ||
          membership?.status !== 'active' ||
          membership.affiliation !== null
        ) {
          return yield* fail(`Agent ${input.principalId} needs its exact active company membership before replay`);
        }
      } else if (
        target !== undefined &&
        (target.kind !== 'agent' || target.status === 'archived' || !profileMatches(current, input))
      ) {
        return yield* fail(`Agent ${input.principalId} already exists; explicit creation cannot adopt it`);
      }
      if (current !== undefined && !profileMatches(current, input)) {
        return yield* fail('The current native profile differs; do not overwrite newer administrator evidence');
      }
      const payload = {
        description: input.description,
        displayName: input.displayName,
        modules: input.modules,
        operation: input.operation,
        ownerPrincipalId: input.ownerPrincipalId,
        principalId: input.principalId,
        writePolicy: input.writePolicy,
      };
      const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(ConfigureAgentPayloadSchema))(payload);
      const keyInput = yield* Schema.encodeEffect(profileIdempotencyInput)([
        sourceFingerprint,
        input.tenantId,
        input.legalEntityId,
        encoded,
      ]);
      const idempotencyKey = `agent-profile:${createHash('sha256').update(keyInput).digest('hex')}`;
      return { idempotencyKey, input, matches: profileMatches(current, input), payload };
    }),
    { concurrency: 1 },
  );
  if (mode === 'verify' && prepared.some((row) => !row.matches)) {
    return yield* fail('Native audited profiles differ from the reviewed input');
  }
  let applied = 0;
  if (mode === 'apply') {
    for (const row of prepared.filter((candidate) => !candidate.matches)) {
      // Selection mutates one session. Re-select at execution, never reuse a stale selected principal.
      const principal = yield* selectAgentOperatorCompany(operator, row.input.legalEntityId);
      const latest = yield* readProfile(row.input);
      if (latest !== undefined) {
        if (!profileMatches(latest, row.input)) {
          return yield* fail('The native profile changed during preparation; preserve administrator evidence');
        }
        // Another exact invocation may have committed while this batch was being prepared.
        continue;
      }
      yield* runtime
        .runAction({
          payload: row.payload,
          principal,
          registration: configureAgentAction,
          transport: { correlationId: randomUUID(), idempotencyKey: row.idempotencyKey },
        })
        .pipe(Effect.catchTag('ActionAlreadyCommitted', () => Effect.void));
      if (!profileMatches(yield* readProfile(row.input), row.input)) {
        return yield* fail('The profile changed after this replay committed; do not overwrite administrator evidence');
      }
      applied += 1;
    }
  }
  return {
    applied,
    // This checkpoint must not be mistaken for provisioned MCP access or consent.
    authority: 'not-provisioned' as const,
    changes: prepared
      .filter((row) => !row.matches)
      .map(({ input }) => ({
        legalEntityId: input.legalEntityId,
        operation: input.operation,
        principalId: input.principalId,
        tenantId: input.tenantId,
      })),
    mode,
    rows: prepared.length,
    verified: mode !== 'dry-run' || prepared.every((row) => row.matches),
  };
});
