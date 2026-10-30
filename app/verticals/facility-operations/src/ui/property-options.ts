// Nájempark property/unit options for any agenda form, read through property-portfolio's public records client
// (governed read, its own gateway audience). Stored on records as an opaque PropertyRef + display snapshot.
import { executeRecords as executePropertyRecords } from '@app/property-portfolio/clients/records';
import { Effect } from 'effect';
import { useEffect, useState } from 'react';
import type { PropertyRef } from '../../shared/domain/common.ts';
import { browserRuntime } from '../runtime/browser-effect-runtime.ts';

export interface PropertyOption {
  readonly ref: PropertyRef;
  /** Select value: `<kind>:<id>`. */
  readonly value: string;
}

export type PropertyOptionsState =
  | { readonly status: 'loading' }
  | { readonly error: Effect.Error<ReturnType<typeof executePropertyRecords>>; readonly status: 'failed' }
  | { readonly options: readonly PropertyOption[]; readonly status: 'ready' };

const option = (kind: PropertyRef['kind'], id: string, label: string): PropertyOption => ({
  ref: { id, kind, label },
  value: `${kind}:${id}`,
});

/** Loads properties and their units once per mount. A failure leaves free-text location entry available. */
export const usePropertyOptions = (): PropertyOptionsState => {
  const [state, setState] = useState<PropertyOptionsState>({ status: 'loading' });
  useEffect(() => {
    let alive = true;
    void browserRuntime.runPromise(
      executePropertyRecords({}, 'facility-operations.property-options').pipe(
        Effect.match({
          onFailure: (error): PropertyOptionsState => ({ error, status: 'failed' }),
          onSuccess: (response): PropertyOptionsState => {
            const names = new Map(response.properties.map((entry) => [entry.propertyRef.resourceId, entry.name]));
            return {
              options: [
                ...response.properties.map((entry) =>
                  option('property', entry.propertyRef.resourceId, `${entry.name} (${entry.code})`),
                ),
                ...response.units.map((entry) =>
                  option(
                    'unit',
                    entry.unitRef.resourceId,
                    `${names.get(entry.propertyRef.resourceId) ?? ''} › ${entry.name} (${entry.code})`.trim(),
                  ),
                ),
              ],
              status: 'ready',
            };
          },
        }),
        Effect.tap((next) =>
          Effect.sync(() => {
            if (alive) {
              setState(next);
            }
          }),
        ),
      ),
    );
    return () => {
      alive = false;
    };
  }, []);
  return state;
};
