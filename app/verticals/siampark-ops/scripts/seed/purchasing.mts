// Seed of agenda `purchasing` for Siampark (legal entity …0021). OWNED BY THE `purchasing` LANE.
// Return the ENCODED state (ISO strings for dates, plain ids). It is validated against PurchasingStateSchema.
// Use fixed ids/timestamps (e.g. demoId from scripts/demo/fixture-ids.mts) so reseeds are deterministic.
import { emptyPurchasingState } from '../../shared/domain/purchasing.ts';
import type { PurchasingStateEncoded } from '../../shared/domain/purchasing.ts';

export const seedPurchasingState = (): PurchasingStateEncoded => emptyPurchasingState;
