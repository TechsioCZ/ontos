import { expect, it } from 'effect-rstest';

import {
  paymentTermCatalogCorsAllowedHeaders,
  paymentTermCatalogCorsAllowedMethods,
  paymentTermCatalogCorsAllowedOrigins,
  resolvePaymentTermCatalogShellOrigin,
} from '../../api/runtime-support.ts';

it('restricts BFF CORS to the configured Shell origin and its local loopback peer', () => {
  expect(resolvePaymentTermCatalogShellOrigin(undefined)).toBe('http://localhost:3020');
  expect(paymentTermCatalogCorsAllowedOrigins('http://127.0.0.1:3020')).toEqual([
    'http://localhost:3020',
    'http://127.0.0.1:3020',
  ]);
  expect(paymentTermCatalogCorsAllowedOrigins('https://shell.example.test/path')).toEqual([
    'https://shell.example.test',
  ]);
  expect(paymentTermCatalogCorsAllowedHeaders).toContain('Authorization');
  expect(paymentTermCatalogCorsAllowedMethods).toContain('POST');
});
