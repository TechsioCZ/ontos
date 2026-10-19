// Seed of agenda `agenda` for Siampark (legal entity …0021). OWNED BY THE `agenda` LANE.
// Return the ENCODED state (ISO strings for dates, plain ids). It is validated against AgendaStateSchema.
// Use fixed ids/timestamps (e.g. demoId from scripts/demo/fixture-ids.mts) so reseeds are deterministic.
import { emptyAgendaState } from '../../shared/domain/agenda.ts';
import type { AgendaStateEncoded } from '../../shared/domain/agenda.ts';

export const seedAgendaState = (): AgendaStateEncoded => emptyAgendaState;
