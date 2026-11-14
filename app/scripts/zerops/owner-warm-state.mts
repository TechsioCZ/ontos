import { Schema } from 'effect';
import { roundMillis } from './runtime-observability-model.mts';

export interface RenderBundleSample {
  readonly durationMs: number;
  readonly filepath: string;
  readonly outcome: 'loaded' | 'failed';
  readonly triggerPath: string;
}

declare global {
  /** The patched Node render adapter reports actual imports, never asset or API guesses. */
  var ontosRenderBundleObserver: ((sample: RenderBundleSample) => void) | undefined;
  var ontosOwnerRequestObserver: ((directory: string, pathname: string) => (() => void) | undefined) | undefined;
}

export const createOwnerWarmState = () => {
  const owners = new Map<
    string,
    {
      firstReadAt?: number;
      firstReadDurationMs?: number;
      firstRequestAt?: number;
      firstRequestDurationMs?: number;
      firstRequestPath?: string;
      requests: number;
      ssrBundleFailures: number;
      ssrBundleLoads: number;
      ssrBundleTotalMs: number;
    }
  >();
  const register = (owner: string) => {
    let state = owners.get(owner);
    if (state === undefined) {
      state = { requests: 0, ssrBundleFailures: 0, ssrBundleLoads: 0, ssrBundleTotalMs: 0 };
      owners.set(owner, state);
    }
    return state;
  };
  return {
    bundle: (owner: string, sample: RenderBundleSample) => {
      const state = register(owner);
      state.ssrBundleLoads += sample.outcome === 'loaded' ? 1 : 0;
      state.ssrBundleFailures += sample.outcome === 'failed' ? 1 : 0;
      state.ssrBundleTotalMs += sample.durationMs;
    },
    register,
    request: (owner: string, pathname: string, at: number) => {
      const state = register(owner);
      state.requests += 1;
      const firstRead = state.firstReadAt === undefined && /\/(?:reads\/|native-render)/u.test(pathname);
      if (firstRead) {
        state.firstReadAt = at;
      }
      if (state.firstRequestAt !== undefined) {
        return firstRead
          ? (durationMs: number) => {
              state.firstReadDurationMs = roundMillis(durationMs);
            }
          : undefined;
      }
      state.firstRequestAt = at;
      const [path] = pathname.split('?');
      state.firstRequestPath = path;
      return (durationMs: number) => {
        state.firstRequestDurationMs = roundMillis(durationMs);
        if (firstRead) {
          state.firstReadDurationMs = roundMillis(durationMs);
        }
      };
    },
    snapshot: () =>
      [...owners].map(([owner, state]) => ({
        owner,
        ...state,
        ssrBundleTotalMs: roundMillis(state.ssrBundleTotalMs),
      })),
  };
};

/** State is local to each hosted process, shared only by its infrastructure driver. */
export const ownerWarmState = createOwnerWarmState();

export const OwnerWarmStateSchema = Schema.Array(
  Schema.Struct({
    firstReadAt: Schema.optionalKey(Schema.Number),
    firstReadDurationMs: Schema.optionalKey(Schema.Number),
    firstRequestAt: Schema.optionalKey(Schema.Number),
    firstRequestDurationMs: Schema.optionalKey(Schema.Number),
    firstRequestPath: Schema.optionalKey(Schema.String),
    owner: Schema.String,
    requests: Schema.Number,
    ssrBundleFailures: Schema.Number,
    ssrBundleLoads: Schema.Number,
    ssrBundleTotalMs: Schema.Number,
  }),
);
