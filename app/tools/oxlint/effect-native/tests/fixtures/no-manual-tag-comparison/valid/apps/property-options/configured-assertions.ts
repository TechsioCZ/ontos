import { expect } from 'effect-rstest';
declare const error: unknown;
expect(error).toHaveProperty('_tag', 'Legacy');
expect(error).toHaveProperty('cause._tag', 'Legacy');
expect(error).toHaveProperty(['_tag'], 'Legacy');
