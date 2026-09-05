// expect-count: 3
// TSX: generic arrow, JSX with template literals, object-form `Schema.Record`, `pipe` point-free.
import { pipe, Schema as S } from 'effect';

const LocalOverlayDocument = S.Record({ key: S.String, value: S.Json });

export const decodeOverlay = <T,>(raw: T) => pipe(raw, S.decodeUnknownResult(LocalOverlayDocument));

export const ManifestBadge = ({ raw }: { readonly raw: unknown }) => {
  const parsed = S.decodeUnknownSync(S.NullishOr(S.Json))(raw);
  return <span data-json={`${String(parsed)}`}>{String(parsed)}</span>;
};
