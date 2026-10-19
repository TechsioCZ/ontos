// Seed of agenda `security` for Siampark (legal entity …0021). OWNED BY THE `security` LANE.
// Return the ENCODED state (ISO strings for dates, plain ids). It is validated against SecurityStateSchema.
// Use fixed ids/timestamps (e.g. demoId from scripts/demo/fixture-ids.mts) so reseeds are deterministic.
import { emptySecurityState } from '../../shared/domain/security.ts';
import type { SecurityStateEncoded } from '../../shared/domain/security.ts';

export const seedSecurityState = (): SecurityStateEncoded => emptySecurityState;
