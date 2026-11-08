import { createHash, randomUUID } from 'node:crypto';
import {
  ActionRuntime,
  companyManagedPrincipalsRead,
  ReadRuntime,
  replaceAgentOperatorsAction,
  ReplaceAgentOperatorsAuditEvidenceSchema,
  ReplaceAgentOperatorsPayloadSchema,
} from '@app/core-runtime';
import { NodeServices } from '@effect/platform-node';
import { and, desc, eq, sql } from 'drizzle-orm';
import { Console, Effect, Option, Schema } from 'effect';
import { AccessPeopleDirectory } from '@app/core-runtime/access/intent/people-directory';
import { TenantIntentLoader } from '@app/core-runtime/access/intent/tenant-intent-loader';
import { LegalEntityIdSchema, PrincipalIdSchema, TenantIdSchema } from '@app/core-runtime/access/ids';
import type { OperationalScope } from '@app/core-runtime/operations/context';
import { Command, Flag } from 'effect/cli';

import { auditEvents } from '../../packages/core-runtime/src/db/schema.ts';
import { AgentProfileOperatorLive, authenticateAgentProfileOperator } from './agent-profile-operator.mts';
import { AgentProfileReadDatabase, AgentProfileSetupInputSchema } from './agent-profile-setup.mts';
import {
  AgentProfileSetupError,
  requireAgentSetupAuthority,
  selectAgentOperatorCompany,
} from './agent-operator-session.mts';
import type { AgentOperatorSession } from './agent-operator-session.mts';
import { demoId } from './fixture-ids.mts';

const OperatorSetupInputSchema = Schema.Struct({
  agentPrincipalId: ReplaceAgentOperatorsPayloadSchema.fields.agentPrincipalId,
  legalEntityId: AgentProfileSetupInputSchema.fields.legalEntityId,
  operatorPrincipalIds: ReplaceAgentOperatorsPayloadSchema.fields.operatorPrincipalIds,
});
export type OperatorSetupInput = typeof OperatorSetupInputSchema.Type;
// Explicit setup requirements, not runtime authority or ownership inferred from key names.
const salesCompany = '71000000-0000-4000-8000-000000000020';
const crmCompany = '71000000-0000-4000-8000-000000000022';
const salesAdmin = demoId('core.principal', 'obchod');
const crmAdmin = demoId('core.principal', 'hanak-spravce');
export const demoAgentOperatorSetup: readonly OperatorSetupInput[] = [
  {
    agentPrincipalId: '35b748a0-d93a-520e-bd52-91433c8d15b8',
    legalEntityId: salesCompany,
    operatorPrincipalIds: [salesAdmin],
  },
  {
    agentPrincipalId: 'e931e0fd-adba-56fd-9e17-e5f3adb3efa0',
    legalEntityId: salesCompany,
    operatorPrincipalIds: [salesAdmin],
  },
  {
    agentPrincipalId: '3619acbd-a1bf-50f9-a8d5-d56df7096e0f',
    legalEntityId: salesCompany,
    operatorPrincipalIds: [salesAdmin],
  },
  {
    agentPrincipalId: '40052c4b-ea18-5c8c-ae8d-5d80548cec33',
    legalEntityId: crmCompany,
    operatorPrincipalIds: [crmAdmin],
  },
  {
    agentPrincipalId: 'c771c6f7-8d32-5ba7-af67-de4bd05eabc7',
    legalEntityId: crmCompany,
    operatorPrincipalIds: [crmAdmin],
  },
  {
    agentPrincipalId: '6300a06d-e532-5f52-8f66-5f1d4752a75e',
    legalEntityId: crmCompany,
    operatorPrincipalIds: [crmAdmin],
  },
];

const operatorIdempotencyInput = Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String, Schema.String]));
const hasEveryOperator = (
  activePeople: ReadonlySet<ReturnType<typeof PrincipalIdSchema.make>>,
  wanted: readonly string[],
) => wanted.every((id) => activePeople.has(PrincipalIdSchema.make(id)));

const sameSet = (left: readonly string[], right: readonly string[]) => {
  const ids = new Set(right);
  return left.length === ids.size && left.every((id) => ids.has(id));
};

/** Principal-global native command evidence, not an operator edge or an access grant. */
export const readAgentOperatorIntent = Effect.fn('AgentOperatorSetup.readIntent')(function* readIntent(
  tenantId: string,
  agentPrincipalId: string,
) {
  const { executor } = yield* AgentProfileReadDatabase;
  const [row] = yield* executor
    .select({ evidence: auditEvents.evidenceJson, legalEntityId: auditEvents.legalEntityId })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.tenantId, tenantId),
        eq(auditEvents.eventType, 'action.executed'),
        eq(auditEvents.outcome, 'succeeded'),
        eq(auditEvents.outcomeStage, 'execution'),
        sql`${auditEvents.evidenceJson}->>'actionKey' = ${replaceAgentOperatorsAction.descriptor.actionKey}`,
        sql`${auditEvents.evidenceJson}->>'agentPrincipalId' = ${agentPrincipalId}`,
      ),
    )
    .orderBy(
      sql`(${auditEvents.evidenceJson}->>'revision')::integer desc`,
      desc(auditEvents.occurredAt),
      desc(auditEvents.auditEventId),
    )
    .limit(1);
  if (row === undefined) {
    return Option.none<typeof ReplaceAgentOperatorsAuditEvidenceSchema.Type>();
  }
  const command = yield* Schema.decodeUnknownEffect(ReplaceAgentOperatorsAuditEvidenceSchema)(row.evidence);
  if (
    command.agentPrincipalId !== agentPrincipalId ||
    command.legalEntityId !== row.legalEntityId ||
    command.revision !== command.previousRevision + 1
  ) {
    return yield* new AgentProfileSetupError({ reason: 'The latest native operator command is invalid' });
  }
  return Option.some(command);
}, Effect.map(Option.getOrUndefined));

/** Canonical membership eligibility after the native administration gate, not a directory label grant. */
const readCompanyOperators = Effect.fn('AgentOperatorSetup.readCompanyOperators')(function* readCompanyOperators(
  scope: OperationalScope,
  principalIds: readonly string[],
) {
  if (scope.legalEntityId === undefined) {
    return yield* new AgentProfileSetupError({ reason: 'An exact company is required for operator setup' });
  }
  const directory = yield* AccessPeopleDirectory;
  const loader = yield* TenantIntentLoader;
  const ids = [...new Set(principalIds)].map((id) => PrincipalIdSchema.make(id));
  const people = yield* directory.people(scope, ids);
  const activePeople = new Set<ReturnType<typeof PrincipalIdSchema.make>>();
  for (const person of people) {
    if (person.kind !== 'human' || person.status !== 'active') {
      continue;
    }
    // loadScope refuses a missing, expired, suspended or revoked membership on either the company
    // or tenant path. The directory supplies names/kinds only; it does not admit a person.
    const membership = yield* loader.loadScope(scope, {
      holders: [{ _tag: 'Principal', principalId: person.principalId }],
      legalEntityId: LegalEntityIdSchema.make(scope.legalEntityId),
      tenantId: TenantIdSchema.make(scope.tenantId),
    });
    if (Option.isSome(membership)) {
      activePeople.add(person.principalId);
    }
  }
  return activePeople;
});

/**
 * Record human oversight through the native audited Action. This does not create agent consent, roles,
 * MCP credentials or authority. Those require Core's canonical connection lifecycle, never graph operators.
 */
export const runAgentOperatorSetup = Effect.fn('AgentOperatorSetup.run')(function* runOperatorSetup(
  operator: AgentOperatorSession,
  inputs: readonly OperatorSetupInput[],
  mode: 'dry-run' | 'apply' | 'verify',
) {
  const actions = yield* ActionRuntime;
  const decoded = yield* Schema.decodeUnknownEffect(Schema.Array(OperatorSetupInputSchema), {
    onExcessProperty: 'error',
  })(inputs);
  const identities = inputs.map((row) => `${row.legalEntityId}:${row.agentPrincipalId}`);
  if (new Set(identities).size !== identities.length) {
    return yield* new AgentProfileSetupError({ reason: 'Duplicate company/agent operator setup rows' });
  }
  const snapshots = yield* Effect.forEach(
    decoded,
    (input) =>
      Effect.gen(function* preflightOperators() {
        const principal = yield* selectAgentOperatorCompany(operator, input.legalEntityId);
        const scope = yield* requireAgentSetupAuthority(principal, replaceAgentOperatorsAction.descriptor.actionKey);
        // This existing governed Read requires the exact company. It verifies native agent/profile eligibility
        // without the retired company directory or a tenant-wide shortcut.
        const reads = yield* ReadRuntime;
        const targetInput = yield* Schema.decodeUnknownEffect(companyManagedPrincipalsRead.descriptor.inputSchema)({
          limit: 1,
          offset: 0,
          principalId: input.agentPrincipalId,
          scope: 'company-agent',
        });
        const target = yield* reads.runRead({
          input: targetInput,
          principal,
          registration: companyManagedPrincipalsRead,
          transport: { correlationId: randomUUID() },
        });
        if (
          !target.items.some(
            (agent) =>
              agent.principalId === input.agentPrincipalId &&
              agent.kind === 'agent' &&
              agent.principalStatus === 'active',
          )
        ) {
          return yield* new AgentProfileSetupError({
            reason: 'The target must be an active agent in this exact company',
          });
        }
        const command = yield* readAgentOperatorIntent(principal.tenantId, input.agentPrincipalId);
        const activePeople = yield* readCompanyOperators(scope, [
          ...input.operatorPrincipalIds,
          ...(command?.desiredOperatorPrincipalIds ?? []),
        ]);
        if (input.operatorPrincipalIds.some((id) => !activePeople.has(PrincipalIdSchema.make(id)))) {
          return yield* new AgentProfileSetupError({
            reason: 'Every operator needs active canonical company membership',
          });
        }
        return { ...input, activePeople, command };
      }),
    { concurrency: 1 },
  );
  const plans = yield* Effect.forEach(
    [...new Set(inputs.map((input) => input.agentPrincipalId))],
    (agentPrincipalId) =>
      Effect.gen(function* planOperators() {
        const candidates = snapshots.filter((snapshot) => snapshot.agentPrincipalId === agentPrincipalId);
        const initial = candidates.at(0);
        if (initial === undefined) {
          return yield* new AgentProfileSetupError({ reason: 'Missing operator preflight snapshot' });
        }
        const revision = initial.command?.revision ?? 0;
        const existing = initial.command?.desiredOperatorPrincipalIds ?? [];
        if (
          candidates.some(
            (row) =>
              (row.command?.revision ?? 0) !== revision ||
              !sameSet(row.command?.desiredOperatorPrincipalIds ?? [], existing),
          )
        ) {
          return yield* new AgentProfileSetupError({ reason: 'Agent operators changed during preflight; retry' });
        }
        // Existing native commands are retained. A seed never replaces human oversight with its smaller fixture.
        const wanted = [...new Set([...existing, ...candidates.flatMap((row) => row.operatorPrincipalIds)])].toSorted();
        const company = candidates.find((row) => hasEveryOperator(row.activePeople, wanted));
        if (company === undefined) {
          return yield* new AgentProfileSetupError({
            reason: 'No requested company can preserve every native operator',
          });
        }
        const payload = {
          agentPrincipalId,
          context: 'operators-edited' as const,
          expectedRevision: revision,
          operatorPrincipalIds: wanted,
          revokedConnections: 0,
        };
        const encoded = yield* Schema.encodeEffect(
          Schema.fromJsonString(replaceAgentOperatorsAction.descriptor.payloadSchema),
        )(payload);
        const keyInput = yield* Schema.encodeEffect(operatorIdempotencyInput)([
          operator.principal.tenantId,
          company.legalEntityId,
          encoded,
        ]);
        const idempotencyKey = createHash('sha256').update(keyInput).digest('hex');
        return { changed: !sameSet(existing, wanted), idempotencyKey, legalEntityId: company.legalEntityId, payload };
      }),
    { concurrency: 1 },
  );
  if (mode === 'verify' && plans.some((plan) => plan.changed)) {
    return yield* new AgentProfileSetupError({ reason: 'Explicit native operator intent has not been configured' });
  }
  let applied = 0;
  if (mode === 'apply') {
    for (const plan of plans) {
      if (!plan.changed) {
        continue;
      }
      const principal = yield* selectAgentOperatorCompany(operator, plan.legalEntityId);
      yield* actions
        .runAction({
          payload: plan.payload,
          principal,
          registration: replaceAgentOperatorsAction,
          transport: { correlationId: randomUUID(), idempotencyKey: plan.idempotencyKey },
        })
        .pipe(Effect.catchTag('ActionAlreadyCommitted', () => Effect.void));
      const confirmed = yield* readAgentOperatorIntent(principal.tenantId, plan.payload.agentPrincipalId);
      if (
        confirmed?.revision !== plan.payload.expectedRevision + 1 ||
        !sameSet(confirmed.desiredOperatorPrincipalIds, plan.payload.operatorPrincipalIds)
      ) {
        return yield* new AgentProfileSetupError({
          reason: 'The native operator command changed; retry with fresh intent',
        });
      }
      applied += 1;
    }
  }
  return {
    applied,
    authority: 'not-provisioned' as const,
    mode,
    pending: mode === 'apply' ? 0 : plans.filter((plan) => plan.changed).length,
  };
});
const command = Command.make(
  'setup-agent-operators',
  {
    mode: Flag.Literals('mode', ['dry-run', 'apply', 'verify']).pipe(Flag.withDefault('dry-run')),
  },
  ({ mode }) =>
    Effect.gen(function* setupOperators() {
      const operator = yield* Effect.acquireRelease(authenticateAgentProfileOperator, (session) =>
        session.close.pipe(Effect.ignore),
      );
      yield* Console.log(yield* runAgentOperatorSetup(operator, demoAgentOperatorSetup, mode));
    }).pipe(Effect.scoped),
).pipe(Command.provide(AgentProfileOperatorLive));
if (import.meta.main) {
  await Effect.runPromise(Command.run(command, { version: '1.0.0' }).pipe(Effect.provide(NodeServices.layer)));
}
