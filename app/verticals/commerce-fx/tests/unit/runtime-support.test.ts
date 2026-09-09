import { expect, it } from 'effect-rstest';

import {
  commerceFxCorsAllowedHeaders,
  commerceFxCorsAllowedMethods,
  commerceFxCorsAllowedOrigins,
  resolveCommerceFxShellOrigin,
} from '../../api/runtime-support.ts';

it('restricts BFF CORS to the configured Shell origin and its local loopback peer', () => {
  expect(resolveCommerceFxShellOrigin(undefined)).toBe('http://localhost:3020');
  expect(commerceFxCorsAllowedOrigins('http://localhost:3020')).toEqual([
    'http://localhost:3020',
    'http://127.0.0.1:3020',
  ]);
  expect(commerceFxCorsAllowedOrigins('https://shell.example.test/path')).toEqual([
    'https://shell.example.test',
  ]);
  expect(commerceFxCorsAllowedHeaders).toContain('Authorization');
  expect(commerceFxCorsAllowedMethods).toContain('POST');
});
