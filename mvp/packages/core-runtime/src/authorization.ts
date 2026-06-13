// @effect-diagnostics asyncFunction:off strictBooleanExpressions:off
import { readCoreRuntimeEnv } from './env.ts';
import type { CoreRuntimeEnv } from './env.ts';
import type { RuntimeContext } from './types.ts';

export type AuthorizationDecision =
  | {
      ok: true;
      authorization: 'allowed';
    }
  | {
      ok: false;
      authorization: 'denied' | 'unavailable';
      message: string;
    };

export interface ModuleWriteAuthorizationInput {
  context: RuntimeContext;
  moduleKey: string;
}

export interface ModuleActionAttemptAuthorizationInput {
  context: RuntimeContext;
  moduleKey: string;
}

export interface ResourceReadAuthorizationInput {
  context: RuntimeContext;
  resourceId: string;
}

export interface AuthorizationAdapter {
  checkModuleActionAttempt: (
    input: ModuleActionAttemptAuthorizationInput,
  ) => Promise<AuthorizationDecision>;
  checkModuleWrite: (input: ModuleWriteAuthorizationInput) => Promise<AuthorizationDecision>;
  checkResourceRead: (input: ResourceReadAuthorizationInput) => Promise<AuthorizationDecision>;
}

const isCallable = (value: unknown): value is (...args: unknown[]) => unknown =>
  typeof value === 'function';

const stringRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};

const permissionshipAllows = (value: unknown): boolean => {
  const text = String(value).toLowerCase();

  return text.includes('has_permission') || text === '2' || text === 'true';
};

const moduleObjectId = (tenantSlug: string, moduleKey: string): string =>
  `${tenantSlug}_${moduleKey.replaceAll('.', '-')}`;

interface SpiceDbPermissionInput {
  catchMessage: string;
  deniedMessage: string;
  env: CoreRuntimeEnv;
  permission: 'attempt_action' | 'read' | 'write';
  resourceObjectId: string;
  resourceObjectType: 'module' | 'protected_resource';
  subjectObjectId: string;
}

const checkSpiceDbPermission = async (
  input: SpiceDbPermissionInput,
): Promise<AuthorizationDecision> => {
  try {
    const authzed = stringRecord(await import('@authzed/authzed-node'));
    const v1 = stringRecord(authzed['v1']);
    const newClient = v1['NewClient'];

    if (!isCallable(newClient)) {
      return {
        authorization: 'unavailable',
        message: '@authzed/authzed-node did not expose v1.NewClient.',
        ok: false,
      };
    }

    const security = stringRecord(v1['ClientSecurity']);
    const insecure = input.env.spiceDbInsecure
      ? security['INSECURE_LOCALHOST_ALLOWED']
      : security['SECURE'];
    const client = stringRecord(
      newClient(input.env.spiceDbPresharedKey, input.env.spiceDbEndpoint, insecure),
    );
    const promises = stringRecord(client['promises']);
    const checkPermission = promises['checkPermission'] ?? client['checkPermission'];

    if (!isCallable(checkPermission)) {
      return {
        authorization: 'unavailable',
        message: '@authzed/authzed-node client did not expose checkPermission.',
        ok: false,
      };
    }

    const response = stringRecord(
      await checkPermission.call(client, {
        permission: input.permission,
        resource: {
          objectId: input.resourceObjectId,
          objectType: input.resourceObjectType,
        },
        subject: {
          object: {
            objectId: input.subjectObjectId,
            objectType: 'user',
          },
        },
      }),
    );

    if (permissionshipAllows(response['permissionship'])) {
      return {
        authorization: 'allowed',
        ok: true,
      };
    }

    return {
      authorization: 'denied',
      message: input.deniedMessage,
      ok: false,
    };
  } catch (error) {
    return {
      authorization: 'unavailable',
      message: error instanceof Error ? error.message : input.catchMessage,
      ok: false,
    };
  }
};

export const createSpiceDbAuthorizationAdapter = (
  env: CoreRuntimeEnv = readCoreRuntimeEnv(),
): AuthorizationAdapter => ({
  checkModuleActionAttempt(input) {
    return checkSpiceDbPermission({
      catchMessage: 'SpiceDB action affordance check failed closed.',
      deniedMessage: `SpiceDB denied attempt_action on '${input.moduleKey}' for '${input.context.principal.displayName}'.`,
      env,
      permission: 'attempt_action',
      resourceObjectId: moduleObjectId(input.context.tenant.slug, input.moduleKey),
      resourceObjectType: 'module',
      subjectObjectId: input.context.principal.providerSubjectId,
    });
  },
  checkModuleWrite(input) {
    return checkSpiceDbPermission({
      catchMessage: 'SpiceDB authorization check failed closed.',
      deniedMessage: `SpiceDB denied write on '${input.moduleKey}' for '${input.context.principal.displayName}'.`,
      env,
      permission: 'write',
      resourceObjectId: moduleObjectId(input.context.tenant.slug, input.moduleKey),
      resourceObjectType: 'module',
      subjectObjectId: input.context.principal.providerSubjectId,
    });
  },
  checkResourceRead(input) {
    return checkSpiceDbPermission({
      catchMessage: 'SpiceDB read authorization check failed closed.',
      deniedMessage: `SpiceDB denied read on '${input.resourceId}' for '${input.context.principal.displayName}'.`,
      env,
      permission: 'read',
      resourceObjectId: input.resourceId,
      resourceObjectType: 'protected_resource',
      subjectObjectId: input.context.principal.providerSubjectId,
    });
  },
});

export const spiceDbAuthorizationAdapter = createSpiceDbAuthorizationAdapter();
