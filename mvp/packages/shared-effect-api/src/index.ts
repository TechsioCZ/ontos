import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  Schema,
} from '@modern-js/plugin-bff/effect-client';

export const demoUserKeySchema = Schema.Union([
  Schema.Union([Schema.Literal('demo-admin-a'), Schema.Literal('demo-viewer-a')]),
  Schema.Literal('demo-admin-b'),
]);

export const moduleActivationStateSchema = Schema.String;

export const gateDecisionSchema = Schema.Struct({
  allowed: Schema.Boolean,
  moduleId: Schema.String,
  reason: Schema.String,
  stage: Schema.String,
  tenantId: Schema.String,
});

export const protectedResourceReadDecisionSchema = Schema.Struct({
  allowed: Schema.Boolean,
  reason: Schema.String,
  resourceId: Schema.String,
  stage: Schema.String,
  userId: Schema.String,
});

export const betterAuthUserSummarySchema = Schema.Struct({
  email: Schema.String,
  id: Schema.String,
  name: Schema.String,
});

export const ontosPrincipalSummarySchema = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  tenantId: Schema.String,
});

export const tenantSummarySchema = Schema.Struct({
  displayName: Schema.String,
  id: Schema.String,
});

export const legalEntitySummarySchema = Schema.Struct({
  displayName: Schema.String,
  id: Schema.String,
  tenantId: Schema.String,
});

export const runtimeModuleStateSchema = Schema.Struct({
  moduleId: Schema.String,
  state: moduleActivationStateSchema,
  tenantId: Schema.String,
});

export const runtimeContextSchema = Schema.Struct({
  betterAuthUser: betterAuthUserSummarySchema,
  legalEntity: legalEntitySummarySchema,
  moduleStates: Schema.Array(runtimeModuleStateSchema),
  principal: ontosPrincipalSummarySchema,
  tenant: tenantSummarySchema,
});

export const signInDemoUserRequestSchema = Schema.Struct({
  demoUserKey: demoUserKeySchema,
});

export const signOutDemoUserRequestSchema = Schema.Struct({});

export const moduleGateRequestSchema = Schema.Struct({
  moduleId: Schema.String,
  tenantId: Schema.String,
});

export const policyGateRequestSchema = Schema.Struct({
  moduleId: Schema.String,
  policyKey: Schema.String,
  tenantId: Schema.String,
});

export const protectedResourceReadRequestSchema = Schema.Struct({
  resourceId: Schema.Union([
    Schema.Literal('resource-a'),
    Schema.Literal('resource-b'),
    Schema.Literal('resource-c'),
  ]),
});

export const signInDemoUserResponseSchema = Schema.Struct({
  context: runtimeContextSchema,
  didWriteRuntimeRows: Schema.Literal(false),
  signedIn: Schema.Literal(true),
});

export const signOutDemoUserResponseSchema = Schema.Struct({
  didWriteRuntimeRows: Schema.Literal(false),
  signedIn: Schema.Literal(false),
});

export const getCurrentRuntimeContextResponseSchema = Schema.Struct({
  context: runtimeContextSchema,
  didWriteRuntimeRows: Schema.Literal(false),
});

export const checkModuleWritePermissionResponseSchema = Schema.Struct({
  decision: gateDecisionSchema,
  didWriteRuntimeRows: Schema.Literal(false),
});

export const checkModuleStateGateResponseSchema = Schema.Struct({
  currentState: moduleActivationStateSchema,
  decision: gateDecisionSchema,
  didWriteRuntimeRows: Schema.Literal(false),
});

export const checkPolicyGateResponseSchema = Schema.Struct({
  decision: gateDecisionSchema,
  didWriteRuntimeRows: Schema.Literal(false),
  policyKey: Schema.String,
});

export const checkProtectedResourceReadResponseSchema = Schema.Struct({
  decision: protectedResourceReadDecisionSchema,
  didWriteRuntimeRows: Schema.Literal(false),
});

export type DemoUserKey = 'demo-admin-a' | 'demo-viewer-a' | 'demo-admin-b';
export type RuntimeContext = typeof runtimeContextSchema.Type;
export type ModuleGateRequest = typeof moduleGateRequestSchema.Type;
export type PolicyGateRequest = typeof policyGateRequestSchema.Type;
export type ProtectedResourceReadRequest = typeof protectedResourceReadRequestSchema.Type;

export interface OperationContext {
  method: string;
  operationId: string;
  routePath: string;
  source: string;
}

export const day3ShellEffectApi = HttpApi.make('Day3ShellEffectApi').add(
  HttpApiGroup.make('day3Runtime')
    .add(
      HttpApiEndpoint.post('signInDemoUser', '/effect/day3/sign-in-demo-user', {
        payload: signInDemoUserRequestSchema,
        success: signInDemoUserResponseSchema,
      }),
    )
    .add(
      HttpApiEndpoint.post('signOutDemoUser', '/effect/day3/sign-out-demo-user', {
        payload: signOutDemoUserRequestSchema,
        success: signOutDemoUserResponseSchema,
      }),
    )
    .add(
      HttpApiEndpoint.get('getCurrentRuntimeContext', '/effect/day3/runtime-context', {
        success: getCurrentRuntimeContextResponseSchema,
      }),
    )
    .add(
      HttpApiEndpoint.post(
        'checkModuleWritePermission',
        '/effect/day3/check-module-write-permission',
        {
          payload: moduleGateRequestSchema,
          success: checkModuleWritePermissionResponseSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.post('checkModuleStateGate', '/effect/day3/check-module-state-gate', {
        payload: moduleGateRequestSchema,
        success: checkModuleStateGateResponseSchema,
      }),
    )
    .add(
      HttpApiEndpoint.post('checkPolicyGate', '/effect/day3/check-policy-gate', {
        payload: policyGateRequestSchema,
        success: checkPolicyGateResponseSchema,
      }),
    )
    .add(
      HttpApiEndpoint.post(
        'checkProtectedResourceRead',
        '/effect/day3/check-protected-resource-read',
        {
          payload: protectedResourceReadRequestSchema,
          success: checkProtectedResourceReadResponseSchema,
        },
      ),
    ),
);

export const day3ShellOperationContexts = {
  checkModuleStateGate: {
    method: 'POST',
    operationId: 'Day3ShellEffectApi:day3Runtime:checkModuleStateGate',
    routePath: '/effect/day3/check-module-state-gate',
    source: 'shell-day3-runtime-panel',
  },
  checkModuleWritePermission: {
    method: 'POST',
    operationId: 'Day3ShellEffectApi:day3Runtime:checkModuleWritePermission',
    routePath: '/effect/day3/check-module-write-permission',
    source: 'shell-day3-runtime-panel',
  },
  checkPolicyGate: {
    method: 'POST',
    operationId: 'Day3ShellEffectApi:day3Runtime:checkPolicyGate',
    routePath: '/effect/day3/check-policy-gate',
    source: 'shell-day3-runtime-panel',
  },
  checkProtectedResourceRead: {
    method: 'POST',
    operationId: 'Day3ShellEffectApi:day3Runtime:checkProtectedResourceRead',
    routePath: '/effect/day3/check-protected-resource-read',
    source: 'shell-day3-runtime-panel',
  },
  getCurrentRuntimeContext: {
    method: 'GET',
    operationId: 'Day3ShellEffectApi:day3Runtime:getCurrentRuntimeContext',
    routePath: '/effect/day3/runtime-context',
    source: 'shell-day3-runtime-panel',
  },
  signInDemoUser: {
    method: 'POST',
    operationId: 'Day3ShellEffectApi:day3Runtime:signInDemoUser',
    routePath: '/effect/day3/sign-in-demo-user',
    source: 'shell-day3-runtime-panel',
  },
  signOutDemoUser: {
    method: 'POST',
    operationId: 'Day3ShellEffectApi:day3Runtime:signOutDemoUser',
    routePath: '/effect/day3/sign-out-demo-user',
    source: 'shell-day3-runtime-panel',
  },
} satisfies Record<string, OperationContext>;

export const day3ShellApiContract = {
  apiPrefix: '/shell-super-app-api',
  basePath: '/shell-super-app-api/effect/day3',
  ownerId: 'shell-super-app',
} as const;
