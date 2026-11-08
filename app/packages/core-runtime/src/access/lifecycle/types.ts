import { Schema } from 'effect';

const accessEntityId = Schema.String.check(Schema.isUUID());

/** Core table identity of one module installation row (`installation` in the engine schema). */
export const InstallationIdSchema = accessEntityId.pipe(Schema.brand('AccessInstallationId'));
/** Engine `team` row identity. Team membership is authority and ends with the member. */
export const TeamIdSchema = accessEntityId.pipe(Schema.brand('AccessTeamId'));
/** A record in the lifecycle ledger (assignment, grant, adoption, proposal, delegation, connection). */
export const LifecycleRecordIdSchema = accessEntityId.pipe(Schema.brand('AccessLifecycleRecordId'));
