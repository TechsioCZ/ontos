// Test files legitimately run on the default logger and no exporter (includeTests = false).
import { Layer, ManagedRuntime } from 'effect';

declare const testLayer: Layer.Layer<never>;

export const testRuntime = ManagedRuntime.make(testLayer);
