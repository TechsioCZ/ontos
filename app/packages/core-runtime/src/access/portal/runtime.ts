import { Effect, Layer, Schedule } from 'effect';

import type { OperationalScope } from '../../operations/context.ts';
import type { AccessProjectionWriteError } from '../intent/projection-write-error.ts';
import { AccessProjectionWriter } from '../intent/projection-writer.ts';
import { accessPortalRefusal } from './portal-access.ts';
import { AccessPortalProjection } from './portal-projection.ts';

/*
 * The portal services of a module process: the projection over the process's single writer, and the
 * admissions Core commits in transactions of its own (`portal-admissions.ts`). Both leave their requirements
 * open, so the composition root that opens the engine transport and the database closes the graph once.
 */

/** Two reconciles of one tenant serialize on its fence; the one that lost waits and runs again. */
const fenceContention = Schedule.exponential('50 millis').pipe(Schedule.upTo({ times: 5 }));

const projectionFailure = (failure: AccessProjectionWriteError) =>
  accessPortalRefusal('access_portal_unavailable', `${failure.code}: ${failure.reason}`, failure);

export const AccessPortalProjectionLive: Layer.Layer<AccessPortalProjection, never, AccessProjectionWriter> =
  Layer.effect(
    AccessPortalProjection,
    AccessProjectionWriter.pipe(
      Effect.map((writer) =>
        Object.freeze({
          project: (scope: OperationalScope) =>
            writer.reconcileTenant({ scope }).pipe(
              Effect.retry({
                schedule: fenceContention,
                while: (failure) => failure.code === 'access_projection_write_fence_refused',
              }),
              Effect.mapError(projectionFailure),
              Effect.asVoid,
            ),
        }),
      ),
    ),
  );

export { AccessPortalAdmissions, AccessPortalAdmissionsLive } from './portal-admissions.ts';
export type { AccessPortalAdmissionsService } from './portal-admissions.ts';
