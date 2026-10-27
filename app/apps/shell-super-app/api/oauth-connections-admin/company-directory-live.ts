import { createHash } from 'node:crypto';

import {
  ActionRuntime,
  companyAgentDirectoryRead,
  openPrincipalOperators,
  ReadRuntime,
  replaceAgentOperatorsAction,
} from '@app/core-runtime';
import type { CompanyAgentDirectoryResultSchema } from '@app/core-runtime';
import { ActionAuthorizationLifecycle } from '@app/core-runtime/outbox/core-system-worker';
import { AgentModuleKeySchema, AgentPrincipalIdSchema } from '@app/shared-contracts/agent-proposals';
import { Effect, Layer, Match, Schema } from 'effect';

import { ShellInstalledModuleCatalog } from '../modules/installed-module-catalog.ts';
import { CompanyDirectory } from './company-directory.ts';
import type { CompanyDirectoryPort, CompanyDirectoryRequest } from './company-directory.ts';
import { ConnectionsForbidden } from './connections-forbidden.ts';
import { ConnectionsGone } from './connections-gone.ts';
import { ConnectionsInvalid } from './connections-invalid.ts';
import { ConnectionsNotFound } from './connections-not-found.ts';
import { ConnectionsUnavailable } from './connections-unavailable.ts';
import type { CompanyDirectorySnapshot } from './ports.ts';

const unavailable = (cause: unknown) => new ConnectionsUnavailable({ cause });
const fromRuntimeError = (error: { readonly _tag: string }) =>
  Match.value(error._tag).pipe(
    Match.when(
      Match.is('IdentityLifecycleConflictError', 'ActionRequestHashConflict'),
      () => new ConnectionsGone({ reason: 'Agent se mezitím změnil. Obnovte seznam a zkuste to znovu.' }),
    ),
    Match.when(
      Match.is('IdentityTargetInvalidError', 'ActionPayloadValidationError'),
      () => new ConnectionsInvalid({ cause: error, reason: 'Tuto změnu agenta nelze provést.' }),
    ),
    Match.when(
      Match.is('ActionPermissionDenied', 'ActionPolicyDenied', 'ReadPermissionDenied', 'ReadPolicyDenied'),
      () => new ConnectionsForbidden({ reason: 'K této operaci nemáte oprávnění.' }),
    ),
    Match.orElse(() => unavailable(error)),
  );

const sameSet = (left: readonly string[], right: readonly string[]) => {
  const rightIds = new Set(right);
  return left.length === rightIds.size && left.every((id) => rightIds.has(id));
};

const directorySnapshot = (snapshot: typeof CompanyAgentDirectoryResultSchema.Type): CompanyDirectorySnapshot => ({
  ...snapshot,
  agents: snapshot.agents.map((agent) => ({
    ...agent,
    modules: agent.modules.map((module) => ({
      ...module,
      moduleId: AgentModuleKeySchema.make(module.moduleId),
    })),
  })),
  people: snapshot.people.map((person) => ({
    ...person,
    principalId: AgentPrincipalIdSchema.make(person.principalId),
  })),
});

/** Bind the original authenticated carrier once; the Layer owns its runtime dependencies. */
export const CompanyDirectoryLive = (request: CompanyDirectoryRequest) =>
  Layer.effect(
    CompanyDirectory,
    Effect.gen(function* companyDirectoryService() {
      const reads = yield* ReadRuntime;
      const actions = yield* ActionRuntime;
      const lifecycle = yield* ActionAuthorizationLifecycle;
      const catalog = yield* ShellInstalledModuleCatalog;

      const loadSnapshot = Effect.suspend(() =>
        reads.runRead({
          input: {},
          principal: request.principal,
          registration: companyAgentDirectoryRead,
          transport: { correlationId: request.transport.correlationId },
        }),
      ).pipe(
        Effect.map(directorySnapshot),
        Effect.mapError(fromRuntimeError),
        Effect.withSpan('CompanyDirectory.snapshot'),
      );

      const reconcile = Effect.fn('CompanyDirectory.reconcile')(function* reconcileOperators(agentPrincipalId: string) {
        const installed = yield* catalog.load;
        yield* lifecycle.reconcilePrincipal(
          request.principal.tenantId,
          agentPrincipalId,
          installed.composition.revision,
        );
      }, Effect.mapError(unavailable));

      const replaceOperators = Effect.fn('CompanyDirectory.replaceOperators')(function* replaceOperatorsEffect(
        input: Parameters<CompanyDirectoryPort<never>['replaceOperators']>[0],
      ) {
        const agent = input.snapshot.agents.find((candidate) => candidate.principalId === input.agentPrincipalId);
        if (agent === undefined) {
          return yield* new ConnectionsNotFound({ reason: 'Agent v této firmě neexistuje.' });
        }
        if (agent.status !== 'active') {
          return yield* new ConnectionsInvalid({ reason: 'Operátory lze nastavit jen aktivnímu agentovi.' });
        }
        const wanted = [...new Set(input.operatorPrincipalIds)].toSorted();
        const eligible = new Set<string>(input.snapshot.people.map((person) => person.principalId));
        if (wanted.some((id) => !eligible.has(id))) {
          return yield* new ConnectionsInvalid({ reason: 'Agenta mohou připojit jen aktivní lidé z firmy.' });
        }
        const commandMatches =
          agent.operatorCommand !== null && sameSet(agent.operatorCommand.desiredOperatorPrincipalIds, wanted);
        // An older, contrary pending command must not silently undo this apparent graph no-op later.
        if (sameSet(agent.operatorPrincipalIds, wanted) && (agent.operatorCommand === null || commandMatches)) {
          return yield* Effect.void;
        }
        let revision = agent.operatorCommand?.revision ?? 0;
        if (!commandMatches) {
          const payload = {
            agentPrincipalId: agent.principalId,
            context: input.context,
            expectedRevision: revision,
            operatorPrincipalIds: wanted,
            revokedConnections: input.revokedConnections,
          };
          const encoded = yield* Schema.encodeEffect(
            Schema.fromJsonString(replaceAgentOperatorsAction.descriptor.payloadSchema),
          )(payload).pipe(
            Effect.mapError(
              (cause) => new ConnectionsInvalid({ cause, reason: 'Tuto změnu operátorů nelze provést.' }),
            ),
          );
          const idempotencyKey = createHash('sha256')
            .update(request.transport.idempotencyKey ?? '')
            .update('\0')
            .update(encoded)
            .digest('hex');
          yield* actions
            .runAction({
              payload,
              principal: request.principal,
              registration: replaceAgentOperatorsAction,
              transport: { correlationId: request.transport.correlationId, idempotencyKey },
            })
            .pipe(
              Effect.catchTag('ActionAlreadyCommitted', () => Effect.void),
              Effect.mapError(fromRuntimeError),
            );
          revision += 1;
        }
        // A matching committed command is resumed rather than written/audited again.
        yield* reconcile(agent.principalId);
        const confirmed = (yield* loadSnapshot).agents.find((candidate) => candidate.principalId === agent.principalId);
        if (
          confirmed?.status !== 'active' ||
          confirmed.operatorCommand?.revision !== revision ||
          !sameSet(confirmed.operatorCommand.desiredOperatorPrincipalIds, wanted) ||
          !sameSet(confirmed.operatorPrincipalIds, wanted)
        ) {
          return yield* unavailable('Operator projection has not converged; reload and retry');
        }
        return yield* Effect.void;
      });

      const confirmArchived = Effect.fn('CompanyDirectory.confirmArchived')(function* confirmArchivedEffect(
        agentPrincipalId: string,
      ) {
        yield* reconcile(agentPrincipalId);
        // Archive removes company membership. Confirm graph cleanup without emitting a second command.
        const operators = yield* Effect.scoped(
          openPrincipalOperators.pipe(Effect.flatMap((port) => port.operatorsOf(agentPrincipalId))),
        ).pipe(Effect.mapError(unavailable));
        if (operators.length !== 0) {
          return yield* unavailable('Archived agent cleanup has not converged; reload and retry');
        }
        return yield* Effect.void;
      });

      return { confirmArchived, replaceOperators, snapshot: loadSnapshot } satisfies CompanyDirectoryPort<never>;
    }),
  );
