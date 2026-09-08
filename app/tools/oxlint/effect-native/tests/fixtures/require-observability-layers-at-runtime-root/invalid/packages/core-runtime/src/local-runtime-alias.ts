// expect-count: 3
import { ManagedRuntime, Layer } from "effect";
const Runtime = ManagedRuntime;
const { make: create } = Runtime;
export const runtime = create(Layer.empty);
