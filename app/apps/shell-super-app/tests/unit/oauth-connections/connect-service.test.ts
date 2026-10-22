import type { ConnectCompanyOption } from '@app/shared-contracts/oauth-connections';
import { expect, test } from 'effect-rstest';

import { buildDenyRedirect, choosePreselect } from '../../../api/oauth-connections/connect-service.ts';
import type { VerifiedOAuthQuery } from '../../../api/oauth-connections/oauth-flow.ts';

const ISSUER = 'http://localhost:3020/shell-super-app-api/oauth';

const verified = (state: string | null): VerifiedOAuthQuery => ({
  agent: null,
  clientId: 'https://claude.ai/oauth/mcp-client.json',
  company: null,
  redirectUri: 'http://localhost:5555/callback',
  resource: 'http://localhost:3020/mcp',
  scope: 'ontos',
  state,
});

const company = (legalEntityId: string, agentIds: readonly string[] = []): ConnectCompanyOption => ({
  agents: agentIds.map((principalId) => ({ displayName: principalId, modules: [], principalId, writePolicy: 'approval' })),
  legalEntityId,
  legalName: `Firma ${legalEntityId}`,
  modules: [],
});

test('buildDenyRedirect adds access_denied, the original state and the issuer', () => {
  const href = buildDenyRedirect(verified('xyz'), ISSUER);
  expect(href.startsWith('http://localhost:5555/callback?')).toBe(true);
  expect(href).toContain('error=access_denied');
  expect(href).toContain('state=xyz');
  expect(href).toContain('iss=http%3A%2F%2Flocalhost%3A3020%2Fshell-super-app-api%2Foauth');
});

test('buildDenyRedirect leaves out state when the request had none', () => {
  const url = new URL(buildDenyRedirect(verified(null), ISSUER));
  expect(url.searchParams.has('state')).toBe(false);
  expect(url.searchParams.get('error')).toBe('access_denied');
  expect(url.searchParams.get('iss')).toBe(ISSUER);
});

test('choosePreselect prefers the requested company when it is offered', () => {
  expect(
    choosePreselect({
      activeLegalEntityId: 'le-a',
      companies: [company('le-a'), company('le-b')],
      requestedAgent: null,
      requestedCompany: 'le-b',
    }),
  ).toStrictEqual({ agentPrincipalId: null, legalEntityId: 'le-b' });
});

test('choosePreselect falls back to the active company for an unknown requested company', () => {
  expect(
    choosePreselect({
      activeLegalEntityId: 'le-a',
      companies: [company('le-a'), company('le-b')],
      requestedAgent: null,
      requestedCompany: 'le-unknown',
    }),
  ).toStrictEqual({ agentPrincipalId: null, legalEntityId: 'le-a' });
});

test('choosePreselect selects the only company and nothing when several are offered without a hint', () => {
  expect(
    choosePreselect({ activeLegalEntityId: null, companies: [company('le-a')], requestedAgent: null, requestedCompany: null }),
  ).toStrictEqual({ agentPrincipalId: null, legalEntityId: 'le-a' });
  expect(
    choosePreselect({
      activeLegalEntityId: null,
      companies: [company('le-a'), company('le-b')],
      requestedAgent: null,
      requestedCompany: null,
    }),
  ).toStrictEqual({ agentPrincipalId: null, legalEntityId: null });
});

test('choosePreselect keeps the requested agent only when the chosen company offers it', () => {
  const companies = [company('le-a', ['agent-1']), company('le-b', ['agent-2'])];
  expect(
    choosePreselect({ activeLegalEntityId: null, companies, requestedAgent: 'agent-1', requestedCompany: 'le-a' }),
  ).toStrictEqual({ agentPrincipalId: 'agent-1', legalEntityId: 'le-a' });
  expect(
    choosePreselect({ activeLegalEntityId: null, companies, requestedAgent: 'agent-2', requestedCompany: 'le-a' }),
  ).toStrictEqual({ agentPrincipalId: null, legalEntityId: 'le-a' });
});
