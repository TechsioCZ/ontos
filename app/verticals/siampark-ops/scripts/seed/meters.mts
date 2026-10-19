// Seed of agenda `meters` for Siampark (legal entity …0021). OWNED BY THE `meters` LANE.
// Return the ENCODED state (ISO strings for dates, plain ids). It is validated against MetersStateSchema.
// Use fixed ids/timestamps (e.g. demoId from scripts/demo/fixture-ids.mts) so reseeds are deterministic.
import { emptyMetersState } from '../../shared/domain/meters.ts';
import type { MetersStateEncoded } from '../../shared/domain/meters.ts';

export const seedMetersState = (): MetersStateEncoded => emptyMetersState;
