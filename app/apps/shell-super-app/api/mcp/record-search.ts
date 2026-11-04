/** Actual record search, not MCP capability-description search and never a records-read snapshot. */
import {
  ContextAccess,
  TenantModuleStateService,
  TenantModuleStateRecordSchema,
  TrustedPrincipalContextSchema,
} from '@app/core-runtime';
import type { ConnectionDescription } from '@app/shared-contracts/oauth-connections';
import { Context, Data, Effect, Option, Predicate, Schema } from 'effect';
import { HttpServerRequest } from 'effect/http';

import { SHELL_SEARCH_MAX_RESOURCE_TYPES, ShellSearchPayloadSchema } from '../../shared/api.ts';
import { AgentReadRequestIdentity } from '../auth/agent-request-identity.ts';
import { capturedShellCatalog } from '../modules/captured-shell-catalog.ts';
import { ShellInstalledModuleCatalog } from '../modules/installed-module-catalog.ts';
import { ShellGovernedReads } from '../modules/shell-governed-reads.ts';
import { searchProviderModuleIds } from '../modules/shell-resources.ts';

import { mcpRecordSearchResourceTypes } from './catalog.ts';
import { authenticateMcpRequest, connectionPrincipalContext } from './connection.ts';
import { ModuleUnavailable } from './module-unavailable.ts';
import { problemOf } from './module-problem.ts';

/** Same query normalization/200-character contract and filters as the existing Shell search. No scope input. */
export const RecordSearchInput = Schema.Struct({
  includeArchived: ShellSearchPayloadSchema.fields.includeArchived,
  query: ShellSearchPayloadSchema.fields.query,
  resourceTypes: ShellSearchPayloadSchema.fields.resourceTypes,
  role: ShellSearchPayloadSchema.fields.role,
});

const RecordSearchRefusedError = Data.TaggedError('RecordSearchRefused')<{
  readonly code: 'record_search_forbidden' | 'record_search_reload_required';
  readonly message: string;
}>;
export type RecordSearchRefused = InstanceType<typeof RecordSearchRefusedError>;

const unavailable = (cause?: unknown) => {
  const failure = { message: 'Ověřená oprávnění pro hledání záznamů teď nejsou dostupná.' };
  return Schema.is(Schema.instanceOf(Error))(cause)
    ? new ModuleUnavailable({ ...failure, cause })
    : new ModuleUnavailable(failure);
};
const forbidden = () =>
  new RecordSearchRefusedError({
    code: 'record_search_forbidden',
    message: 'Požadované typy záznamů nejsou tomuto připojení povoleny.',
  });
const reloadRequired = () =>
  new RecordSearchRefusedError({
    code: 'record_search_reload_required',
    message: 'Kontext připojení nebo složení aplikace se změnilo. Načtěte nástroje znovu.',
  });

const sameConnectionContext = (current: ConnectionDescription, listed: ConnectionDescription): boolean =>
  current.grantId === listed.grantId &&
  current.tenantId === listed.tenantId &&
  current.legalEntityId === listed.legalEntityId &&
  current.acting.principalId === listed.acting.principalId &&
  current.client.clientId === listed.client.clientId &&
  current.compositionRevision === listed.compositionRevision;

const validBridgePrincipal = (
  principal: ReturnType<typeof connectionPrincipalContext>,
  current: ConnectionDescription,
): boolean =>
  Schema.is(Schema.toEncoded(TrustedPrincipalContextSchema))(principal) &&
  Schema.is(TrustedPrincipalContextSchema)(principal) &&
  principal.tenantId === current.tenantId &&
  principal.legalEntityId === current.legalEntityId &&
  principal.principalId === current.acting.principalId &&
  principal.connection.grantId === current.grantId &&
  current.status === 'active';

/** Re-enter the existing server verification/live-grant bridge; a tool argument is never authority. */
export const searchMcpRecords = Effect.fn('Mcp.searchRecords')(function* searchRecords(
  description: ConnectionDescription,
  input: typeof RecordSearchInput.Type,
) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const identity = yield* AgentReadRequestIdentity;
  if (request.headers['x-correlation-id'] !== identity.correlationId) {
    return yield* unavailable();
  }
  const token = /^Bearer\s+(?<token>\S+)$/iu.exec((request.headers['authorization'] ?? '').trim())?.groups?.['token'];
  if (token === undefined) {
    return yield* problemOf(401, { code: 'token_invalid' });
  }
  const live = yield* authenticateMcpRequest(token).pipe(
    Effect.mapError((cause) =>
      Predicate.isTagged(cause, 'ConnectionUnauthorized')
        ? problemOf(401, { code: 'token_invalid' })
        : unavailable(cause),
    ),
  );
  const current = live.description;
  // Compare authority facts, never labels. Admission below uses only the fresh grant, not the listed tool's rights.
  if (!sameConnectionContext(current, description)) {
    return yield* reloadRequired();
  }
  const principal = connectionPrincipalContext(live);
  // Validate the actual bridge output without decoding/coercing a caller-supplied object into trusted authority.
  if (!validBridgePrincipal(principal, current)) {
    return yield* unavailable();
  }
  const installed = yield* (yield* ShellInstalledModuleCatalog).load.pipe(Effect.mapError(unavailable));
  if (installed.composition.revision !== current.compositionRevision) {
    return yield* reloadRequired();
  }
  const moduleIds = searchProviderModuleIds(installed);
  const captured = yield* capturedShellCatalog.pipe(Effect.mapError(unavailable));
  if (captured.composition.revision !== installed.composition.revision) {
    return yield* reloadRequired();
  }
  const decisions = yield* (yield* ContextAccess).modules({
    legalEntityId: principal.legalEntityId,
    moduleIds,
    principalId: principal.principalId,
    tenantId: principal.tenantId,
  });
  const decisionByModule = new Map(decisions.map(({ decision, key }) => [key, decision]));
  if (
    decisions.length !== moduleIds.length ||
    decisionByModule.size !== moduleIds.length ||
    moduleIds.some((moduleId) => !decisionByModule.has(moduleId) || decisionByModule.get(moduleId) === 'unavailable')
  ) {
    return yield* unavailable();
  }
  const states = yield* (yield* TenantModuleStateService)
    .getTenantModuleStates(principal.tenantId, moduleIds)
    .pipe(Effect.mapError(unavailable));
  const keys = states.map(({ moduleKey }) => moduleKey);
  if (
    !Schema.is(Schema.Array(TenantModuleStateRecordSchema))(states) ||
    new Set(keys).size !== keys.length ||
    keys.some((key) => !moduleIds.includes(key))
  ) {
    return yield* unavailable();
  }
  const allowed = mcpRecordSearchResourceTypes(
    installed,
    {
      ...current,
      modules: current.modules.filter((module) => decisionByModule.get(module.moduleId) === 'allowed'),
    },
    states,
  );
  const allowedSet = new Set(allowed);
  const selected = input.resourceTypes === undefined ? allowed : [...new Set(input.resourceTypes)];
  if (selected.some((type) => !allowedSet.has(type))) {
    return yield* forbidden();
  }
  // Never silently truncate admission to the Shell's selector budget. An explicit subset can still be searched.
  if (selected.length > SHELL_SEARCH_MAX_RESOURCE_TYPES) {
    return yield* new ModuleUnavailable({
      message: 'Povolené typy přesahují limit jednoho hledání. Zadejte výslovný výběr resourceTypes.',
    });
  }
  if (selected.length === 0) {
    return { partial: false, results: [] };
  }
  // Always pass a concrete, grant-filtered selector BEFORE any provider dispatch. Core owns current record-level
  // authorization, relevance/order and full results. Do not paginate, postfilter, count or fabricate record URLs.
  return yield* (yield* ShellGovernedReads)
    .search({
      ...input,
      compositionRevision: installed.composition.revision,
      correlationId: identity.correlationId,
      principal,
      resourceTypes: selected,
    })
    .pipe(
      Effect.mapError((cause) =>
        Predicate.isTagged(cause, 'ReadPermissionDenied')
          ? problemOf(403, { code: 'read_permission_denied' })
          : unavailable(cause),
      ),
    );
});

/**
 * Request-bound port for the SDK's requirement-free callbacks. Only the MCP transport/composition boundary may
 * bind searchMcpRecords to real verified request services and a freshly captured release. Absence is unavailable,
 * never an invented principal or an unrestricted search fallback.
 */
export class McpRecordSearch extends Context.Service<
  McpRecordSearch,
  {
    readonly search: (
      description: ConnectionDescription,
      input: typeof RecordSearchInput.Type,
    ) => Effect.Effect<
      Effect.Success<ReturnType<typeof searchMcpRecords>>,
      Effect.Error<ReturnType<typeof searchMcpRecords>>
    >;
  }
>()('@app/shell-super-app/api/mcp/record-search/McpRecordSearch') {}

export const searchMcpRecordsTool = Effect.fn('Mcp.searchRecordsTool')(function* searchMcpRecordsTool(
  description: ConnectionDescription,
  input: typeof RecordSearchInput.Type,
) {
  const adapter = yield* Effect.serviceOption(McpRecordSearch);
  if (Option.isNone(adapter)) {
    return yield* unavailable();
  }
  return yield* adapter.value.search(description, input);
});
