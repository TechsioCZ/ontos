import { Config, Redacted, Schema } from 'effect';

// Already the Effect-native target shape.
export interface AuthConfigValue {
  readonly connectionString: Redacted.Redacted<string>;
  readonly issuer: string;
  readonly preSharedKey: Redacted.Redacted<string>;
  readonly privateJwk: Redacted.Redacted<string>;
}

export const AuthSecret = Config.Redacted('BETTER_AUTH_SECRET');
export const SpiceDbKey = Config.Redacted('SPICEDB_PRESHARED_KEY');

export const CredentialSchema = Schema.Struct({
  clientSecret: Schema.Redacted(Schema.String),
  password: Schema.Redacted(Schema.NonEmptyString),
});

export const sign = (signingKey: Redacted.Redacted<string>): string => Redacted.value(signingKey);
