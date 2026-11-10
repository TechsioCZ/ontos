import { expect, it } from 'effect-rstest';

import { oldRefreshVerdict } from '../demo/mcp-oauth-e2e/report.mts';

it('fails without claiming acceptance when the rotation was never recorded', () => {
  expect(oldRefreshVerdict({ _tag: 'NotReplayed' })).toEqual({
    detail: 'rotace selhala, replay starého refresh tokenu neproveden',
    pass: false,
  });
});

it('reports acceptance only when the old refresh token was replayed and the server accepted it', () => {
  expect(oldRefreshVerdict({ _tag: 'Accepted' })).toEqual({ detail: 'starý refresh token prošel', pass: false });
});

it('passes only when the server rejects the replayed old refresh token', () => {
  expect(oldRefreshVerdict({ _tag: 'Rejected' })).toEqual({ detail: 'invalid_grant', pass: true });
});
