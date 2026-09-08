// A locally defined `pipe` is not Effect's `pipe`, so the point-free form must not resolve.
import { Schema } from 'effect';

const pipe = <A, B>(value: A, next: (value: A) => B): B => next(value);

export const CredentialSchema = Schema.Struct({
  password: pipe(Schema.String, (schema) => schema),
});
