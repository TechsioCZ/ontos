import { Effect, Schema } from 'effect';

import {
  ActiveApplicationCompositionService,
  validateActiveApplicationCompositionSnapshot,
} from '../modules/active-application-composition.ts';
import { buildApplicationCompositionCatalog } from '../modules/application-composition-catalog.ts';
import { defineSystemModuleEntrypoint } from '../modules/module-entrypoint.ts';
import { ActionAuthority } from '../permissions/action-authority.ts';
import type { ReadPrepareContext, ReadLoadContext } from '../reads/context.ts';
import { defineRead } from '../reads/definition.ts';
import { AgentActivityInputSchema, AgentActivityResultSchema } from './agent-activity-contract.ts';
import { activityFromTransaction } from './agent-activity-persistence.ts';
import { agentActivityUnavailable } from './agent-activity-unavailable.ts';

/** Fully consistent module and executable-Action rights; request module keys can only narrow them. */
const prepare = Effect.fn('AgentActivityRead.prepare')(function* prepare(
  input: typeof AgentActivityInputSchema.Type,
  context: ReadPrepareContext,
) {
  const { legalEntityId } = context.scope;
  if (legalEntityId === undefined) {
    return yield* agentActivityUnavailable('An exact company context is required');
  }
  const snapshot = yield* (yield* ActiveApplicationCompositionService).load.pipe(
    Effect.flatMap(validateActiveApplicationCompositionSnapshot),
    Effect.mapError(agentActivityUnavailable),
  );
  if (context.compositionRevision !== undefined && context.compositionRevision !== snapshot.composition.revision) {
    return yield* agentActivityUnavailable('The active composition changed during admission');
  }
  const catalog = yield* buildApplicationCompositionCatalog(snapshot.composition).pipe(
    Effect.mapError(agentActivityUnavailable),
  );
  // The module and Action rights are the one gate's answer over each module's own published Actions; a
  // legacy `module_access` hint is never consulted, so a principal that holds only v2 grants is seen
  // (O62, O67-Q5). The request's module keys can only narrow the answer below.
  const actions = catalog.contracts.flatMap(({ manifest }) =>
    manifest.publicSurface.actions.filter((action) => action.legalEntityScope !== 'forbidden'),
  );
  // One gate question per Action, over this request's own trusted scope: the answer already names the
  // principal, tenant and company it was decided in, so no scalar identity is re-checked here (O66).
  const authorities = yield* (yield* ActionAuthority)
    .checkActionAuthorities({ actionKeys: actions.map(({ actionKey }) => actionKey), scope: context.scope })
    .pipe(Effect.mapError(agentActivityUnavailable));
  const executable = new Set(
    authorities.flatMap(({ actionKey, execute }) => (execute === 'allowed' ? [actionKey] : [])),
  );
  const writable = new Set(
    actions.flatMap(({ actionKey, owningModuleId }) => (executable.has(actionKey) ? [owningModuleId] : [])),
  );
  const visibleModules = [...new Set(input.visibleModules)].filter(
    (key) => writable.has(key) && (input.request.moduleKey === undefined || input.request.moduleKey === key),
  );
  return {
    nativeModules: catalog.contracts.flatMap(({ manifest }) =>
      manifest.publicSurface.mcp?.ownProposalEngine === true ? [manifest.module.id] : [],
    ),
    visibleModules,
  };
});

type Prepared = Effect.Success<ReturnType<typeof prepare>>;
type Services = ReturnType<typeof activityFromTransaction>;
const load = Effect.fn('AgentActivityRead.load')(function* load(
  input: typeof AgentActivityInputSchema.Type,
  context: ReadLoadContext<Services, Prepared>,
) {
  const result = yield* context.services.load(input.request, context.prepared);
  return { evidence: { resultCount: result.audit.length + result.access.length + result.proposals.length }, result };
});

export const agentActivityRead = defineRead(
  {
    accessKind: 'list',
    entrypoint: defineSystemModuleEntrypoint({
      access: 'read',
      authorization: { kind: 'authenticated_principal' },
      entrypointKey: 'core.identity.agent-activity',
      moduleKey: 'core.identity',
      role: 'api',
    }),
    evidencePolicy: { captureMode: 'metadata_only', policyKey: 'core.identity.agent-activity.access.v1' },
    inputSchema: AgentActivityInputSchema,
    legalEntityScope: 'required',
    owningModuleKey: 'core.identity',
    permissionTarget: 'legal_entity',
    policies: [],
    readKey: 'core.identity.agent-activity',
    resultSchema: Schema.toType(AgentActivityResultSchema),
    schemaVersion: '1',
  },
  { load, prepare },
  (transaction) => Effect.succeed(activityFromTransaction(transaction)),
  () => ({ kind: 'legal_entity' }),
);
