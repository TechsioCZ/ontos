import { eq } from 'drizzle-orm';
import { Effect, Schema } from 'effect';

import { principals } from '../db/schema.ts';
import type { ScopedTransactionExecutor } from '../db/scoped-transaction.ts';
import { defineSystemModuleEntrypoint } from '../modules/module-entrypoint.ts';
import type { ReadLoadContext } from '../reads/context.ts';
import { defineRead } from '../reads/definition.ts';
import { AgentActivityActorsInputSchema, AgentActivityActorsResultSchema } from './agent-activity-contract.ts';
import { agentActivityUnavailable } from './agent-activity-unavailable.ts';

/** The old activity name map is tenant-wide; only labels/IDs, never bindings, roles or profile authority. */
export const activityActorsFromTransaction = (transaction: ScopedTransactionExecutor) => ({
  load: Effect.fn('AgentActivityActors.load')(function* load() {
    const rows = yield* transaction
      .select({
        displayName: principals.displayName,
        kind: principals.kind,
        principalId: principals.principalId,
      })
      .from(principals)
      .where(eq(principals.tenantId, transaction.scope.tenantId))
      .pipe(Effect.mapError(agentActivityUnavailable));
    return yield* Schema.decodeUnknownEffect(AgentActivityActorsResultSchema)({
      agentIds: rows.flatMap((row) => (row.kind === 'agent' ? [row.principalId] : [])),
      names: rows.map(({ displayName, principalId }) => ({ displayName, principalId })),
    }).pipe(Effect.mapError(agentActivityUnavailable));
  }),
});

type Services = ReturnType<typeof activityActorsFromTransaction>;
const load = Effect.fn('AgentActivityActorsRead.load')(function* load(
  _input: typeof AgentActivityActorsInputSchema.Type,
  context: ReadLoadContext<Services>,
) {
  const result = yield* context.services.load();
  return { evidence: { resultCount: result.names.length }, result };
});

/** Selected-company revalidation, not an unrelated read_people/manage_people permission. */
export const agentActivityActorsRead = defineRead(
  {
    accessKind: 'list',
    entrypoint: defineSystemModuleEntrypoint({
      access: 'read',
      authorization: { kind: 'authenticated_principal' },
      entrypointKey: 'core.identity.agent-activity-actors',
      moduleKey: 'core.identity',
      role: 'api',
    }),
    evidencePolicy: { captureMode: 'metadata_only', policyKey: 'core.identity.agent-activity-actors.access.v1' },
    inputSchema: AgentActivityActorsInputSchema,
    legalEntityScope: 'required',
    owningModuleKey: 'core.identity',
    permissionTarget: 'legal_entity',
    policies: [],
    readKey: 'core.identity.agent-activity-actors',
    resultSchema: AgentActivityActorsResultSchema,
    schemaVersion: '1',
  },
  { load },
  (transaction) => Effect.succeed(activityActorsFromTransaction(transaction)),
  () => ({ kind: 'legal_entity' }),
);
