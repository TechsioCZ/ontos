// Real OAuth end-to-end proof of the OntOS MCP server (lane mcp-mcp-rs). Usage from app/:
//   node scripts/demo/prove-mcp-oauth.mts [--variant=1|2|all] [--keep] [--check-token=<access token>]
// Results: v2/qa/mcp-oauth-e2e.json + .log, screenshots v2/shots/mcp-oauth-e2e/.
await import('../../tools/ontos-agent-mcp/scripts/oauth-e2e/prove.mts');
