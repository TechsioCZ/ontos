// @effect-diagnostics asyncFunction:off globalDate:off nodeBuiltinImport:off globalConsole:off
import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type {
  OperationActionInvocationStatus,
  OperationAccessKind,
  OperationAuditOutcome,
  OperationAuditProfile,
  OperationAuditStage,
  OperationContext,
  OperationEvidenceCaptureMode,
} from './operation-context.ts';
import { db } from './db/client.ts';
import {
  actionInvocations,
  auditEvents,
  dataAccessEvents,
  domainEvents,
  outboxMessages,
  principals,
} from './db/schema.ts';
import type { CoreDbExecutor, CoreReadonlyDbExecutor, CoreTransaction } from './db/types.ts';
import { checkModuleStateAccess, isInstalledModuleKey } from './module-state.ts';
import type { ModuleStateAccessKind } from './module-state.ts';
import type { OutboxMessage } from './outbox-message.ts';
import type { PolicyCheck, PolicyDenied } from './policy.ts';
import { rowsFromResult } from './sql-result.ts';
import {
  createTenantScopedSpiceDbPermissionCheck,
  spiceDbAuthorizationChecker,
} from './spicedb-authorization.ts';
import type { SpiceDbAuthorizationChecker } from './spicedb-authorization.ts';
import { resolveVerticalGatewayToken } from './vertical-gateway-token.ts';
import type {
  ResolveVerticalGatewayTokenResult,
  VerticalGatewayTokenInvalid,
  VerticalGatewayTokenMissing,
} from './vertical-gateway-token.ts';

export interface OperationAuthRequired {
  readonly _tag: 'OperationAuthRequired';
  readonly message: string;
}

export interface OperationContextInvalid {
  readonly _tag: 'OperationContextInvalid';
  readonly message: string;
}

export interface OperationIdempotencyKeyRequired {
  readonly _tag: 'OperationIdempotencyKeyRequired';
  readonly message: string;
}

export interface OperationIdempotencyConflict {
  readonly _tag: 'OperationIdempotencyConflict';
  readonly message: string;
}

export interface OperationIdempotencyReplayUnavailable {
  readonly _tag: 'OperationIdempotencyReplayUnavailable';
  readonly message: string;
}

export interface OperationPersistenceFailed {
  readonly _tag: 'OperationPersistenceFailed';
  readonly message: string;
}

export interface OperationDomainRejected {
  readonly _tag: 'OperationDomainRejected';
  readonly code: string;
  readonly message: string;
}

export interface OperationPolicyDenied {
  readonly _tag: 'OperationPolicyDenied';
  readonly code: string;
  readonly message: string;
  readonly policyKey: string;
  readonly state: unknown;
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

export interface OperationExecutionFailed {
  readonly _tag: 'OperationExecutionFailed';
  readonly message: string;
}

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

export interface OperationSucceeded<TAction, TResponse> {
  readonly _tag: 'OperationSucceeded';
  readonly context: OperationContext<TAction>;
  readonly response: TResponse;
}

export type OperationResult<TAction, TResponse> =
  | OperationSucceeded<TAction, TResponse>
  | CoreSDKError;

export const coreSDKErrorHttpStatus = (error: CoreSDKError): number => {
  switch (error._tag) {
    case 'OperationAuthRequired':
    case 'OperationContextInvalid': {
      return 401;
    }
    case 'OperationAuthorizationDenied':
    case 'OperationModuleStateDenied': {
      return 403;
    }
    case 'OperationIdempotencyKeyRequired': {
      return 428;
    }
    case 'OperationDomainRejected':
    case 'OperationIdempotencyConflict':
    case 'OperationIdempotencyReplayUnavailable':
    case 'OperationPolicyDenied': {
      return 409;
    }
    case 'OperationExecutionFailed':
    case 'OperationPersistenceFailed': {
      return 500;
    }
    default: {
      return error satisfies never;
    }
  }
};

export interface ActionDescriptor<TAction = unknown, TResponse = unknown> {
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
}

export interface ActionDomainEventDescriptor<TAction, TResponse> {
  readonly eventType: string;
  readonly payload?: (input: TAction, response: TResponse) => unknown;
  readonly producerModuleKey: string;
  readonly subjectModuleKey: string;
  readonly subjectResourceId: (input: TAction, response: TResponse) => string;
  readonly subjectResourceType: string;
}

export interface ActionAuthorizationRequirement {
  readonly permission: string;
  readonly provider: 'spicedb';
  readonly resourceObjectId: string;
  readonly resourceObjectType: string;
}

export interface ActionExecutionServices<TAction> {
  readonly context: OperationContext<TAction>;
  readonly tx: CoreTransaction;
}

export type ActionHandler<TAction, TResponse> = (
  input: TAction,
  services: ActionExecutionServices<TAction>,
) => Promise<TResponse> | TResponse;

export interface ActionRegistration<TAction, TResponse> {
  readonly descriptor: ActionDescriptor<TAction, TResponse>;
  readonly handler: ActionHandler<TAction, TResponse>;
  readonly policyChecks?: readonly PolicyCheck<TAction>[];
}

export interface DataAccessDescriptor {
  readonly accessKind: OperationAccessKind;
  readonly auditProfile: OperationAuditProfile;
  readonly authorization?: ActionAuthorizationRequirement;
  readonly dataAccessKey: string;
  readonly evidenceCaptureMode: OperationEvidenceCaptureMode;
  readonly evidencePolicyKey: string;
  readonly gatewayAudience: string;
  readonly moduleStateAccess?: ModuleStateAccessKind;
  readonly servingModuleKey: string;
  readonly targetModuleKey?: string;
  readonly targetResourceId?: string;
  readonly targetResourceType?: string;
  readonly transportRequestSchema: unknown;
  readonly transportResponseSchema: unknown;
}

export interface DataAccessExecutionServices<TPayload> {
  readonly context: OperationContext<TPayload>;
  readonly db: CoreDbExecutor;
}

export type DataAccessHandler<TPayload, TResponse> = (
  input: TPayload,
  services: DataAccessExecutionServices<TPayload>,
) => Promise<TResponse> | TResponse;

export interface DataAccessRegistration<TPayload, TResponse> {
  readonly descriptor: DataAccessDescriptor;
  readonly handler: DataAccessHandler<TPayload, TResponse>;
  readonly policyChecks?: readonly PolicyCheck<TPayload>[];
}

export interface OperationTransport {
  readonly headers: Headers;
}

export type OperationLogEntry = Readonly<Record<string, unknown>>;

export interface OperationLogger {
  readonly warn: (entry: OperationLogEntry) => void;
}

export type OperationContextResolver = (input: {
  readonly audience: string;
  readonly token: string | null | undefined;
}) => ResolveVerticalGatewayTokenResult;

export interface RunActionOptions {
  readonly authorizationChecker?: SpiceDbAuthorizationChecker;
  readonly logger?: OperationLogger;
  readonly operationContextResolver?: OperationContextResolver;
}

export interface ActionDomainRejection {
  readonly _tag: 'ActionDomainRejection';
  readonly code: string;
  readonly message: string;
}

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
  message: decision.message,
  policyKey: decision.policyKey,
  state: decision.state,
});

const executionFailed = (error: unknown): OperationExecutionFailed => ({
  _tag: 'OperationExecutionFailed',
  message: error instanceof Error ? error.message : 'Action execution failed.',
});

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const consoleOperationLogger: OperationLogger = {
  warn: (entry) => {
    console.warn(JSON.stringify(entry));
  },
};

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
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
    .join(',')}}`;
};

const requestHash = (payload: unknown) =>
  createHash('sha256').update(stableStringify(payload)).digest('hex');

const resolveContext = <TAction>({
  action,
  actionKey,
  audience,
  operationContextResolver,
  transport,
}: {
  readonly action: TAction;
  readonly actionKey: string;
  readonly audience: string;
  readonly operationContextResolver: OperationContextResolver;
  readonly transport: OperationTransport;
}): OperationContext<TAction> | CoreSDKError => {
  const result = operationContextResolver({
    audience,
    token: transport.headers.get('x-ontos-operation-context'),
  });

  if (result._tag === 'Success') {
    return {
      ...result.operationContext,
      action,
      actionKey,
      gatewayAudience: audience,
    };
  }

  return result.error._tag === 'VerticalGatewayTokenMissing'
    ? authRequired(result.error)
    : contextInvalid(result.error);
};

const validateActionActor = async <TAction>(
  context: OperationContext<TAction>,
): Promise<OperationContext<TAction> | OperationContextInvalid> => {
  const actor = await db
    .select({ principalId: principals.principalId })
    .from(principals)
    .where(
      and(
        eq(principals.principalId, context.principalId),
        eq(principals.tenantId, context.tenantId),
        eq(principals.status, 'active'),
      ),
    )
    .limit(1);

  return actor.length === 1
    ? context
    : {
        _tag: 'OperationContextInvalid',
        message: 'The operation Actor must be an active Principal in its tenant.',
      };
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

const claimFailedActionInvocationRetry = async <TAction>({
  context,
  actionInvocationId,
  idempotencyKey,
  requestHash: hash,
}: {
  readonly actionInvocationId: string;
  readonly context: OperationContext<TAction>;
  readonly idempotencyKey: string;
  readonly requestHash: string;
}): Promise<OperationContext<TAction> | OperationIdempotencyReplayUnavailable> => {
  const [claimed] = await db
    .update(actionInvocations)
    .set({
      completedAt: null,
      status: 'received',
    })
    .where(
      and(
        eq(actionInvocations.actionInvocationId, actionInvocationId),
        eq(actionInvocations.status, 'failed'),
      ),
    )
    .returning({ actionInvocationId: actionInvocations.actionInvocationId });

  return claimed === undefined
    ? replayUnavailable()
    : attachInvocation(context, {
        actionInvocationId: claimed.actionInvocationId,
        idempotencyKey,
        requestHash: hash,
        status: 'received',
      });
};

const resolveExistingActionInvocation = <TAction>({
  context,
  existing,
  idempotencyKey,
  requestHash: hash,
}: {
  readonly context: OperationContext<TAction>;
  readonly existing: NonNullable<Awaited<ReturnType<typeof findActionInvocation>>>;
  readonly idempotencyKey: string;
  readonly requestHash: string;
}): Promise<OperationContext<TAction> | CoreSDKError> => {
  if (existing.requestHash !== hash) {
    return Promise.resolve(idempotencyConflict());
  }

  if (existing.status === 'failed') {
    return claimFailedActionInvocationRetry({
      actionInvocationId: existing.actionInvocationId,
      context,
      idempotencyKey,
      requestHash: hash,
    });
  }

  return Promise.resolve(replayUnavailable());
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
      return resolveExistingActionInvocation({
        context,
        existing,
        idempotencyKey,
        requestHash: hash,
      });
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
    .onConflictDoNothing()
    .returning({
      actionInvocationId: actionInvocations.actionInvocationId,
    });

  if (inserted === undefined) {
    if (idempotencyKey !== undefined) {
      const existing = await findActionInvocation({
        actionKey: context.actionKey,
        idempotencyKey,
        principalId: context.principalId,
        tenantId: context.tenantId,
      });

      if (existing !== undefined) {
        return resolveExistingActionInvocation({
          context,
          existing,
          idempotencyKey,
          requestHash: hash,
        });
      }
    }

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
      eventType,
      evidenceJson: evidenceJson ?? {},
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
  eventPrefix,
  logger,
  requirement,
}: {
  readonly auditProfile: OperationAuditProfile;
  readonly authorizationChecker: SpiceDbAuthorizationChecker;
  readonly context: OperationContext<TAction>;
  readonly eventPrefix: 'action' | 'data_access';
  readonly logger: OperationLogger;
  readonly requirement: ActionAuthorizationRequirement | undefined;
}): Promise<OperationContext<TAction> | CoreSDKError> => {
  if (requirement === undefined) {
    return writeAuditEvent({
      auditProfile,
      context,
      eventType: `${eventPrefix}.authorization.skipped`,
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
      eventType: `${eventPrefix}.authorization.allowed`,
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
      eventType: `${eventPrefix}.authorization.denied`,
      outcome: 'denied',
      outcomeCode:
        authorization._tag === 'Unavailable'
          ? 'spicedb_authorization_unavailable'
          : 'spicedb_denied',
      outcomeStage: 'authz',
    });

    if ('_tag' in auditedContext) {
      logger.warn({
        actionKey: context.actionKey,
        message: auditedContext.message,
        principalId: context.principalId,
        tenantId: context.tenantId,
        type: 'authorization_denied_evidence_persistence_failed',
      });
    }
  } catch (error) {
    logger.warn({
      actionKey: context.actionKey,
      message: errorMessage(error),
      principalId: context.principalId,
      tenantId: context.tenantId,
      type: 'authorization_denied_evidence_persistence_failed',
    });
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
  logger,
  rejectInvocation,
}: {
  readonly accessKind: ModuleStateAccessKind | undefined;
  readonly auditProfile: OperationAuditProfile;
  readonly context: OperationContext<TAction>;
  readonly eventPrefix: 'action' | 'data_access';
  readonly logger: OperationLogger;
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

  logger.warn({
    accessKind: checked.accessKind,
    actionKey: context.actionKey,
    moduleKey: checked.moduleKey,
    outcomeCode: checked.outcomeCode,
    principalId: context.principalId,
    state: checked.state,
    tenantId: context.tenantId,
    type: 'module_state.denied',
  });

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
  db: policyDb,
  eventPrefix,
  policyChecks,
}: {
  readonly auditProfile: OperationAuditProfile;
  readonly context: OperationContext<TAction>;
  readonly db: CoreReadonlyDbExecutor;
  readonly eventPrefix: 'action' | 'data_access';
  readonly policyChecks: readonly PolicyCheck<TAction>[];
}): Promise<OperationContext<TAction> | CoreSDKError> => {
  let checkedContext = context;
  let deniedDecision: PolicyDenied | undefined;

  for (const policyCheck of policyChecks) {
    // Policy checks are ordered gates and must short-circuit on the first denial.
    // oxlint-disable-next-line no-await-in-loop
    const decision = await policyCheck({
      data: context.action,
      db: policyDb,
      operation: context,
    });

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
      eventType: `${eventPrefix}.policy.denied`,
      evidenceJson: {
        message: deniedDecision.message,
        policyKey: deniedDecision.policyKey,
        reason: deniedDecision.reason,
        state: deniedDecision.state,
      },
      outcome: 'denied',
      outcomeCode: deniedDecision.code,
      outcomeStage: 'policy',
    });

    return '_tag' in auditedContext ? auditedContext : policyDenied(deniedDecision);
  }

  return writeAuditEvent({
    auditProfile,
    context: checkedContext,
    eventType: `${eventPrefix}.policy.allowed`,
    outcome: 'allowed',
    outcomeCode: `${eventPrefix}_policies_allowed`,
    outcomeStage: 'policy',
  });
};

const persistDataAccessEvent = async <TPayload, TResponse>({
  context,
  descriptor,
  payload,
  response,
  resultCount,
}: {
  readonly context: OperationContext<TPayload>;
  readonly descriptor: DataAccessDescriptor;
  readonly payload: TPayload;
  readonly response: TResponse;
  readonly resultCount: (response: TResponse) => number;
}): Promise<OperationContext<TPayload> | CoreSDKError> => {
  const count = resultCount(response);
  const [inserted] = await db
    .insert(dataAccessEvents)
    .values({
      accessKind: descriptor.accessKind,
      authMethod: 'session',
      evidenceCaptureMode: descriptor.evidenceCaptureMode,
      evidencePolicyKey: descriptor.evidencePolicyKey,
      legalEntityId: context.legalEntityId,
      principalId: context.principalId,
      queryHash: requestHash(payload),
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

  return {
    ...context,
    dataAccessEvents: [
      ...(context.dataAccessEvents ?? []),
      {
        accessKind: descriptor.accessKind,
        dataAccessEventId: inserted.dataAccessEventId,
        evidenceCaptureMode: descriptor.evidenceCaptureMode,
        evidencePolicyKey: descriptor.evidencePolicyKey,
        queryHash: requestHash(payload),
        resultCount: count,
        servingModuleKey: descriptor.servingModuleKey,
      },
    ],
  };
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
  const logger = options.logger ?? consoleOperationLogger;
  const operationContextResolver = options.operationContextResolver ?? resolveVerticalGatewayToken;
  const context = resolveContext({
    action: payload,
    actionKey: descriptor.actionKey,
    audience: descriptor.gatewayAudience,
    operationContextResolver,
    transport,
  });

  if ('_tag' in context) {
    return context;
  }

  const actorValidatedContext = await validateActionActor(context);

  if ('_tag' in actorValidatedContext) {
    return actorValidatedContext;
  }

  const hash = requestHash(payload);
  const idempotencyKey = transport.headers.get('idempotency-key')?.trim() || undefined;
  const registeredContext = await registerActionInvocation({
    context: actorValidatedContext,
    idempotency: descriptor.idempotency,
    idempotencyKey,
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
    logger,
    rejectInvocation: true,
  });

  if ('_tag' in moduleStateCheckedContext) {
    return moduleStateCheckedContext;
  }

  const authorizedContext = await authorizeWithSpiceDb({
    auditProfile: descriptor.auditProfile,
    authorizationChecker: options.authorizationChecker ?? spiceDbAuthorizationChecker,
    context: moduleStateCheckedContext,
    eventPrefix: 'action',
    logger,
    requirement: descriptor.authorization,
  });

  if ('_tag' in authorizedContext) {
    return authorizedContext;
  }

  const policyCheckedContext = await evaluateActionPolicies({
    auditProfile: descriptor.auditProfile,
    context: authorizedContext,
    db,
    eventPrefix: 'action',
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

export const runDataAccess = async <TPayload, TResponse>({
  options = {},
  payload,
  registration,
  resultCount,
  transport,
}: {
  readonly options?: RunActionOptions;
  readonly payload: TPayload;
  readonly registration: DataAccessRegistration<TPayload, TResponse>;
  readonly resultCount: (response: TResponse) => number;
  readonly transport: OperationTransport;
}): Promise<OperationResult<TPayload, TResponse>> => {
  const { descriptor, handler } = registration;
  const logger = options.logger ?? consoleOperationLogger;
  const operationContextResolver = options.operationContextResolver ?? resolveVerticalGatewayToken;
  const context = resolveContext({
    action: payload,
    actionKey: descriptor.dataAccessKey,
    audience: descriptor.gatewayAudience,
    operationContextResolver,
    transport,
  });

  if ('_tag' in context) {
    return context;
  }

  const moduleStateCheckedContext = await enforceModuleStateGate({
    accessKind: descriptor.moduleStateAccess,
    auditProfile: descriptor.auditProfile,
    context,
    eventPrefix: 'data_access',
    logger,
    rejectInvocation: false,
  });

  if ('_tag' in moduleStateCheckedContext) {
    return moduleStateCheckedContext;
  }

  const authorizedContext = await authorizeWithSpiceDb({
    auditProfile: descriptor.auditProfile,
    authorizationChecker: options.authorizationChecker ?? spiceDbAuthorizationChecker,
    context: moduleStateCheckedContext,
    eventPrefix: 'data_access',
    logger,
    requirement: descriptor.authorization,
  });

  if ('_tag' in authorizedContext) {
    return authorizedContext;
  }

  const policyCheckedContext = await evaluateActionPolicies({
    auditProfile: descriptor.auditProfile,
    context: authorizedContext,
    db,
    eventPrefix: 'data_access',
    policyChecks: registration.policyChecks ?? [],
  });

  if ('_tag' in policyCheckedContext) {
    return policyCheckedContext;
  }

  try {
    const response = await handler(payload, {
      context: policyCheckedContext,
      db,
    });
    const evidencedContext = await persistDataAccessEvent({
      context: policyCheckedContext,
      descriptor,
      payload,
      response,
      resultCount,
    });

    if ('_tag' in evidencedContext) {
      return evidencedContext;
    }

    return {
      _tag: 'OperationSucceeded',
      context: evidencedContext,
      response,
    };
  } catch (error) {
    return executionFailed(error);
  }
};
