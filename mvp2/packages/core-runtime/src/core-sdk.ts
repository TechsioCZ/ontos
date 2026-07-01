// @effect-diagnostics asyncFunction:off globalDate:off nodeBuiltinImport:off globalConsole:off
import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { isInstalledModuleKey, type ModuleStateAccessKind } from '@mvp2/shared-contracts';
import type {
  OperationActionInvocationStatus,
  OperationAuditOutcome,
  OperationAuditProfile,
  OperationAuditStage,
  OperationContext,
} from './operation-context.ts';
import { db } from './db/client.ts';
import { actionInvocations, auditEvents, domainEvents, outboxMessages } from './db/schema.ts';
import type { CoreDbExecutor, CoreTransaction } from './db/types.ts';
import type { OutboxMessage } from './outbox-message.ts';
import type { PolicyCheck, PolicyDenied } from './policy.ts';
import { checkModuleStateAccess } from './module-state.ts';
import { rowsFromResult } from './sql-result.ts';
import {
  createTenantScopedSpiceDbPermissionCheck,
  type SpiceDbAuthorizationChecker,
  spiceDbAuthorizationChecker,
} from './spicedb-authorization.ts';
import {
  type VerticalGatewayTokenInvalid,
  type VerticalGatewayTokenMissing,
  resolveVerticalGatewayToken,
} from './vertical-gateway-token.ts';

export type OperationAuthRequired = {
  readonly _tag: 'OperationAuthRequired';
  readonly message: string;
};

export type OperationContextInvalid = {
  readonly _tag: 'OperationContextInvalid';
  readonly message: string;
};

export type OperationIdempotencyKeyRequired = {
  readonly _tag: 'OperationIdempotencyKeyRequired';
  readonly message: string;
};

export type OperationIdempotencyConflict = {
  readonly _tag: 'OperationIdempotencyConflict';
  readonly message: string;
};

export type OperationIdempotencyReplayUnavailable = {
  readonly _tag: 'OperationIdempotencyReplayUnavailable';
  readonly message: string;
};

export type OperationPersistenceFailed = {
  readonly _tag: 'OperationPersistenceFailed';
  readonly message: string;
};

export type OperationDomainRejected = {
  readonly _tag: 'OperationDomainRejected';
  readonly code: string;
  readonly message: string;
};

export interface OperationPolicyDenied {
  readonly _tag: 'OperationPolicyDenied';
  readonly code: string;
  readonly message: string;
  readonly policyKey: string;
}

export interface OperationAuthorizationDenied {
  readonly _tag: 'OperationAuthorizationDenied';
  readonly code: 'authorization_denied' | 'authorization_unavailable';
  readonly message: string;
  readonly permission: string;
  readonly provider: 'spicedb';
  readonly resourceObjectId: string;
  readonly resourceObjectType: string;
}

export interface OperationModuleStateDenied {
  readonly _tag: 'OperationModuleStateDenied';
  readonly accessKind: ModuleStateAccessKind;
  readonly code:
    | 'module_state_load_blocked'
    | 'module_state_read_blocked'
    | 'module_state_mutate_blocked';
  readonly message: string;
  readonly moduleKey: string;
  readonly state: string;
}

export type OperationExecutionFailed = {
  readonly _tag: 'OperationExecutionFailed';
  readonly message: string;
};

export type CoreSDKError =
  | OperationAuthRequired
  | OperationContextInvalid
  | OperationIdempotencyKeyRequired
  | OperationIdempotencyConflict
  | OperationIdempotencyReplayUnavailable
  | OperationPersistenceFailed
  | OperationDomainRejected
  | OperationAuthorizationDenied
  | OperationModuleStateDenied
  | OperationPolicyDenied
  | OperationExecutionFailed;

export type OperationSucceeded<TAction, TResponse> = {
  readonly _tag: 'OperationSucceeded';
  readonly context: OperationContext<TAction>;
  readonly response: TResponse;
};

export type OperationResult<TAction, TResponse> =
  | OperationSucceeded<TAction, TResponse>
  | CoreSDKError;

export type ActionDescriptor<TAction = unknown, TResponse = unknown> = {
  readonly actionKey: string;
  readonly auditProfile: OperationAuditProfile;
  readonly authorization?: ActionAuthorizationRequirement;
  readonly domainEvent?: ActionDomainEventDescriptor<TAction, TResponse>;
  readonly gatewayAudience: string;
  readonly idempotency: 'optional' | 'required';
  readonly moduleStateAccess?: ModuleStateAccessKind;
  /**
   * Transport-facing schemas owned by the Effect BFF/API contract.
   * CoreSDK keeps them as descriptor metadata but does not parse transport payloads in this PoC.
   */
  readonly transportRequestSchema: unknown;
  readonly transportResponseSchema: unknown;
};

export type ActionDomainEventDescriptor<TAction, TResponse> = {
  readonly eventType: string;
  readonly payload?: (input: TAction, response: TResponse) => unknown;
  readonly producerModuleKey: string;
  readonly subjectModuleKey: string;
  readonly subjectResourceId: (input: TAction, response: TResponse) => string;
  readonly subjectResourceType: string;
};

export type ActionAuthorizationRequirement = {
  readonly permission: string;
  readonly provider: 'spicedb';
  readonly resourceObjectId: string;
  readonly resourceObjectType: string;
};

export type ActionExecutionServices<TAction> = {
  readonly context: OperationContext<TAction>;
  readonly tx: CoreTransaction;
};

export type ActionHandler<TAction, TResponse> = (
  input: TAction,
  services: ActionExecutionServices<TAction>,
) => Promise<TResponse> | TResponse;

export type ActionRegistration<TAction, TResponse> = {
  readonly descriptor: ActionDescriptor<TAction, TResponse>;
  readonly handler: ActionHandler<TAction, TResponse>;
  readonly policyChecks?: readonly PolicyCheck<TAction>[];
};

export type OperationTransport = {
  readonly headers: Headers;
};

export type RunActionOptions = {
  readonly authorizationChecker?: SpiceDbAuthorizationChecker;
};

export type ActionDomainRejection = {
  readonly _tag: 'ActionDomainRejection';
  readonly code: string;
  readonly message: string;
};

export const rejectAction = (input: {
  readonly code: string;
  readonly message: string;
}): ActionDomainRejection => ({
  _tag: 'ActionDomainRejection',
  code: input.code,
  message: input.message,
});

const isActionDomainRejection = (error: unknown): error is ActionDomainRejection =>
  typeof error === 'object' &&
  error !== null &&
  '_tag' in error &&
  error._tag === 'ActionDomainRejection';

const idempotencyKeyRequired = (actionKey: string): OperationIdempotencyKeyRequired => ({
  _tag: 'OperationIdempotencyKeyRequired',
  message: `Idempotency-Key header is required for ${actionKey}.`,
});

const idempotencyConflict = (): OperationIdempotencyConflict => ({
  _tag: 'OperationIdempotencyConflict',
  message: 'Idempotency-Key was already used with a different request payload.',
});

const replayUnavailable = (): OperationIdempotencyReplayUnavailable => ({
  _tag: 'OperationIdempotencyReplayUnavailable',
  // MVP2 records enough evidence to detect duplicate idempotency keys, but it does not persist
  // serialized business responses for safe replay yet.
  message: 'Idempotent replay is recorded, but response replay is not implemented yet.',
});

const persistenceFailed = (): OperationPersistenceFailed => ({
  _tag: 'OperationPersistenceFailed',
  message: 'CoreSDK could not persist the operation invocation.',
});

const domainRejected = (error: ActionDomainRejection): OperationDomainRejected => ({
  _tag: 'OperationDomainRejected',
  code: error.code,
  message: error.message,
});

const policyDenied = (decision: PolicyDenied): OperationPolicyDenied => ({
  _tag: 'OperationPolicyDenied',
  code: decision.code,
  message: decision.reason,
  policyKey: decision.policyKey,
});

const executionFailed = (error: unknown): OperationExecutionFailed => ({
  _tag: 'OperationExecutionFailed',
  message: error instanceof Error ? error.message : 'Action execution failed.',
});

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const authorizationDenied = ({
  code,
  message,
  permission,
  resourceObjectId,
  resourceObjectType,
}: {
  readonly code: 'authorization_denied' | 'authorization_unavailable';
  readonly message: string;
  readonly permission: string;
  readonly resourceObjectId: string;
  readonly resourceObjectType: string;
}): OperationAuthorizationDenied => ({
  _tag: 'OperationAuthorizationDenied',
  code,
  message,
  permission,
  provider: 'spicedb',
  resourceObjectId,
  resourceObjectType,
});

const moduleStateDenied = ({
  accessKind,
  code,
  moduleKey,
  state,
}: {
  readonly accessKind: ModuleStateAccessKind;
  readonly code:
    | 'module_state_load_blocked'
    | 'module_state_read_blocked'
    | 'module_state_mutate_blocked';
  readonly moduleKey: string;
  readonly state: string;
}): OperationModuleStateDenied => ({
  _tag: 'OperationModuleStateDenied',
  accessKind,
  code,
  message: `Module "${moduleKey}" is ${state}; ${accessKind} access is not allowed.`,
  moduleKey,
  state,
});

const authRequired = (error: VerticalGatewayTokenMissing): OperationAuthRequired => ({
  _tag: 'OperationAuthRequired',
  message: error.message,
});

const contextInvalid = (error: VerticalGatewayTokenInvalid): OperationContextInvalid => ({
  _tag: 'OperationContextInvalid',
  message: error.message,
});

const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }

  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
    .join(',')}}`;
};

const requestHash = (payload: unknown) =>
  createHash('sha256').update(stableStringify(payload)).digest('hex');

const resolveContext = <TAction>({
  action,
  actionKey,
  audience,
  transport,
}: {
  readonly action: TAction;
  readonly actionKey: string;
  readonly audience: string;
  readonly transport: OperationTransport;
}): OperationContext<TAction> | CoreSDKError => {
  const result = resolveVerticalGatewayToken({
    audience,
    token: transport.headers.get('x-ontos-operation-context'),
  });

  return result._tag === 'Success'
    ? {
        ...result.operationContext,
        action,
        actionKey,
        gatewayAudience: audience,
      }
    : result.error._tag === 'VerticalGatewayTokenMissing'
      ? authRequired(result.error)
      : contextInvalid(result.error);
};

const attachInvocation = <TAction>(
  context: OperationContext<TAction>,
  invocation: {
    readonly actionInvocationId: string;
    readonly idempotencyKey?: string;
    readonly requestHash: string;
    readonly status: OperationActionInvocationStatus;
  },
): OperationContext<TAction> => ({
  ...context,
  actionInvocation: invocation,
});

const attachAuditEvent = <TAction>(
  context: OperationContext<TAction>,
  auditEvent: NonNullable<OperationContext<TAction>['auditEvents']>[number],
): OperationContext<TAction> => ({
  ...context,
  auditEvents: [...(context.auditEvents ?? []), auditEvent],
});

const attachAuthorizationCheck = <TAction>(
  context: OperationContext<TAction>,
  authorizationCheck: NonNullable<OperationContext<TAction>['authorizationChecks']>[number],
): OperationContext<TAction> => ({
  ...context,
  authorizationChecks: [...(context.authorizationChecks ?? []), authorizationCheck],
});

const attachPolicyCheck = <TAction>(
  context: OperationContext<TAction>,
  policyCheck: NonNullable<OperationContext<TAction>['policyChecks']>[number],
): OperationContext<TAction> => ({
  ...context,
  policyChecks: [...(context.policyChecks ?? []), policyCheck],
});

const allocateTenantSequenceNo = async (tx: CoreTransaction, tenantId: string): Promise<bigint> => {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${tenantId})::bigint)`);

  const result = await tx.execute(sql`
    select coalesce(max(tenant_sequence_no), 0) + 1 as "tenantSequenceNo"
    from core.domain_events
    where tenant_id = ${tenantId}
  `);
  const row = rowsFromResult<{
    readonly tenantSequenceNo: bigint | number | string;
  }>(result).at(0);

  if (row === undefined) {
    throw new Error('Could not allocate tenant domain event sequence number.');
  }

  return BigInt(row.tenantSequenceNo);
};

const persistAutomaticDomainEvent = async <TAction, TResponse>({
  context,
  descriptor,
  input,
  response,
  tx,
}: {
  readonly context: OperationContext<TAction>;
  readonly descriptor: ActionDomainEventDescriptor<TAction, TResponse> | undefined;
  readonly input: TAction;
  readonly response: TResponse;
  readonly tx: CoreTransaction;
}): Promise<string | undefined> => {
  if (descriptor === undefined) {
    return undefined;
  }

  if (context.actionInvocation === undefined) {
    throw new Error('Cannot create domain event without an action invocation.');
  }

  const tenantSequenceNo = await allocateTenantSequenceNo(tx, context.tenantId);
  const [inserted] = await tx
    .insert(domainEvents)
    .values({
      actionInvocationId: context.actionInvocation.actionInvocationId,
      eventType: descriptor.eventType,
      legalEntityId: context.legalEntityId,
      payloadJson: descriptor.payload?.(input, response) ?? {},
      producerModuleKey: descriptor.producerModuleKey,
      subjectModuleKey: descriptor.subjectModuleKey,
      subjectResourceId: descriptor.subjectResourceId(input, response),
      subjectResourceType: descriptor.subjectResourceType,
      tenantId: context.tenantId,
      tenantSequenceNo,
    })
    .returning({
      domainEventId: domainEvents.domainEventId,
    });

  if (inserted === undefined) {
    throw new Error('CoreSDK could not persist the automatic domain event.');
  }

  return inserted.domainEventId;
};

const persistOutboxMessages = async ({
  domainEventId,
  messages,
  producerModuleKey,
  tenantId,
  tx,
}: {
  readonly domainEventId: string | undefined;
  readonly messages: readonly OutboxMessage<string, unknown>[];
  readonly producerModuleKey: string | undefined;
  readonly tenantId: string;
  readonly tx: CoreTransaction;
}): Promise<void> => {
  if (messages.length === 0) {
    return;
  }

  if (domainEventId === undefined || producerModuleKey === undefined) {
    throw new Error('Outbox messages require an automatic action domain event descriptor.');
  }

  await tx.insert(outboxMessages).values(
    messages.map((message) => ({
      domainEventId,
      payloadJson: message.payload ?? {},
      producerModuleKey,
      tenantId,
      topic: message.topic,
    })),
  );
};

const findActionInvocation = async ({
  actionKey,
  idempotencyKey,
  principalId,
  tenantId,
}: {
  readonly actionKey: string;
  readonly idempotencyKey: string;
  readonly principalId: string;
  readonly tenantId: string;
}) => {
  const [existing] = await db
    .select({
      actionInvocationId: actionInvocations.actionInvocationId,
      requestHash: actionInvocations.requestHash,
      status: actionInvocations.status,
    })
    .from(actionInvocations)
    .where(
      and(
        eq(actionInvocations.tenantId, tenantId),
        eq(actionInvocations.actionKey, actionKey),
        eq(actionInvocations.principalId, principalId),
        eq(actionInvocations.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1);

  return existing;
};

const registerActionInvocation = async <TAction>({
  context,
  idempotencyKey,
  idempotency,
  requestHash: hash,
}: {
  readonly context: OperationContext<TAction>;
  readonly idempotencyKey: string | undefined;
  readonly idempotency: 'optional' | 'required';
  readonly requestHash: string;
}): Promise<OperationContext<TAction> | CoreSDKError> => {
  if (idempotency === 'required' && idempotencyKey === undefined) {
    return idempotencyKeyRequired(context.actionKey);
  }

  if (idempotencyKey !== undefined) {
    const existing = await findActionInvocation({
      actionKey: context.actionKey,
      idempotencyKey,
      principalId: context.principalId,
      tenantId: context.tenantId,
    });

    if (existing !== undefined) {
      return existing.requestHash === hash ? replayUnavailable() : idempotencyConflict();
    }
  }

  const [inserted] = await db
    .insert(actionInvocations)
    .values({
      actionKey: context.actionKey,
      authMethod: 'session',
      idempotencyKey,
      legalEntityId: context.legalEntityId,
      principalId: context.principalId,
      requestHash: hash,
      status: 'received',
      tenantId: context.tenantId,
    })
    .returning({
      actionInvocationId: actionInvocations.actionInvocationId,
    });

  if (inserted === undefined) {
    return persistenceFailed();
  }

  return attachInvocation(context, {
    actionInvocationId: inserted.actionInvocationId,
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    requestHash: hash,
    status: 'received',
  });
};

const markActionInvocationStatus = async <TAction>(
  context: OperationContext<TAction>,
  status: Extract<OperationActionInvocationStatus, 'succeeded' | 'failed' | 'rejected'>,
  executor: CoreDbExecutor = db,
) => {
  if (context.actionInvocation === undefined) {
    return context;
  }

  await executor
    .update(actionInvocations)
    .set({
      completedAt: new Date(),
      status,
    })
    .where(eq(actionInvocations.actionInvocationId, context.actionInvocation.actionInvocationId));

  return attachInvocation(context, {
    ...context.actionInvocation,
    status,
  });
};

const writeAuditEvent = async <TAction>({
  auditProfile,
  context,
  evidenceJson,
  eventType,
  executor = db,
  outcome,
  outcomeCode,
  outcomeStage,
  targetModuleKey,
  targetResourceId,
  targetResourceType,
}: {
  readonly auditProfile: OperationAuditProfile;
  readonly context: OperationContext<TAction>;
  readonly evidenceJson?: Record<string, unknown>;
  readonly eventType: string;
  readonly executor?: CoreDbExecutor;
  readonly outcome: OperationAuditOutcome;
  readonly outcomeCode: string;
  readonly outcomeStage: OperationAuditStage;
  readonly targetModuleKey?: string;
  readonly targetResourceId?: string;
  readonly targetResourceType?: string;
}): Promise<OperationContext<TAction> | CoreSDKError> => {
  const [inserted] = await executor
    .insert(auditEvents)
    .values({
      actionInvocationId: context.actionInvocation?.actionInvocationId,
      auditProfile,
      authMethod: 'session',
      evidenceJson: evidenceJson ?? {},
      eventType,
      legalEntityId: context.legalEntityId,
      outcome,
      outcomeCode,
      outcomeStage,
      principalId: context.principalId,
      targetModuleKey,
      targetResourceId,
      targetResourceType,
      tenantId: context.tenantId,
    })
    .returning({
      auditEventId: auditEvents.auditEventId,
    });

  if (inserted === undefined) {
    return persistenceFailed();
  }

  return attachAuditEvent(context, {
    auditEventId: inserted.auditEventId,
    auditProfile,
    eventType,
    outcome,
    outcomeCode,
    outcomeStage,
  });
};

const toSpiceDbPermissionCheck = <TAction>(
  context: OperationContext<TAction>,
  requirement: ActionAuthorizationRequirement,
) =>
  createTenantScopedSpiceDbPermissionCheck({
    permission: requirement.permission,
    principalId: context.principalId,
    resourceObjectId: requirement.resourceObjectId,
    resourceObjectType: requirement.resourceObjectType,
    tenantId: context.tenantId,
  });

const authorizeWithSpiceDb = async <TAction>({
  auditProfile,
  authorizationChecker,
  context,
  requirement,
}: {
  readonly auditProfile: OperationAuditProfile;
  readonly authorizationChecker: SpiceDbAuthorizationChecker;
  readonly context: OperationContext<TAction>;
  readonly requirement: ActionAuthorizationRequirement | undefined;
}): Promise<OperationContext<TAction> | CoreSDKError> => {
  if (requirement === undefined) {
    return writeAuditEvent({
      auditProfile,
      context,
      eventType: 'action.authorization.skipped',
      outcome: 'allowed',
      outcomeCode: 'spicedb_authorization_not_required',
      outcomeStage: 'authz',
    });
  }

  const check = toSpiceDbPermissionCheck(context, requirement);
  const authorization = await authorizationChecker(check);

  if (authorization._tag === 'Allowed') {
    const checkedContext = attachAuthorizationCheck(context, {
      decision: 'allowed',
      mode: 'check_permission',
      permission: check.permission,
      provider: 'spicedb',
      reason: 'SpiceDB checkPermission allowed.',
      resourceObjectId: check.resourceObjectId,
      resourceObjectType: check.resourceObjectType,
    });

    return writeAuditEvent({
      auditProfile,
      context: checkedContext,
      eventType: 'action.authorization.allowed',
      outcome: 'allowed',
      outcomeCode: 'spicedb_check_permission_allowed',
      outcomeStage: 'authz',
    });
  }

  const reason = authorization.message;
  const checkedContext = attachAuthorizationCheck(context, {
    decision: 'denied',
    mode: 'check_permission',
    permission: check.permission,
    provider: 'spicedb',
    reason,
    resourceObjectId: check.resourceObjectId,
    resourceObjectType: check.resourceObjectType,
  });
  try {
    const rejectedContext = await markActionInvocationStatus(checkedContext, 'rejected');
    const auditedContext = await writeAuditEvent({
      auditProfile,
      context: rejectedContext,
      eventType: 'action.authorization.denied',
      outcome: 'denied',
      outcomeCode:
        authorization._tag === 'Unavailable'
          ? 'spicedb_authorization_unavailable'
          : 'spicedb_denied',
      outcomeStage: 'authz',
    });

    if ('_tag' in auditedContext) {
      console.warn(
        JSON.stringify({
          actionKey: context.actionKey,
          message: auditedContext.message,
          principalId: context.principalId,
          tenantId: context.tenantId,
          type: 'authorization_denied_evidence_persistence_failed',
        }),
      );
    }
  } catch (error) {
    console.warn(
      JSON.stringify({
        actionKey: context.actionKey,
        message: errorMessage(error),
        principalId: context.principalId,
        tenantId: context.tenantId,
        type: 'authorization_denied_evidence_persistence_failed',
      }),
    );
  }

  return authorizationDenied({
    code:
      authorization._tag === 'Unavailable' ? 'authorization_unavailable' : 'authorization_denied',
    message: reason,
    permission: check.permission,
    resourceObjectId: check.resourceObjectId,
    resourceObjectType: check.resourceObjectType,
  });
};

const enforceModuleStateGate = async <TAction>({
  accessKind,
  auditProfile,
  context,
  eventPrefix,
  rejectInvocation,
}: {
  readonly accessKind: ModuleStateAccessKind | undefined;
  readonly auditProfile: OperationAuditProfile;
  readonly context: OperationContext<TAction>;
  readonly eventPrefix: 'action' | 'data_access';
  readonly rejectInvocation: boolean;
}): Promise<OperationContext<TAction> | CoreSDKError> => {
  if (accessKind === undefined) {
    return context;
  }

  if (!isInstalledModuleKey(context.gatewayAudience)) {
    return context;
  }

  const checked = await checkModuleStateAccess({
    accessKind,
    moduleKey: context.gatewayAudience,
    tenantId: context.tenantId,
  });

  if (checked._tag === 'Allowed') {
    return context;
  }

  const rejectedContext = rejectInvocation
    ? await markActionInvocationStatus(context, 'rejected')
    : context;
  const auditedContext = await writeAuditEvent({
    auditProfile,
    context: rejectedContext,
    eventType: `${eventPrefix}.module_state.denied`,
    evidenceJson: {
      accessKind: checked.accessKind,
      moduleKey: checked.moduleKey,
      state: checked.state,
    },
    outcome: 'denied',
    outcomeCode: checked.outcomeCode,
    outcomeStage: 'policy',
    targetModuleKey: checked.moduleKey,
  });

  console.warn(
    JSON.stringify({
      accessKind: checked.accessKind,
      actionKey: context.actionKey,
      moduleKey: checked.moduleKey,
      outcomeCode: checked.outcomeCode,
      principalId: context.principalId,
      state: checked.state,
      tenantId: context.tenantId,
      type: 'module_state.denied',
    }),
  );

  return '_tag' in auditedContext
    ? auditedContext
    : moduleStateDenied({
        accessKind: checked.accessKind,
        code: checked.outcomeCode,
        moduleKey: checked.moduleKey,
        state: checked.state,
      });
};

const evaluateActionPolicies = async <TAction>({
  auditProfile,
  context,
  policyChecks,
}: {
  readonly auditProfile: OperationAuditProfile;
  readonly context: OperationContext<TAction>;
  readonly policyChecks: readonly PolicyCheck<TAction>[];
}): Promise<OperationContext<TAction> | CoreSDKError> => {
  let checkedContext = context;
  let deniedDecision: PolicyDenied | undefined;

  for (const policyCheck of policyChecks) {
    const decision = policyCheck(context.action);

    checkedContext = attachPolicyCheck(checkedContext, {
      decision: decision.ok ? 'allowed' : 'denied',
      mode: 'action-policy',
      policyKey: decision.policyKey,
      reason: decision.reason,
    });

    if (!decision.ok) {
      deniedDecision = decision;
      break;
    }
  }

  if (deniedDecision !== undefined) {
    const rejectedContext = await markActionInvocationStatus(checkedContext, 'rejected');
    const auditedContext = await writeAuditEvent({
      auditProfile,
      context: rejectedContext,
      eventType: 'action.policy.denied',
      outcome: 'denied',
      outcomeCode: deniedDecision.code,
      outcomeStage: 'policy',
    });

    return '_tag' in auditedContext ? auditedContext : policyDenied(deniedDecision);
  }

  return writeAuditEvent({
    auditProfile,
    context: checkedContext,
    eventType: 'action.policy.allowed',
    outcome: 'allowed',
    outcomeCode: 'action_policies_allowed',
    outcomeStage: 'policy',
  });
};

const persistDomainRejection = async <TAction>({
  auditProfile,
  context,
  error,
}: {
  readonly auditProfile: OperationAuditProfile;
  readonly context: OperationContext<TAction>;
  readonly error: ActionDomainRejection;
}): Promise<CoreSDKError> => {
  const rejectedContext = await markActionInvocationStatus(context, 'rejected');
  const auditedContext = await writeAuditEvent({
    auditProfile,
    context: rejectedContext,
    eventType: 'action.rejected',
    outcome: 'denied',
    outcomeCode: error.code,
    outcomeStage: 'execution',
  });

  return '_tag' in auditedContext ? auditedContext : domainRejected(error);
};

const persistExecutionFailure = async <TAction>({
  auditProfile,
  context,
  error,
}: {
  readonly auditProfile: OperationAuditProfile;
  readonly context: OperationContext<TAction>;
  readonly error: unknown;
}): Promise<CoreSDKError> => {
  const failedContext = await markActionInvocationStatus(context, 'failed');
  const auditedContext = await writeAuditEvent({
    auditProfile,
    context: failedContext,
    eventType: 'action.failed',
    outcome: 'failed',
    outcomeCode: 'execution_failed',
    outcomeStage: 'execution',
  });

  return '_tag' in auditedContext ? auditedContext : executionFailed(error);
};

export const runAction = async <TAction, TResponse>({
  options = {},
  payload,
  registration,
  transport,
}: {
  readonly options?: RunActionOptions;
  readonly payload: TAction;
  readonly registration: ActionRegistration<TAction, TResponse>;
  readonly transport: OperationTransport;
}): Promise<OperationResult<TAction, TResponse>> => {
  const { descriptor, handler } = registration;
  const context = resolveContext({
    action: payload,
    actionKey: descriptor.actionKey,
    audience: descriptor.gatewayAudience,
    transport,
  });

  if ('_tag' in context) {
    return context;
  }

  const hash = requestHash(payload);
  const idempotencyKey = transport.headers.get('idempotency-key')?.trim() || undefined;
  const registeredContext = await registerActionInvocation({
    context,
    idempotencyKey,
    idempotency: descriptor.idempotency,
    requestHash: hash,
  });

  if ('_tag' in registeredContext) {
    return registeredContext;
  }

  const receivedContext = await writeAuditEvent({
    auditProfile: descriptor.auditProfile,
    context: registeredContext,
    eventType: 'action.received',
    outcome: 'succeeded',
    outcomeCode: 'action_received',
    outcomeStage: 'system',
  });

  if ('_tag' in receivedContext) {
    return receivedContext;
  }

  const moduleStateCheckedContext = await enforceModuleStateGate({
    accessKind: descriptor.moduleStateAccess,
    auditProfile: descriptor.auditProfile,
    context: receivedContext,
    eventPrefix: 'action',
    rejectInvocation: true,
  });

  if ('_tag' in moduleStateCheckedContext) {
    return moduleStateCheckedContext;
  }

  const authorizedContext = await authorizeWithSpiceDb({
    auditProfile: descriptor.auditProfile,
    authorizationChecker: options.authorizationChecker ?? spiceDbAuthorizationChecker,
    context: moduleStateCheckedContext,
    requirement: descriptor.authorization,
  });

  if ('_tag' in authorizedContext) {
    return authorizedContext;
  }

  const policyCheckedContext = await evaluateActionPolicies({
    auditProfile: descriptor.auditProfile,
    context: authorizedContext,
    policyChecks: registration.policyChecks ?? [],
  });

  if ('_tag' in policyCheckedContext) {
    return policyCheckedContext;
  }

  try {
    return await db.transaction(async (tx): Promise<OperationResult<TAction, TResponse>> => {
      const handlerOutboxMessages: OutboxMessage<string, unknown>[] = [];
      const response = await handler(payload, {
        context: {
          ...policyCheckedContext,
          addOutboxMessage: (message) => {
            handlerOutboxMessages.push(message);
          },
        },
        tx,
      });
      const domainEventId = await persistAutomaticDomainEvent({
        context: policyCheckedContext,
        descriptor: descriptor.domainEvent,
        input: payload,
        response,
        tx,
      });
      await persistOutboxMessages({
        domainEventId,
        messages: handlerOutboxMessages,
        producerModuleKey: descriptor.domainEvent?.producerModuleKey,
        tenantId: policyCheckedContext.tenantId,
        tx,
      });
      const completedContext = await markActionInvocationStatus(
        policyCheckedContext,
        'succeeded',
        tx,
      );
      const auditedContext = await writeAuditEvent({
        auditProfile: descriptor.auditProfile,
        context: completedContext,
        eventType: 'action.succeeded',
        executor: tx,
        outcome: 'succeeded',
        outcomeCode: 'action_succeeded',
        outcomeStage: 'execution',
      });

      if ('_tag' in auditedContext) {
        return auditedContext;
      }

      return {
        _tag: 'OperationSucceeded',
        context: auditedContext,
        response,
      } satisfies OperationSucceeded<TAction, TResponse>;
    });
  } catch (error) {
    return isActionDomainRejection(error)
      ? persistDomainRejection({
          auditProfile: descriptor.auditProfile,
          context: policyCheckedContext,
          error,
        })
      : persistExecutionFailure({
          auditProfile: descriptor.auditProfile,
          context: policyCheckedContext,
          error,
        });
  }
};
