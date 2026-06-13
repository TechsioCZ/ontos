// @effect-diagnostics asyncFunction:off
import { Schema } from '@modern-js/plugin-bff/effect-client';
import { spiceDbAuthorizationAdapter } from './authorization.ts';
import type { AuthorizationAdapter } from './authorization.ts';
import { coreDb } from './db/client.ts';
import type { CoreDb } from './db/client.ts';
import { resolveRuntimeContextResult } from './context.ts';
import { checkModuleWriteState } from './module-state.ts';
import { evaluateWritePolicy, policyDeniedResult } from './policy.ts';
import type { RuntimeContext, RuntimeContextInput, SerializableFailureCode } from './types.ts';

export interface RuntimeActionDescriptor {
  readonly auditProfile?: 'minimal' | 'standard' | 'sensitive';
  readonly key: string;
  readonly label: string;
  readonly requestSchema: unknown;
  readonly responseSchema: unknown;
  readonly targetModuleId: string;
  readonly writesCanonicalRows: boolean;
}

export interface RuntimeActionRegistration {
  readonly handlers: Readonly<Record<string, unknown>>;
  readonly manifest: {
    readonly actions: readonly RuntimeActionDescriptor[];
    readonly moduleId: string;
  };
}

export interface RuntimeActionHandlerInput<TPayload> {
  readonly action: RuntimeActionDescriptor;
  readonly context: RuntimeContext;
  readonly db: CoreDb;
  readonly payload: TPayload;
}

export type RuntimeActionHandler<TPayload = unknown, TResult = unknown> = (
  input: RuntimeActionHandlerInput<TPayload>,
) => Promise<TResult> | TResult;

export type ExecuteActionResult =
  | {
      ok: true;
      actionKey: string;
      result: unknown;
    }
  | {
      ok: false;
      actionKey: string;
      code: SerializableFailureCode | 'action_not_found' | 'validation_failed';
      message: string;
      stage:
        | 'authorization'
        | 'context'
        | 'handler'
        | 'module-state'
        | 'policy'
        | 'registry'
        | 'validation';
    };

export interface ExecuteActionInput extends RuntimeContextInput {
  actionKey: string;
  authorizationAdapter?: AuthorizationAdapter;
  db?: CoreDb;
  payload: unknown;
  registrations: readonly RuntimeActionRegistration[];
}

export type ActionAttemptCapabilityResult =
  | {
      ok: true;
      actionKey: string;
      allowed: true;
      moduleId: string;
      reason: string;
    }
  | {
      ok: false;
      actionKey: string;
      allowed: false;
      moduleId?: string;
      reason: string;
      stage: 'context' | 'registry' | 'spicedb';
    };

const findActionRegistration = (
  registrations: readonly RuntimeActionRegistration[],
  actionKey: string,
) => {
  for (const registration of registrations) {
    const action = registration.manifest.actions.find((item) => item.key === actionKey);

    if (action !== undefined) {
      return {
        action,
        handler: registration.handlers[actionKey],
      };
    }
  }

  return null;
};

const toHandler = (handler: unknown): RuntimeActionHandler | null =>
  typeof handler === 'function' ? (handler as RuntimeActionHandler) : null;

type PayloadValidationResult =
  | {
      ok: true;
      payload: unknown;
    }
  | Extract<ExecuteActionResult, { ok: false }>;

const validatePayload = (
  action: RuntimeActionDescriptor,
  payload: unknown,
): PayloadValidationResult => {
  try {
    return {
      ok: true,
      payload: Schema.decodeUnknownSync(action.requestSchema as never)(payload),
    };
  } catch (error) {
    return {
      actionKey: action.key,
      code: 'validation_failed',
      message: error instanceof Error ? error.message : 'Action payload failed Effect Schema.',
      ok: false,
      stage: 'validation',
    };
  }
};

export const checkActionAttemptCapability = async (
  input: Omit<ExecuteActionInput, 'payload'>,
): Promise<ActionAttemptCapabilityResult> => {
  const found = findActionRegistration(input.registrations, input.actionKey);

  if (found === null) {
    return {
      actionKey: input.actionKey,
      allowed: false,
      ok: false,
      reason: `Action '${input.actionKey}' is not registered.`,
      stage: 'registry',
    };
  }

  const contextResult = await resolveRuntimeContextResult(input);

  if (!contextResult.ok) {
    return {
      actionKey: input.actionKey,
      allowed: false,
      moduleId: found.action.targetModuleId,
      ok: false,
      reason: contextResult.message,
      stage: 'context',
    };
  }

  const adapter = input.authorizationAdapter ?? spiceDbAuthorizationAdapter;
  const authorization = await adapter.checkModuleActionAttempt({
    context: contextResult.context,
    moduleKey: found.action.targetModuleId,
  });

  if (!authorization.ok) {
    return {
      actionKey: input.actionKey,
      allowed: false,
      moduleId: found.action.targetModuleId,
      ok: false,
      reason: authorization.message,
      stage: 'spicedb',
    };
  }

  return {
    actionKey: input.actionKey,
    allowed: true,
    moduleId: found.action.targetModuleId,
    ok: true,
    reason: 'SpiceDB attempt_action allowed.',
  };
};

export const executeAction = async (input: ExecuteActionInput): Promise<ExecuteActionResult> => {
  const found = findActionRegistration(input.registrations, input.actionKey);

  if (found === null) {
    return {
      actionKey: input.actionKey,
      code: 'action_not_found',
      message: `Action '${input.actionKey}' is not registered.`,
      ok: false,
      stage: 'registry',
    };
  }

  const handler = toHandler(found.handler);

  if (handler === null) {
    return {
      actionKey: input.actionKey,
      code: 'action_not_found',
      message: `Action '${input.actionKey}' has no private runtime handler.`,
      ok: false,
      stage: 'registry',
    };
  }

  const contextResult = await resolveRuntimeContextResult(input, input.db ?? coreDb);

  if (!contextResult.ok) {
    return {
      actionKey: input.actionKey,
      code: contextResult.code,
      message: contextResult.message,
      ok: false,
      stage: 'context',
    };
  }

  const moduleState = checkModuleWriteState(contextResult.context, found.action.targetModuleId);

  if (!moduleState.ok) {
    return {
      actionKey: input.actionKey,
      code: moduleState.code,
      message: moduleState.message,
      ok: false,
      stage: 'module-state',
    };
  }

  const adapter = input.authorizationAdapter ?? spiceDbAuthorizationAdapter;
  const authorization = await adapter.checkModuleWrite({
    context: contextResult.context,
    moduleKey: found.action.targetModuleId,
  });

  if (!authorization.ok) {
    return {
      actionKey: input.actionKey,
      code: 'authorization_denied',
      message: authorization.message,
      ok: false,
      stage: 'authorization',
    };
  }

  const policy = evaluateWritePolicy({
    context: contextResult.context,
    moduleKey: found.action.targetModuleId,
  });

  if (!policy.ok) {
    const failure = policyDeniedResult(
      {
        context: contextResult.context,
        moduleKey: found.action.targetModuleId,
      },
      policy.message,
    ) as Extract<ReturnType<typeof policyDeniedResult>, { ok: false }>;

    return {
      actionKey: input.actionKey,
      code: failure.code,
      message: failure.message,
      ok: false,
      stage: 'policy',
    };
  }

  const payloadResult = validatePayload(found.action, input.payload);

  if (!payloadResult.ok) {
    return payloadResult;
  }

  try {
    return {
      actionKey: found.action.key,
      ok: true,
      result: await handler({
        action: found.action,
        context: contextResult.context,
        db: input.db ?? coreDb,
        payload: payloadResult.payload,
      }),
    };
  } catch (error) {
    return {
      actionKey: found.action.key,
      code: 'runtime_error',
      message: error instanceof Error ? error.message : 'Action handler failed.',
      ok: false,
      stage: 'handler',
    };
  }
};
