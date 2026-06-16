import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  Schema,
} from '@modern-js/plugin-bff/effect-client';

export const authContextSchema = Schema.Struct({
  authBindingId: Schema.String,
  legalEntity: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
  }),
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

export type AuthContextResponse = typeof authContextResponseSchema.Type;
export type DemoUserKey = 'admin' | 'user';

export const shellAuthEffectApi = HttpApi.make('ShellAuthEffectApi').add(
  HttpApiGroup.make('auth')
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
    ),
);
