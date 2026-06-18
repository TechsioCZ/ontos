// @effect-diagnostics asyncFunction:off globalDate:off nodeBuiltinImport:off
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type {
  OperationAccessKind,
  OperationActionInvocationStatus,
  OperationAuditOutcome,
  OperationAuditProfile,
  OperationAuditStage,
  OperationContext,
  OperationEvidenceCaptureMode,
} from './operation-context.ts';
import { db } from './db/client.ts';
import { actionInvocations, auditEvents, dataAccessEvents } from './db/schema.ts';
import type { PolicyCheck, PolicyDenied } from './policy.ts';
import {
  type VerticalGatewayTokenInvalid,
  type VerticalGatewayTokenMissing,
  resolveVerticalGatewayToken,
} from './vertical-gateway-token.ts';

type CoreTransactionCallback = Parameters<typeof db.transaction>[0];

export type CoreTransaction = Parameters<CoreTransactionCallback>[0];

type CoreDbExecutor = typeof db | CoreTransaction;

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

export type ActionDescriptor = {
  readonly actionKey: string;
  readonly auditProfile: OperationAuditProfile;
  readonly gatewayAudience: string;
  readonly idempotency: 'optional' | 'required';
  readonly requestSchema: unknown;
  readonly responseSchema: unknown;
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
  readonly descriptor: ActionDescriptor;
  readonly handler: ActionHandler<TAction, TResponse>;
  readonly policyChecks?: readonly PolicyCheck<TAction>[];
};

export type DataAccessDescriptor = {
  readonly accessKey: string;
  readonly accessKind: OperationAccessKind;
  readonly evidenceCaptureMode?: OperationEvidenceCaptureMode;
  readonly evidencePolicyKey: string;
  readonly gatewayAudience: string;
  readonly requestSchema: unknown;
  readonly responseSchema: unknown;
  readonly servingModuleKey: string;
  readonly targetModuleKey?: string;
  readonly targetResourceId?: string;
  readonly targetResourceType?: string;
};

export type DataAccessExecutionServices<TRequest> = {
  readonly context: OperationContext<TRequest>;
};

export type DataAccessHandler<TRequest, TResponse> = (
  input: TRequest,
  services: DataAccessExecutionServices<TRequest>,
) => Promise<TResponse> | TResponse;

export type DataAccessRegistration<TRequest, TResponse> = {
  readonly descriptor: DataAccessDescriptor;
  readonly handler: DataAccessHandler<TRequest, TResponse>;
};

export type OperationTransport = {
  readonly headers: Headers;
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

const attachDataAccessEvent = <TRequest>(
  context: OperationContext<TRequest>,
  dataAccessEvent: NonNullable<OperationContext<TRequest>['dataAccessEvents']>[number],
): OperationContext<TRequest> => ({
  ...context,
  dataAccessEvents: [...(context.dataAccessEvents ?? []), dataAccessEvent],
});

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
  eventType,
  executor = db,
  outcome,
  outcomeCode,
  outcomeStage,
}: {
  readonly auditProfile: OperationAuditProfile;
  readonly context: OperationContext<TAction>;
  readonly eventType: string;
  readonly executor?: CoreDbExecutor;
  readonly outcome: OperationAuditOutcome;
  readonly outcomeCode: string;
  readonly outcomeStage: OperationAuditStage;
}): Promise<OperationContext<TAction> | CoreSDKError> => {
  if (context.actionInvocation === undefined) {
    return persistenceFailed();
  }

  const [inserted] = await executor
    .insert(auditEvents)
    .values({
      actionInvocationId: context.actionInvocation.actionInvocationId,
      auditProfile,
      authMethod: 'session',
      eventType,
      legalEntityId: context.legalEntityId,
      outcome,
      outcomeCode,
      outcomeStage,
      principalId: context.principalId,
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

const authorizeWithSpiceDbPlaceholder = async <TAction>({
  auditProfile,
  context,
}: {
  readonly auditProfile: OperationAuditProfile;
  readonly context: OperationContext<TAction>;
}): Promise<OperationContext<TAction> | CoreSDKError> => {
  const checkedContext = attachAuthorizationCheck(context, {
    decision: 'allowed',
    mode: 'placeholder',
    provider: 'spicedb',
    reason: 'SpiceDB check is intentionally skipped for now.',
  });

  return writeAuditEvent({
    auditProfile,
    context: checkedContext,
    eventType: 'action.authorization.allowed',
    outcome: 'allowed',
    outcomeCode: 'spicedb_placeholder_allowed',
    outcomeStage: 'authz',
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

const resultCount = (response: unknown): number => {
  if (Array.isArray(response)) {
    return response.length;
  }

  return response === null || response === undefined ? 0 : 1;
};

const writeDataAccessEvent = async <TRequest>({
  context,
  descriptor,
  queryHash,
  resultCount: count,
}: {
  readonly context: OperationContext<TRequest>;
  readonly descriptor: DataAccessDescriptor;
  readonly queryHash: string;
  readonly resultCount: number;
}): Promise<OperationContext<TRequest> | CoreSDKError> => {
  const evidenceCaptureMode = descriptor.evidenceCaptureMode ?? 'metadata_only';
  const [inserted] = await db
    .insert(dataAccessEvents)
    .values({
      accessKind: descriptor.accessKind,
      authMethod: 'session',
      evidenceCaptureMode,
      evidencePolicyKey: descriptor.evidencePolicyKey,
      legalEntityId: context.legalEntityId,
      principalId: context.principalId,
      queryHash,
      resultCount: count,
      servingModuleKey: descriptor.servingModuleKey,
      targetModuleKey: descriptor.targetModuleKey,
      targetResourceId: descriptor.targetResourceId,
      targetResourceType: descriptor.targetResourceType,
      tenantId: context.tenantId,
    })
    .returning({
      dataAccessEventId: dataAccessEvents.dataAccessEventId,
    });

  if (inserted === undefined) {
    return persistenceFailed();
  }

  return attachDataAccessEvent(context, {
    accessKind: descriptor.accessKind,
    dataAccessEventId: inserted.dataAccessEventId,
    evidenceCaptureMode,
    evidencePolicyKey: descriptor.evidencePolicyKey,
    queryHash,
    resultCount: count,
    servingModuleKey: descriptor.servingModuleKey,
  });
};

export const runAction = async <TAction, TResponse>({
  payload,
  registration,
  transport,
}: {
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

  const authorizedContext = await authorizeWithSpiceDbPlaceholder({
    auditProfile: descriptor.auditProfile,
    context: receivedContext,
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
      const response = await handler(payload, {
        context: policyCheckedContext,
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

export const runDataAccess = async <TRequest, TResponse>({
  query,
  registration,
  transport,
}: {
  readonly query: TRequest;
  readonly registration: DataAccessRegistration<TRequest, TResponse>;
  readonly transport: OperationTransport;
}): Promise<OperationResult<TRequest, TResponse>> => {
  const { descriptor, handler } = registration;
  const context = resolveContext({
    action: query,
    actionKey: descriptor.accessKey,
    audience: descriptor.gatewayAudience,
    transport,
  });

  if ('_tag' in context) {
    return context;
  }

  const response = await handler(query, { context });
  const queryHash = requestHash(query);
  const eventContext = await writeDataAccessEvent({
    context,
    descriptor,
    queryHash,
    resultCount: resultCount(response),
  });

  if ('_tag' in eventContext) {
    return eventContext;
  }

  return {
    _tag: 'OperationSucceeded',
    context: eventContext,
    response,
  } satisfies OperationSucceeded<TRequest, TResponse>;
};
