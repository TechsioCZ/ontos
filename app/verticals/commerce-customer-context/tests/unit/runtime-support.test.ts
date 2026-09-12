import { expect, it } from 'effect-rstest';

import {
  commerceCustomerContextCorsAllowedHeaders,
  commerceCustomerContextCorsAllowedMethods,
  commerceCustomerContextCorsAllowedOrigins,
  resolveCommerceCustomerContextShellOrigin,
} from '../../api/runtime-support.ts';

it('restricts BFF CORS to the configured Shell origin and its local loopback peer', () => {
  expect(resolveCommerceCustomerContextShellOrigin()).toBe('http://localhost:3020');
  expect(commerceCustomerContextCorsAllowedOrigins('http://localhost:3020')).toEqual([
    'http://localhost:3020',
    'http://127.0.0.1:3020',
  ]);
  expect(commerceCustomerContextCorsAllowedOrigins('https://shell.example.test/path')).toEqual([
    'https://shell.example.test',
  ]);
  expect(commerceCustomerContextCorsAllowedHeaders).toContain('Authorization');
  expect(commerceCustomerContextCorsAllowedMethods).toContain('POST');
});
