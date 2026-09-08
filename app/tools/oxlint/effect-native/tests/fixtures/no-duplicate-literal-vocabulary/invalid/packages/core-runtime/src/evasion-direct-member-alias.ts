// expect-count: 2
// Evasion: the factory itself is imported and renamed, so no `Schema.` prefix appears.
import { Literals as Vocab, Struct } from 'effect/Schema';

export const Create = Struct({ tier: Vocab(['free', 'pro', 'enterprise']) });
export const Update = Struct({ tier: Vocab(['enterprise', 'free', 'pro']) });
export const Read = Struct({ tier: Vocab(['pro', 'enterprise', 'free']) });
