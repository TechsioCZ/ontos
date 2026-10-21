import { mkdtempSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from '@rstest/core';
import { E2eOAuthProvider } from '../scripts/oauth-e2e/provider.mts';
import { startLoopbackCallback } from '../scripts/oauth-e2e/loopback.mts';
import { Recorder } from '../scripts/oauth-e2e/report.mts';
import { OAUTH_SCOPES } from '../scripts/oauth-e2e/env.mts';

const ISSUER = 'http://localhost:3020/shell-super-app-api/oauth';

describe('oauth e2e support', () => {
  it('loopback callback captures redirect parameters', async () => {
    const loopback = await startLoopbackCallback();
    try {
      expect(loopback.redirectUrl).toMatch(/^http:\/\/localhost:\d+\/callback$/u);
      const response = await fetch(`${loopback.redirectUrl}?code=c1&state=s1&iss=${encodeURIComponent(ISSUER)}`);
      expect(response.status).toBe(200);
      const params = await loopback.waitForCallback(2000);
      expect(params.get('code')).toBe('c1');
      expect(params.get('state')).toBe('s1');
      expect(params.get('iss')).toBe(ISSUER);
    } finally {
      await loopback.close();
    }
  });

  it('recorder writes json and log with failing steps', async () => {
    const dir = mkdtempSync(path.join(process.env.TMPDIR ?? '/Volumes/DevWork/agent-scratch/tmp', 'e2e-'));
    const recorder = new Recorder();
    const value = await recorder.step('v', 'passing', async () => ({ pass: true, detail: 'ok', value: 42 }));
    expect(value).toBe(42);
    const failed = await recorder.step('v', 'throwing', async () => {
      throw new Error('boom');
    });
    expect(failed).toBeUndefined();
    expect(recorder.pass).toBe(false);
    await recorder.write(dir, 'test-e2e', { run: 't' });
    const json = JSON.parse(readFileSync(path.join(dir, 'test-e2e.json'), 'utf8')) as {
      pass: boolean;
      run: string;
      steps: Array<{ detail: string }>;
    };
    expect(json.pass).toBe(false);
    expect(json.run).toBe('t');
    expect(json.steps).toHaveLength(2);
    expect(json.steps[1]?.detail).toBe('boom');
    expect(readFileSync(path.join(dir, 'test-e2e.log'), 'utf8')).toContain('FAIL');
  });

  it('provider exposes CIMD metadata and redirect uri', () => {
    const provider = new E2eOAuthProvider({
      clientName: 'x',
      redirectUrl: 'http://localhost:1234/callback',
      clientMetadataUrl: 'https://claude.ai/oauth/claude-code-client-metadata',
      onRedirect: async () => undefined,
    });
    expect(provider.clientMetadata.redirect_uris).toEqual(['http://localhost:1234/callback']);
    expect(provider.clientMetadataUrl).toBe('https://claude.ai/oauth/claude-code-client-metadata');
    expect(OAUTH_SCOPES.split(' ')).toContain('ontos');
    expect(() => provider.currentTokens()).toThrow('Žádné tokeny');
  });
});
