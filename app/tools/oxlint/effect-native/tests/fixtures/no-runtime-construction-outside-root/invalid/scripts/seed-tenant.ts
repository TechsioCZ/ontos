// expect-count: 1
// A top-level `scripts/*.ts` entry point is its own process host (audit D tier: "one small
// process-exit adapter at the executable edge"), so its *first* ManagedRuntime is allowed. The second
// runtime construction in the same process is still a finding.
import { Effect, Layer, ManagedRuntime } from 'effect';

declare const seedLayer: Layer.Layer<never>;
declare const reportLayer: Layer.Layer<never>;

const runtime = ManagedRuntime.make(seedLayer);
const reporting = ManagedRuntime.make(reportLayer);

void runtime.runPromise(Effect.void);
void reporting.runPromise(Effect.void);
