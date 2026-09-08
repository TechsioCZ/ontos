// expect-count: 3
// Evasion: `keyName` bails on every computed key, even a plain string literal — although the
// sibling `memberName` deliberately resolves `Schema["String"]` the same way.
import { Schema } from 'effect';

export interface AuthConfigValue {
  readonly ['secret']: string;
}

export const SignInPayloadSchema = Schema.Struct({
  ['password']: Schema.String,
});

export class RuntimeCredentials {
  ['apiKey']: string = '';
}

export const Panel = (): unknown => <span>{String(SignInPayloadSchema)}</span>;
