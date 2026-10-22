import type { ActionPrepareContext } from '@app/core-runtime';
import { ReadRuntime } from '@app/core-runtime';
import { Effect } from 'effect';

import { ManufacturerActionError } from '../../shared/actions/manufacturer-mutations.ts';
import type { SetProductManufacturerPayload } from '../../shared/actions/manufacturer-mutations.ts';
import { ManufacturerPersistenceUnavailable } from '../persistence/manufacturer-persistence.ts';
import { manufacturerTargetResolverForCoreRead } from '../persistence/manufacturer-target-resolver.ts';

/** Party HTTP and Core's governed Legal Entity Read both run before the Catalog write transaction. */
export const prepareManufacturerActionTarget = Effect.fn('ManufacturerAction.prepareTarget')(
  function* prepareManufacturerActionTarget(payload: SetProductManufacturerPayload, context: ActionPrepareContext) {
    if (payload.subject.tenantId !== context.scope.tenantId) {
      return yield* new ManufacturerActionError({
        code: 'manufacturer_invalid',
        reason: 'Manufacturer relation subject must belong to the trusted Tenant',
      });
    }
    const readRuntime = yield* ReadRuntime;
    return yield* manufacturerTargetResolverForCoreRead(readRuntime, context.scope)
      .resolve(payload.target, { requestId: context.scope.correlationId, tenantId: context.scope.tenantId })
      .pipe(
        Effect.catchTags({
          ManufacturerTargetAbsent: () =>
            Effect.fail(new ManufacturerActionError({ code: 'manufacturer_not_found', reason: 'not_found' })),
          ManufacturerTargetInvalid: () =>
            Effect.fail(new ManufacturerActionError({ code: 'manufacturer_invalid', reason: 'invalid_change' })),
          ManufacturerTargetUnavailable: (cause) =>
            Effect.fail(
              Object.assign(
                new ManufacturerPersistenceUnavailable({
                  code: 'manufacturer_persistence_unavailable',
                  reason: 'Manufacturer relation or authoritative owner read is unavailable',
                }),
                { cause },
              ),
            ),
        }),
      );
  },
);
