// expect-count: 1
import { Layer } from 'effect';

declare const TestLive: Layer.Layer<never>;

// Tests are in scope too: the audit blesses no `Layer.fresh` shape anywhere.
export const isolated = Layer.fresh(TestLive);
