// expect-count: 4
// Aliased import, computed member access, optional chaining and point-free `pipe` usage.
import { pipe, Schema as S } from 'effect';

const ManifestDocument = S['Json'];
const RemoteEntries = S.Record(S.String, S.Json);

export const decodeManifest = (raw: unknown) => S.decodeUnknownResult(ManifestDocument)(raw);

export const decodeRemotes = (raw: unknown) => pipe(raw, S.decodeUnknownResult(RemoteEntries));

export const ManifestPanel = ({ raw }: { readonly raw: unknown }) => (
  <div className="manifest">{String(decodeManifest(raw))}</div>
);
