// expect-count: 5
import * as Effect from 'effect';
import { pipe, Schema as S } from 'effect';

export const DatabasePassword = Effect.Config.string('SPICEDB_PRESHARED_KEY');
export const AuthSecret = Effect.Config.nonEmptyString('BETTER_AUTH_SECRET');
export const DatabaseUrl = Effect.Config.string('DATABASE_ADMIN_URL');

export const CredentialSchema = S.Struct({
  credential: pipe(S.String, S.check(S.isMinLength(1))),
  label: S.String,
});

export const Badge = (props: { readonly apiKey: string }): unknown => props;
