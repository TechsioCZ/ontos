// JSX, generic arrows, satisfies and casts around non-credential names: parse-only smoke test.
import { Schema } from 'effect';

export const PublicSchema = Schema.Struct({
  apiKeyId: Schema.String,
  passwordPolicy: Schema.String,
  searchKey: Schema.String,
  secretRef: Schema.String,
}) satisfies unknown;

export const Badge = <T,>(props: { readonly label: T; readonly keyId: string }): unknown => (
  <span data-key={props.keyId}>{String(props.label)}</span>
);
