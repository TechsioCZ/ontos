import { describe, expect, it } from '@rstest/core';
import { loadRsConfig } from '../src/config.ts';

// Empty strings neutralise values that app/.env.demo.local would otherwise supply.
const ENV = {
  ONTOS_MCP_CONNECTOR_SECRET: 'secret-1',
  ONTOS_MCP_RESOURCE_URL: 'http://localhost:3090/mcp',
  ONTOS_OAUTH_ISSUER: 'http://localhost:3020/shell-super-app-api/oauth',
  ONTOS_SHELL_INTERNAL_URL: 'http://shell.internal:3020/',
  ONTOS_MCP_HTTP_PORT: '3090',
  ONTOS_OAUTH_JWKS_URL: '',
  ONTOS_SHELL_PUBLIC_URL: '',
  ONTOS_MCP_ALLOWED_HOSTS: '',
  ONTOS_MCP_ALLOWED_ORIGINS: '',
  ONTOS_MCP_HTTP_HOST: '',
  ONTOS_SHELL_URL: '',
};

describe('resource-server config', () => {
  it('derives the RS settings from the environment', () => {
    const config = loadRsConfig(ENV);
    expect(config.prmUrl).toBe('http://localhost:3090/.well-known/oauth-protected-resource/mcp');
    expect(config.jwksUrl).toBe('http://localhost:3020/shell-super-app-api/oauth/jwks');
    expect(config.shellInternalUrl).toBe('http://shell.internal:3020');
    expect(config.shellPublicUrl).toBe('http://localhost:3020');
    expect(config.connectGuideUrl).toBe('http://localhost:3020/cs/profil');
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(3090);
    expect(config.allowedHosts).toContain('localhost:3090');
    expect(config.allowedHosts).toContain('127.0.0.1:3090');
    expect(config.allowedOrigins).toContain('https://claude.ai');
  });

  it('rejects a resource URL with a trailing slash', () => {
    expect(() => loadRsConfig({ ...ENV, ONTOS_MCP_RESOURCE_URL: 'http://localhost:3090/mcp/' })).toThrow();
  });
});
