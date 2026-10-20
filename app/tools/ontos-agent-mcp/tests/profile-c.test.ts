import { describe, expect, it } from '@rstest/core';
import { loadConfig } from '../src/config.ts';
import { isToolAllowed, PROFILE_TOOLS } from '../src/profiles.ts';

describe('Hanák AI profile C', () => {
  it('defaults C to Hanák and never falls back to the legacy bot key', () => {
    const config = loadConfig({
      ONTOS_AGENT_PROFILE: 'C',
      ONTOS_AGENT_C_HANAK_API_KEY: 'c-key',
      ONTOS_AGENT_API_KEY: 'legacy-key',
    });
    expect(config.company).toBe('hanak');
    expect(config.legalEntityId).toBe('71000000-0000-4000-8000-000000000022');
    expect(config.apiKeySource).toBe('ONTOS_AGENT_C_HANAK_API_KEY');
    expect(config.apiKey).toBe('c-key');
  });
  it('refuses profile C in a company without a human approval workflow', () => {
    expect(() =>
      loadConfig({ ONTOS_AGENT_PROFILE: 'C', ONTOS_AGENT_COMPANY: 'obchod', ONTOS_AGENT_C_HANAK_API_KEY: 'c-key' }),
    ).toThrow('Hanák');
  });
  it('offers exactly identity, CRM read and proposals', () => {
    expect([...PROFILE_TOOLS.C].sort()).toEqual(['list_crm', 'propose_crm_changes', 'whoami']);
    for (const name of [
      'create_task',
      'update_task',
      'create_opportunity',
      'update_opportunity',
      'raw_read',
      'approve_crm_changes',
      'revert_crm_batch',
    ])
      expect(isToolAllowed('C', name)).toBe(false);
    expect(isToolAllowed('A', 'propose_crm_changes')).toBe(false);
    expect(isToolAllowed('B', 'propose_crm_changes')).toBe(false);
    expect(isToolAllowed('A', 'create_task')).toBe(false);
    expect(isToolAllowed('B', 'create_task')).toBe(true);
  });
});
