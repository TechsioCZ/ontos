import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  AgentActionRequestHeadersSchema,
  AgentProposalRequestHeadersSchema,
  ShellAuthenticationApi,
} from '../../../shared/api.ts';

it('requires the canonical bounded ingress key on every proposal mutation', () => {
  const { endpoints } = ShellAuthenticationApi.groups.agentPlatform;
  expect(endpoints.submitAgentProposals.headers?.ast).toBe(AgentProposalRequestHeadersSchema.ast);
  expect(endpoints.agentDecide.headers?.ast).toBe(AgentActionRequestHeadersSchema.ast);
  expect(endpoints.agentRevert.headers?.ast).toBe(AgentActionRequestHeadersSchema.ast);
  for (const schema of [AgentActionRequestHeadersSchema, AgentProposalRequestHeadersSchema]) {
    expect(Schema.is(schema)({})).toBe(false);
    expect(Schema.is(schema)({ 'idempotency-key': '' })).toBe(false);
    expect(Schema.is(schema)({ 'idempotency-key': 'x'.repeat(201) })).toBe(false);
    expect(Schema.is(schema)({ 'idempotency-key': 'x'.repeat(200) })).toBe(true);
    expect(Schema.is(schema)({ 'idempotency-key': 'intent', 'x-api-key': 'credential' })).toBe(true);
  }
});
