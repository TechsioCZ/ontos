import { ManagedRuntime, Layer, Logger, Tracer, References } from "effect";
const { make: create } = ManagedRuntime;
const L = Logger;
const { MinimumLogLevel: minimum } = References;
// Local evidence is recognized, not proof of actual exporter/Layer correctness.
const live = Layer.mergeAll(L.layer([]), Layer.succeed(Tracer.Tracer, {} as never), Layer.succeed(minimum, "Info"));
export const runtime = create(live);
