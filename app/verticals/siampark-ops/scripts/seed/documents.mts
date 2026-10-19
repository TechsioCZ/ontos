// Seed of agenda `documents` for Siampark (legal entity …0021). OWNED BY THE `documents` LANE.
// Return the ENCODED state (ISO strings for dates, plain ids). It is validated against DocumentsStateSchema.
// Use fixed ids/timestamps (e.g. demoId from scripts/demo/fixture-ids.mts) so reseeds are deterministic.
import { emptyDocumentsState } from '../../shared/domain/documents.ts';
import type { DocumentsStateEncoded } from '../../shared/domain/documents.ts';

export const seedDocumentsState = (): DocumentsStateEncoded => emptyDocumentsState;
