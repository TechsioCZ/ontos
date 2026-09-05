// expect-count: 3
import { Schema as S } from 'effect';

// Aliased import, computed member access and optional chaining are the same decode.
const FormSchema = S.Struct({
  note: S.NullOr(S.String),
  archivedAt: S['NullOr'](S.String),
});

const wrap = S.UndefinedOr;

export function Page() {
  return <pre>{JSON.stringify({ FormSchema, wrap })}</pre>;
}
