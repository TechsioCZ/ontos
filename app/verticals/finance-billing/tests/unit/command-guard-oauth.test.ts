import { expect, it } from 'effect-rstest';

import { principalKindOf } from '../../shared/actions/command-guard.ts';

it('treats an MCP connection as its person, and a connection for an agent as non-human', () => {
  expect(principalKindOf('session')).toBe('human');
  expect(principalKindOf('api_key')).toBe('non_human');
  expect(principalKindOf('oauth_connection')).toBe('human');
  expect(principalKindOf('oauth_connection', '72000000-0000-4000-8000-000000000021')).toBe('non_human');
  expect(principalKindOf('oauth_connection', undefined, 'AiDecideChanges')).toBe('non_human');
});
