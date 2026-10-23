interface ShellBinding {
  fetch: typeof fetch;
}

const phase =
  /^(gateway-release|key-verify|principal-resolve|legal-entity-sql|legal-entity-spicedb|assertion-issue|owner-dispatch)\s*;\s*dur=(\d+(?:\.\d+)?)$/u;
const MAX_PHASES = 64;

/** Only fixed internal phase names and finite durations cross the public response boundary. */
export async function withShellTimings<Env extends { ONTOS_SHELL?: ShellBinding }, Context>(
  request: Request,
  env: Env,
  context: Context,
  handle: (request: Request, env: Env, context: Context) => Promise<Response>,
): Promise<Response> {
  const binding = env.ONTOS_SHELL;
  if (binding === undefined) return await handle(request, env, context);
  // One collector and binding wrapper per request; no mutable isolate-wide diagnostic state.
  const timings: string[] = [];
  const response = await handle(
    request,
    {
      ...env,
      ONTOS_SHELL: {
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const result = await binding.fetch(input, init);
          for (const metric of (result.headers.get("server-timing") ?? "").split(",")) {
            const match = phase.exec(metric.trim());
            if (match !== null && timings.length < MAX_PHASES) {
              const duration = Number(match[2]);
              if (Number.isFinite(duration)) timings.push(`${match[1]};dur=${duration}`);
            }
          }
          return result;
        },
      },
    },
    context,
  );
  if (timings.length === 0) return response;
  // Preserve streaming: never buffer HTML or wait for unrelated background work to expose diagnostics.
  const forwarded = new Response(response.body, response);
  forwarded.headers.append("server-timing", timings.join(", "));
  return forwarded;
}
