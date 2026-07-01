import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  Schema,
} from '@modern-js/plugin-bff/effect-client';
import { installedModuleKeys, moduleActivationStates } from '@mvp2/shared-contracts';

const httpStatusAnnotation = Symbol.for('@effect/platform/HttpApiSchema/AnnotationStatus');

const httpStatus =
  (status: number) =>
  <TSchema extends { annotate: (annotations: Record<symbol, unknown>) => TSchema }>(
    schema: TSchema,
  ): TSchema =>
    schema.annotate({ [httpStatusAnnotation]: status }) as TSchema;

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

type SignInPayload = typeof signInPayloadSchema.Type;

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
).pipe(httpStatus(401));

export type AuthContextResponse = typeof authContextResponseSchema.Type;
export type DemoUserKey = SignInPayload['demoUserKey'];
export type OperationContextAuthRequired = typeof operationContextAuthRequiredSchema.Type;
export type SetModuleStatePayload = typeof setModuleStatePayloadSchema.Type;

export const moduleStateAdminForbiddenSchema = Schema.TaggedStruct('ModuleStateAdminForbidden', {
  message: Schema.String,
}).pipe(httpStatus(403));

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
]);

const authGroup = HttpApiGroup.make('auth')
  .add(
    HttpApiEndpoint.get('context', '/auth/context', {
      success: authContextResponseSchema,
    }),
  )
  .add(
    HttpApiEndpoint.post('signIn', '/auth/sign-in', {
      payload: signInPayloadSchema,
      success: authContextResponseSchema,
    }),
  )
  .add(
    HttpApiEndpoint.post('signOut', '/auth/sign-out', {
      success: authContextResponseSchema,
    }),
  )
  .add(
    HttpApiEndpoint.post('setModuleState', '/core/modules/state', {
      error: moduleStateAdminErrorSchema,
      payload: setModuleStatePayloadSchema,
      success: authContextResponseSchema,
    }),
  );

export const shellAuthEffectApi = HttpApi.make('ShellAuthEffectApi').add(authGroup);
