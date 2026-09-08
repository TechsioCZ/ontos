// expect-count: 3
import { make } from "effect/ManagedRuntime";
import { Layer } from "effect";
import { type Logger } from "effect/Logger";
import { type Tracer } from "effect/Tracer";
// Inline type-only specifiers cannot count as runtime observability evidence.
export const runtime = make(Layer.empty);
export type Evidence = Logger<unknown, unknown> | Tracer;
