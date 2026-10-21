import { describe, expect, it } from '@rstest/core';
import { loadConfig } from '../src/config.ts';
import { COMPANY_PROFILE_TOOLS, isToolAllowed, PROFILE_TOOLS } from '../src/profiles.ts';

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
  it('Obchodní firma C uses its own key and company, never the Hanák or legacy key', () => {
    const config = loadConfig({
      ONTOS_AGENT_API_KEY: 'legacy-key',
      ONTOS_AGENT_COMPANY: 'obchod',
      ONTOS_AGENT_C_HANAK_API_KEY: 'hanak-key',
      ONTOS_AGENT_C_OBCHOD_API_KEY: 'obchod-key',
      ONTOS_AGENT_PROFILE: 'C',
    });
    expect(config.company).toBe('obchod');
    expect(config.legalEntityId).toBe('71000000-0000-4000-8000-000000000020');
    expect(config.apiKeySource).toBe('ONTOS_AGENT_C_OBCHOD_API_KEY');
    expect(config.apiKey).toBe('obchod-key');
  });
  it('Obchodní firma C reads and proposes opportunity and order changes, but has no direct write tool', () => {
    expect([...COMPANY_PROFILE_TOOLS.obchod.C].sort()).toEqual([
      'list_ai_proposals',
      'list_customers',
      'list_employees',
      'list_opportunities',
      'list_orders',
      'list_products',
      'propose_sales_changes',
      'whoami',
    ]);
    for (const name of ['create_opportunity', 'update_opportunity', 'create_task', 'assign_tags', 'propose_crm_changes'])
      expect(isToolAllowed('C', name, 'obchod')).toBe(false);
    expect(isToolAllowed('C', 'propose_sales_changes', 'hanak')).toBe(false);
  });
  it('Hanák A and B list only reads of modules Hanák has', () => {
    for (const name of ['list_opportunities', 'list_orders', 'list_products', 'list_invoices', 'get_metrics'])
      expect(isToolAllowed('A', name, 'hanak')).toBe(false);
    expect(isToolAllowed('A', 'list_crm', 'hanak')).toBe(true);
    expect(isToolAllowed('B', 'create_task', 'hanak')).toBe(true);
    expect(isToolAllowed('A', 'list_invoices', 'obchod')).toBe(true);
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
