// oxlint-disable no-barrel-file
// @effect-diagnostics asyncFunction:off
import { auth } from './auth/better-auth.config.ts';
import { checkActionAttemptCapability, executeAction } from './action-runtime.ts';
import type { RuntimeActionRegistration } from './action-runtime.ts';
import { spiceDbAuthorizationAdapter } from './authorization.ts';
import type { AuthorizationAdapter } from './authorization.ts';
import { resolveRuntimeContextResult } from './context.ts';
import { checkModuleWriteState } from './module-state.ts';
import { evaluateReadPolicy, evaluateWritePolicy, policyDeniedResult } from './policy.ts';
import type { PolicyInput } from './policy.ts';
import type { RuntimeContextInput, SerializableGateResult } from './types.ts';

export * from './authorization.ts';
export * from './action-runtime.ts';
export * from './context.ts';
export type { CoreDb } from './db/client.ts';
export { propertyBuildings, propertyProperties, propertyUnits } from './db/schema.ts';
export type { PropertyUnitInsert } from './db/schema.ts';
export * from './module-state.ts';
export * from './policy.ts';
export type * from './types.ts';

export interface ProbeModuleWriteGateInput extends RuntimeContextInput {
  moduleKey: string;
  policyKey?: string;
  forcePolicyDeny?: boolean;
  authorizationAdapter?: AuthorizationAdapter;
}

export const probeModuleWriteGate = async (
  input: ProbeModuleWriteGateInput,
): Promise<SerializableGateResult> => {
  const contextResult = await resolveRuntimeContextResult(input);

  if (!contextResult.ok) {
    return {
      code: contextResult.code,
      message: contextResult.message,
      moduleKey: input.moduleKey,
      ok: false,
    };
  }

  const moduleStateResult = checkModuleWriteState(contextResult.context, input.moduleKey);

  if (!moduleStateResult.ok) {
    return moduleStateResult;
  }

  const adapter = input.authorizationAdapter ?? spiceDbAuthorizationAdapter;
  const authorization = await adapter.checkModuleWrite({
    context: contextResult.context,
    moduleKey: input.moduleKey,
  });

  if (!authorization.ok) {
    return {
      authorization: authorization.authorization,
      code: 'authorization_denied',
      message: authorization.message,
      moduleKey: input.moduleKey,
      moduleState: moduleStateResult.moduleState.state,
      ok: false,
      principalId: contextResult.context.principal.principalId,
      tenantSlug: contextResult.context.tenant.slug,
    };
  }

  const policyInput: PolicyInput = {
    context: contextResult.context,
    moduleKey: input.moduleKey,
    ...(input.policyKey === undefined ? {} : { policyKey: input.policyKey }),
    ...(input.forcePolicyDeny === undefined ? {} : { forceDeny: input.forcePolicyDeny }),
  };
  const policy = evaluateWritePolicy(policyInput);

  if (!policy.ok) {
    return policyDeniedResult(policyInput, policy.message);
  }

  return {
    authorization: 'allowed',
    moduleKey: input.moduleKey,
    moduleState: moduleStateResult.moduleState.state,
    ok: true,
    policy: 'allowed',
    principalId: contextResult.context.principal.principalId,
    tenantSlug: contextResult.context.tenant.slug,
  };
};

export type DemoUserKey = 'demo-admin-a' | 'demo-viewer-a' | 'demo-admin-b';

export interface Day3DemoUserRequest {
  demoUserKey: DemoUserKey;
}

export interface Day3ModuleGateRequest {
  moduleId: string;
  tenantId: string;
}

export interface Day3PolicyGateRequest extends Day3ModuleGateRequest {
  policyKey: string;
}

export interface Day3ProtectedResourceReadRequest {
  resourceId: 'resource-a' | 'resource-b' | 'resource-c';
}

const demoProviderSubjects: Record<DemoUserKey, string> = {
  'demo-admin-a': 'ba-user-demo-admin-a',
  'demo-admin-b': 'ba-user-demo-admin-b',
  'demo-viewer-a': 'ba-user-demo-viewer-a',
};

const demoUserEmails: Record<DemoUserKey, string> = {
  'demo-admin-a': 'demo-admin-a@example.test',
  'demo-admin-b': 'demo-admin-b@example.test',
  'demo-viewer-a': 'demo-viewer-a@example.test',
};

const demoUserPasswords: Record<DemoUserKey, string> = {
  'demo-admin-a': 'ontos-demo-password',
  'demo-admin-b': 'ontos-demo-password',
  'demo-viewer-a': 'ontos-demo-password',
};

const demoUserKeyForProviderSubject = (providerSubjectId: string): DemoUserKey => {
  if (providerSubjectId === 'ba-user-demo-admin-b') {
    return 'demo-admin-b';
  }

  if (providerSubjectId === 'ba-user-demo-viewer-a') {
    return 'demo-viewer-a';
  }

  return 'demo-admin-a';
};

const contextFailure = (message: string) => ({
  betterAuthUser: {
    email: 'unresolved@example.test',
    id: 'unresolved',
    name: message,
  },
  legalEntity: {
    displayName: 'unresolved',
    id: 'unresolved',
    tenantId: 'unresolved',
  },
  moduleStates: [],
  principal: {
    id: 'unresolved',
    kind: 'human',
    tenantId: 'unresolved',
  },
  tenant: {
    displayName: 'unresolved',
    id: 'unresolved',
  },
});

interface BetterAuthUserSummary {
  id: string;
  email: string;
  name: string;
}

interface AuthenticatedRuntimeContextInput {
  headers: Headers;
  tenantSlug?: string;
}

const getBetterAuthSession = async (headers: Headers) => {
  const session = await auth.api.getSession({
    headers,
  });

  if (session === null) {
    throw new Error('Better Auth session is required for this request.');
  }

  return session;
};

const collectSetCookieHeaders = (headers: Headers): string[] => {
  const { getSetCookie } = headers as Headers & { getSetCookie?: () => string[] };

  if (typeof getSetCookie === 'function') {
    return getSetCookie.call(headers);
  }

  const setCookie = headers.get('set-cookie');
  return setCookie === null ? [] : [setCookie];
};

const betterAuthUserFromSession = (session: Awaited<ReturnType<typeof getBetterAuthSession>>) => ({
  email: session.user.email,
  id: session.user.id,
  name: session.user.name,
});

const betterAuthErrorMessage = async (response: Response): Promise<string> => {
  const fallback = `Better Auth sign-in failed with HTTP ${response.status}.`;

  try {
    const body = (await response.json()) as {
      error?: string;
      message?: string;
    };

    return body.message ?? body.error ?? fallback;
  } catch {
    return fallback;
  }
};

const resolveAuthenticatedContext = async (input: AuthenticatedRuntimeContextInput) => {
  const session = await getBetterAuthSession(input.headers);
  const context = await resolveRuntimeContextResult({
    authContextRef: `better-auth:session:${session.session.id}`,
    providerSubjectId: session.user.id,
    ...(input.tenantSlug === undefined ? {} : { tenantSlug: input.tenantSlug }),
  });

  return {
    context,
    user: betterAuthUserFromSession(session),
  };
};

const toDay3Context = (
  context: Awaited<ReturnType<typeof resolveRuntimeContextResult>>,
  betterAuthUser?: BetterAuthUserSummary,
) => {
  if (!context.ok) {
    return contextFailure(context.message);
  }

  const demoUserKey = demoUserKeyForProviderSubject(context.context.principal.providerSubjectId);

  return {
    betterAuthUser: {
      email: betterAuthUser?.email ?? demoUserEmails[demoUserKey],
      id: context.context.principal.providerSubjectId,
      name: betterAuthUser?.name ?? context.context.principal.displayName,
    },
    legalEntity: {
      displayName: context.context.legalEntity.legalName,
      id: context.context.legalEntity.legalEntityId,
      tenantId: context.context.tenant.slug,
    },
    moduleStates: context.context.moduleStates.map((moduleState) => ({
      moduleId: moduleState.moduleKey,
      state: moduleState.state,
      tenantId: context.context.tenant.slug,
    })),
    principal: {
      id: context.context.principal.principalId,
      kind: context.context.principal.kind,
      tenantId: context.context.tenant.slug,
    },
    tenant: {
      displayName: context.context.tenant.name,
      id: context.context.tenant.slug,
    },
  };
};

export const signInDemoUser = async (request: Day3DemoUserRequest) => {
  const authResponse = await auth.api.signInEmail({
    asResponse: true,
    body: {
      email: demoUserEmails[request.demoUserKey],
      password: demoUserPasswords[request.demoUserKey],
      rememberMe: true,
    },
  });

  if (!authResponse.ok) {
    throw new Error(await betterAuthErrorMessage(authResponse));
  }

  const setCookieHeaders = collectSetCookieHeaders(authResponse.headers);

  if (setCookieHeaders.length === 0) {
    throw new Error('Better Auth sign-in did not issue a session cookie.');
  }

  const responseBody = (await authResponse.json()) as {
    user?: BetterAuthUserSummary;
  };
  const betterAuthUser = responseBody.user ?? {
    email: demoUserEmails[request.demoUserKey],
    id: demoProviderSubjects[request.demoUserKey],
    name: request.demoUserKey,
  };

  return {
    body: {
      context: toDay3Context(
        await resolveRuntimeContextResult({
          authContextRef: `better-auth:user:${betterAuthUser.id}`,
          providerSubjectId: betterAuthUser.id,
          tenantSlug: request.demoUserKey === 'demo-admin-b' ? 'tenant-b' : 'tenant-a',
        }),
        betterAuthUser,
      ),
      didWriteRuntimeRows: false as const,
      signedIn: true as const,
    },
    setCookieHeaders,
  };
};

export const signOutDemoUser = async (request: { headers: Headers }) => {
  const authResponse = await auth.api.signOut({
    asResponse: true,
    headers: request.headers,
  });

  return {
    body: {
      didWriteRuntimeRows: false as const,
      signedIn: false as const,
    },
    setCookieHeaders: collectSetCookieHeaders(authResponse.headers),
  };
};

export const getCurrentRuntimeContext = async (request: { headers: Headers }) => {
  const result = await resolveAuthenticatedContext({ headers: request.headers });

  return {
    context: toDay3Context(result.context, result.user),
    didWriteRuntimeRows: false as const,
  };
};

export const checkModuleWritePermission = async (
  request: Day3ModuleGateRequest & { headers: Headers },
) => {
  const session = await getBetterAuthSession(request.headers);
  const result = await probeModuleWriteGate({
    moduleKey: request.moduleId,
    providerSubjectId: session.user.id,
    tenantSlug: request.tenantId,
  });

  return {
    decision: {
      allowed: result.ok,
      moduleId: request.moduleId,
      reason: result.ok ? 'SpiceDB write permission allowed.' : result.message,
      stage: 'authorization',
      tenantId: request.tenantId,
    },
    didWriteRuntimeRows: false as const,
  };
};

export const checkActionAttemptCapabilityForSession = async (request: {
  actionKey: string;
  headers: Headers;
  registrations: readonly RuntimeActionRegistration[];
}) => {
  const session = await getBetterAuthSession(request.headers);
  const result = await checkActionAttemptCapability({
    actionKey: request.actionKey,
    providerSubjectId: session.user.id,
    registrations: request.registrations,
  });

  return {
    capability: result,
    didWriteRuntimeRows: false as const,
  };
};

export const executeActionForSession = async (request: {
  actionKey: string;
  headers: Headers;
  payload: unknown;
  registrations: readonly RuntimeActionRegistration[];
}) => {
  const session = await getBetterAuthSession(request.headers);
  const result = await executeAction({
    actionKey: request.actionKey,
    authContextRef: `better-auth:session:${session.session.id}`,
    payload: request.payload,
    providerSubjectId: session.user.id,
    registrations: request.registrations,
  });

  return {
    didWriteRuntimeRows: false as const,
    result,
  };
};

export const checkModuleStateGate = async (
  request: Day3ModuleGateRequest & { headers: Headers },
) => {
  const { context } = await resolveAuthenticatedContext({
    headers: request.headers,
    tenantSlug: request.tenantId,
  });
  const currentState = context.ok
    ? (context.context.moduleStates.find(
        (moduleState) => moduleState.moduleKey === request.moduleId,
      )?.state ?? 'inactive')
    : 'inactive';

  return {
    currentState,
    decision: {
      allowed: currentState === 'active',
      moduleId: request.moduleId,
      reason:
        currentState === 'active'
          ? 'Persisted module state permits write probes.'
          : `Persisted module state ${currentState} blocks write probes.`,
      stage: 'module-state',
      tenantId: request.tenantId,
    },
    didWriteRuntimeRows: false as const,
  };
};

export const checkPolicyGate = async (request: Day3PolicyGateRequest & { headers: Headers }) => {
  const session = await getBetterAuthSession(request.headers);
  const result = await probeModuleWriteGate({
    forcePolicyDeny: request.policyKey === 'demo.deny' || request.policyKey === 'deny',
    moduleKey: request.moduleId,
    policyKey: request.policyKey,
    providerSubjectId: session.user.id,
    tenantSlug: request.tenantId,
  });

  return {
    decision: {
      allowed: result.ok,
      moduleId: request.moduleId,
      reason: result.ok ? 'Policy gate allowed.' : result.message,
      stage: 'policy',
      tenantId: request.tenantId,
    },
    didWriteRuntimeRows: false as const,
    policyKey: request.policyKey,
  };
};

export const checkProtectedResourceRead = async (
  request: Day3ProtectedResourceReadRequest & { headers: Headers },
) => {
  const { context: contextResult } = await resolveAuthenticatedContext({
    headers: request.headers,
  });
  const demoUserKey = contextResult.ok
    ? demoUserKeyForProviderSubject(contextResult.context.principal.providerSubjectId)
    : 'demo-admin-a';

  if (!contextResult.ok) {
    return {
      decision: {
        allowed: false,
        reason: contextResult.message,
        resourceId: request.resourceId,
        stage: 'context',
        userId: demoUserKey,
      },
      didWriteRuntimeRows: false as const,
    };
  }

  const authorization = await spiceDbAuthorizationAdapter.checkResourceRead({
    context: contextResult.context,
    resourceId: request.resourceId,
  });

  if (!authorization.ok) {
    return {
      decision: {
        allowed: false,
        reason: authorization.message,
        resourceId: request.resourceId,
        stage: 'spicedb',
        userId: demoUserKey,
      },
      didWriteRuntimeRows: false as const,
    };
  }

  const policy = evaluateReadPolicy({
    context: contextResult.context,
    policyKey:
      demoUserKey === 'demo-viewer-a' && request.resourceId === 'resource-c'
        ? 'demo.read.deny'
        : 'demo.read.allow',
    resourceId: request.resourceId,
  });

  if (!policy.ok) {
    return {
      decision: {
        allowed: false,
        reason: policy.message,
        resourceId: request.resourceId,
        stage: 'policy',
        userId: demoUserKey,
      },
      didWriteRuntimeRows: false as const,
    };
  }

  return {
    decision: {
      allowed: true,
      reason: `SpiceDB and policy allowed '${demoUserKey}' to read '${request.resourceId}'.`,
      resourceId: request.resourceId,
      stage: 'allowed',
      userId: demoUserKey,
    },
    didWriteRuntimeRows: false as const,
  };
};
