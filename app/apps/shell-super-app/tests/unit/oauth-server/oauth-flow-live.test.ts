import { expect, test } from 'effect-rstest';

import { parseVerifiedOAuthQuery } from '../../../api/auth/oauth-server/oauth-flow-live.ts';

const FULL_QUERY =
  'response_type=code&client_id=https%3A%2F%2Fclaude.ai%2Foauth%2Fclaude-code-client-metadata&redirect_uri=http%3A%2F%2Flocalhost%3A5000%2Fcallback&scope=openid+ontos&state=s1&resource=http%3A%2F%2Flocalhost%3A3020%2Fmcp&company=71000000-0000-4000-8000-000000000021&agent=a1&exp=1&sig=x';

test('parseVerifiedOAuthQuery reads every connect-flow field', () => {
  expect(parseVerifiedOAuthQuery(FULL_QUERY)).toEqual({
    agent: 'a1',
    clientId: 'https://claude.ai/oauth/claude-code-client-metadata',
    company: '71000000-0000-4000-8000-000000000021',
    redirectUri: 'http://localhost:5000/callback',
    resource: 'http://localhost:3020/mcp',
    scope: 'openid ontos',
    state: 's1',
  });
});

test('parseVerifiedOAuthQuery maps absent optional fields to null and absent scope to empty string', () => {
  const parsed = parseVerifiedOAuthQuery(
    'client_id=c1&redirect_uri=http%3A%2F%2Flocalhost%3A5000%2Fcallback&exp=1&sig=x',
  );
  expect(parsed).toEqual({
    agent: null,
    clientId: 'c1',
    company: null,
    redirectUri: 'http://localhost:5000/callback',
    resource: null,
    scope: '',
    state: null,
  });
});

test('parseVerifiedOAuthQuery returns undefined when client_id or redirect_uri is missing or empty', () => {
  expect(parseVerifiedOAuthQuery('redirect_uri=http%3A%2F%2Flocalhost%3A5000%2Fcallback')).toBeUndefined();
  expect(parseVerifiedOAuthQuery('client_id=c1')).toBeUndefined();
  expect(parseVerifiedOAuthQuery('client_id=&redirect_uri=http%3A%2F%2Flocalhost%3A5000%2Fcallback')).toBeUndefined();
  expect(parseVerifiedOAuthQuery('client_id=c1&redirect_uri=')).toBeUndefined();
});
