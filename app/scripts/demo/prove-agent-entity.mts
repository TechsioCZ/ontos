// Real OAuth end-to-end proof of an administrator-created agent entity (lane agent-entities-admin). Usage from app/:
//   node scripts/demo/prove-agent-entity.mts [--policy=approval|direct] [--keep] [--help]
// Results: v2/qa/v5-agent-entities-e2e.json + .log, screenshots v2/shots/v5-agent-entities-admin/.
await import('../../tools/ontos-agent-mcp/scripts/oauth-e2e/prove-agent-entity.mts');
