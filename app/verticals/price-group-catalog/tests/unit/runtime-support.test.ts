import { expect, it } from 'effect-rstest';

import {
  priceGroupCatalogCorsAllowedHeaders,
  priceGroupCatalogCorsAllowedMethods,
  priceGroupCatalogCorsAllowedOrigins,
  resolvePriceGroupCatalogShellOrigin,
} from '../../api/runtime-support.ts';

it('restricts BFF CORS to the configured Shell origin and its local loopback peer', () => {
  expect(resolvePriceGroupCatalogShellOrigin()).toBe('http://localhost:3020');
  expect(priceGroupCatalogCorsAllowedOrigins('http://127.0.0.1:3020')).toEqual([
    'http://localhost:3020',
    'http://127.0.0.1:3020',
  ]);
  expect(priceGroupCatalogCorsAllowedOrigins('https://shell.example.test/path')).toEqual([
    'https://shell.example.test',
  ]);
  expect(priceGroupCatalogCorsAllowedHeaders).toContain('Authorization');
  expect(priceGroupCatalogCorsAllowedHeaders).toContain('X-Correlation-Id');
  expect(priceGroupCatalogCorsAllowedMethods).toContain('GET');
  expect(priceGroupCatalogCorsAllowedMethods).toContain('POST');
});
