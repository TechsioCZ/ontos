// expect-count: 1
// Evasion: deep `effect/**/Schema` submodule namespace import under an alias.
import * as S from 'effect/unstable/schema/Schema';

export const Publication = S.Literals(['draft', 'published']);
export const Row = S.Struct({ state: S.Literals(['published', 'draft']) });
