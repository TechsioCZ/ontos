// Real OAuth end-to-end proof of the Shell MCP endpoint (<shell>/mcp). Usage from app/:
//   node scripts/demo/prove-mcp-oauth.mts [--variant=1|2|all] [--keep] [--check-token=<access token>]
// Results: v2/qa/mcp-oauth-e2e.json + .log, screenshots v2/shots/mcp-oauth-e2e/.
import './mcp-oauth-e2e/prove.mts';
