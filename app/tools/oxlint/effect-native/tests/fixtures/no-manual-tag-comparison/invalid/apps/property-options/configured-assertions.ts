// expect-count: 2
import { expect } from '@app/effect-rstest';
declare const error: unknown;
expect(error).toHaveProperty('_tag');
expect(error).toHaveProperty('_tag', 'Missing');
