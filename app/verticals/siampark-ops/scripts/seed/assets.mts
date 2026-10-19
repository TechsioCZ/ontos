// Seed of agenda `assets` for Siampark (legal entity …0021). OWNED BY THE `assets` LANE.
// Return the ENCODED state (ISO strings for dates, plain ids). It is validated against AssetsStateSchema.
// Use fixed ids/timestamps (e.g. demoId from scripts/demo/fixture-ids.mts) so reseeds are deterministic.
import { emptyAssetsState } from '../../shared/domain/assets.ts';
import type { AssetsStateEncoded } from '../../shared/domain/assets.ts';

export const seedAssetsState = (): AssetsStateEncoded => emptyAssetsState;
