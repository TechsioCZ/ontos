import { Effect, Result, Schema } from 'effect';
import { browserRuntime } from '../runtime/browser-effect-runtime.ts';
import { DashboardPreferencesSchema, dashboardPreferencesKey, defaultDashboardPreferences } from './dashboard-model.ts';
import type { DashboardContext, DashboardPreferences } from './dashboard-model.ts';

class DashboardStorageUnavailable extends Schema.TaggedError<DashboardStorageUnavailable>()(
  'DashboardStorageUnavailable',
  { cause: Schema.Defect() },
) {}
const serializedPreferences = Schema.fromJsonString(DashboardPreferencesSchema);
export const decodeDashboardPreferences = (value: string | null): DashboardPreferences => {
  if (value === null) {
    return defaultDashboardPreferences;
  }
  const result = Schema.decodeResult(serializedPreferences)(value);
  return Result.isSuccess(result)
    ? { ...result.success, metrics: [...new Set(result.success.metrics)] }
    : defaultDashboardPreferences;
};
export interface DashboardPreferenceSnapshot {
  readonly preferences: DashboardPreferences;
  readonly storageAvailable: boolean;
  readonly storageError?: DashboardStorageUnavailable;
}
export const createDashboardPreferences = (
  context: DashboardContext,
  getStorage: () => Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = () => window.localStorage,
) => {
  const key = dashboardPreferencesKey(context);
  const initial: DashboardPreferenceSnapshot = { preferences: defaultDashboardPreferences, storageAvailable: true };
  let snapshot = initial;
  let started = false;
  const listeners = new Set<() => void>();
  const publish = (next: DashboardPreferenceSnapshot) => {
    snapshot = next;
    for (const listener of listeners) {
      listener();
    }
  };
  const access = <A>(read: () => A) =>
    Effect.try({ catch: (cause) => new DashboardStorageUnavailable({ cause }), try: read });
  const set = (preferences: DashboardPreferences, reset = false) =>
    browserRuntime.runSync(
      Schema.encodeEffect(serializedPreferences)(preferences).pipe(
        Effect.mapError((cause) => new DashboardStorageUnavailable({ cause })),
        Effect.flatMap((serialized) =>
          access(() => {
            const storage = getStorage();
            if (reset) {
              storage.removeItem(key);
            } else {
              storage.setItem(key, serialized);
            }
          }),
        ),
        Effect.matchEffect({
          onFailure: (storageError) =>
            Effect.sync(() => publish({ preferences, storageAvailable: false, storageError })),
          onSuccess: () => Effect.sync(() => publish({ preferences, storageAvailable: true })),
        }),
      ),
    );
  return {
    getServerSnapshot: () => initial,
    getSnapshot: () => snapshot,
    reset: () => set(defaultDashboardPreferences, true),
    set,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      if (!started) {
        started = true;
        browserRuntime.runSync(
          access(() => decodeDashboardPreferences(getStorage().getItem(key))).pipe(
            Effect.matchEffect({
              onFailure: (storageError) =>
                Effect.sync(() =>
                  publish({ preferences: defaultDashboardPreferences, storageAvailable: false, storageError }),
                ),
              onSuccess: (preferences) => Effect.sync(() => publish({ preferences, storageAvailable: true })),
            }),
          ),
        );
      }
      return () => {
        listeners.delete(listener);
      };
    },
  };
};
