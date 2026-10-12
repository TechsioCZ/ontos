# @ontos/agent-mcp

stdio MCP server that gives a coding agent authenticated access to OntOS verticals through the shell.
Standalone package, not part of the pnpm workspace. Always run pnpm with `--ignore-workspace`.

## Configuration

| Variable                     | Required              | Default                 | Purpose                                                               |
| ---------------------------- | --------------------- | ----------------------- | --------------------------------------------------------------------- |
| `ONTOS_AGENT_API_KEY`        | yes                   | none                    | Shell API key, sent only as `x-api-key` to the shell gateway endpoint |
| `ONTOS_SHELL_URL`            | no                    | `http://localhost:3020` | Shell origin                                                          |
| `ONTOS_COMPOSITION_REVISION` | yes for gateway calls | none                    | Live release revision (64 hex). The shell rejects other values        |
| `ONTOS_LEGAL_ENTITY_ID`      | no                    | none                    | UUID of the legal entity to scope assertions to                       |

Process environment wins. Missing values are read from `app/.env.demo.local` (`KEY=VALUE` lines).
That file is gitignored by `**/.env.*` in `app/.gitignore`.

## Run

```bash
cd app/tools/ontos-agent-mcp
pnpm install --ignore-workspace
pnpm --ignore-workspace typecheck
pnpm --ignore-workspace start      # stdio server; no output on stdout until a client connects
```

Tools: `whoami` (shell URL and whether a `siampark-work` assertion can be obtained) and
`raw_read` (vertical, readName, query: a records read through the shell).

## Claude Code

```bash
claude mcp add ontos-sales \
  -e ONTOS_SHELL_URL=http://localhost:3020 \
  -e ONTOS_COMPOSITION_REVISION=<64-hex-revision> \
  -e ONTOS_AGENT_API_KEY=<key> \
  -- node --experimental-strip-types /abs/path/to/app/tools/ontos-agent-mcp/src/server.ts
```

If the key is already in `app/.env.demo.local`, the `-e ONTOS_AGENT_API_KEY` flag can be left out.

## Security

- The API key lives only in the process environment or in the gitignored `app/.env.demo.local`.
  Do not paste it into commands, committed files, or chat.
- The server never returns the API key or assertion tokens in tool output, and it never writes to stdout
  except for MCP frames.
