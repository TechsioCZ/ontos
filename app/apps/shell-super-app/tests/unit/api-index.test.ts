import { HttpServerResponse } from '@modern-js/plugin-bff/effect-edge';
import { expect, test } from 'effect-rstest';

import { noStoreResponse } from '../../api/index.ts';

test('marks freshly issued API-key responses as non-cacheable', () => {
  const response = noStoreResponse(HttpServerResponse.empty());

  expect(response.headers['cache-control']).toBe('no-store');
});
