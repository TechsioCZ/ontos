import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
  Schema,
} from '@modern-js/plugin-bff/effect-client';
import { installedModuleKeys, moduleActivationStates } from '@mvp2/shared-contracts';

export const moduleActivationStateSchema = Schema.Literals(moduleActivationStates);

export const installedModuleKeySchema = Schema.Literals(installedModuleKeys);

export const tenantModuleStateSchema = Schema.Struct({
  moduleKey: installedModuleKeySchema,
  state: moduleActivationStateSchema,
});

export const moduleStateAdminCapabilitySchema = Schema.Struct({
  canChange: Schema.Boolean,
  canView: Schema.Boolean,
});

export const authContextSchema = Schema.Struct({
  authBindingId: Schema.String,
  legalEntity: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
  }),
  moduleStateAdmin: moduleStateAdminCapabilitySchema,
  moduleStates: Schema.Array(tenantModuleStateSchema),
  principal: Schema.Struct({
    displayName: Schema.String,
    id: Schema.String,
  }),
  tenant: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
  }),
  user: Schema.Struct({
    email: Schema.String,
    id: Schema.String,
    name: Schema.String,
  }),
});

export const authContextResponseSchema = Schema.Struct({
  context: Schema.Union([authContextSchema, Schema.Null]),
});

export const signInPayloadSchema = Schema.Struct({
  demoUserKey: Schema.Union([Schema.Literal('admin'), Schema.Literal('user')]),
});

export const setModuleStatePayloadSchema = Schema.Struct({
  moduleKey: installedModuleKeySchema,
  reason: Schema.optional(Schema.String),
  state: moduleActivationStateSchema,
});

export const operationContextAuthRequiredSchema = Schema.TaggedStruct(
  'OperationContextAuthRequired',
  {
    message: Schema.String,
  },
).pipe(HttpApiSchema.status(401));

export type AuthContextResponse = typeof authContextResponseSchema.Type;
export type DemoUserKey = 'admin' | 'user';
export type OperationContextAuthRequired = typeof operationContextAuthRequiredSchema.Type;
export type SetModuleStatePayload = typeof setModuleStatePayloadSchema.Type;

export const moduleStateAdminForbiddenSchema = Schema.TaggedStruct('ModuleStateAdminForbidden', {
  message: Schema.String,
}).pipe(HttpApiSchema.status(403));

export type ModuleStateAdminForbidden = typeof moduleStateAdminForbiddenSchema.Type;

export const createOperationContextAuthRequired = (
  message: string,
): OperationContextAuthRequired => ({
  _tag: 'OperationContextAuthRequired',
  message,
});

export const createModuleStateAdminForbidden = (message: string): ModuleStateAdminForbidden => ({
  _tag: 'ModuleStateAdminForbidden',
  message,
});

export const moduleStateAdminErrorSchema = Schema.Union([
  operationContextAuthRequiredSchema,
  moduleStateAdminForbiddenSchema,
]).pipe(HttpApiSchema.status(403));

const authGroup = HttpApiGroup.make('auth')
  .add(
    HttpApiEndpoint.get('context', '/effect/auth/context', {
      success: authContextResponseSchema,
    }),
  )
  .add(
    HttpApiEndpoint.post('signIn', '/effect/auth/sign-in', {
      payload: signInPayloadSchema,
      success: authContextResponseSchema,
    }),
  )
  .add(
    HttpApiEndpoint.post('signOut', '/effect/auth/sign-out', {
      success: authContextResponseSchema,
    }),
  )
  .add(
    HttpApiEndpoint.post('setModuleState', '/effect/core/modules/state', {
      error: moduleStateAdminErrorSchema,
      payload: setModuleStatePayloadSchema,
      success: authContextResponseSchema,
    }),
  );

export const shellAuthEffectApi = HttpApi.make('ShellAuthEffectApi').add(authGroup);
