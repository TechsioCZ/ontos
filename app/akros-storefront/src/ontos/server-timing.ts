interface ShellBinding {
  fetch: typeof fetch;
}

const phase =
  /^(gateway-release|key-verify|principal-resolve|legal-entity-sql|legal-entity-spicedb|assertion-issue|owner-dispatch|read-authentication|read-admission|read-scope|read-module|read-permission|read-prepare|read-transaction|read-authority|read-rls|read-owner|read-validation|read-audit|read-encode)\s*;\s*dur=(\d+(?:\.\d+)?)$/u;
const MAX_PHASES = 64;
const MAX_HEADER_LENGTH = 8192;
const renderPhase = /^(render)\s*;\s*dur=(\d+(?:\.\d+)?)$/u;

// Descriptions are discarded as complete metrics; their quoted commas cannot create new metrics.
const timingMetrics = (header: string): readonly string[] => {
  const metrics: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < header.length; index += 1) {
    const character = header[index];
    if (escaped) {
      escaped = false;
    } else if (quoted && character === "\\") {
      escaped = true;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (!quoted && character === ",") {
      metrics.push(header.slice(start, index));
      if (metrics.length === MAX_PHASES) return metrics;
      start = index + 1;
    }
  }
  if (quoted) return [];
  metrics.push(header.slice(start));
  return metrics;
};

const appendServerTimings = (timings: string[], header: string, allowRender = false): void => {
  if (header.length > MAX_HEADER_LENGTH || timings.length >= MAX_PHASES) return;
  let timingLength = timings.join(", ").length;
  for (const metric of timingMetrics(header)) {
    const value = metric.trim();
    const match = phase.exec(value) ?? (allowRender ? renderPhase.exec(value) : null);
    if (match !== null && timings.length < MAX_PHASES) {
      const timing = `${match[1]};dur=${match[2]}`;
      const nextLength = timingLength + timing.length + (timings.length === 0 ? 0 : 2);
      if (Number.isFinite(Number(match[2])) && nextLength <= MAX_HEADER_LENGTH) {
        timings.push(timing);
        timingLength = nextLength;
      }
    }
  }
};

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
          appendServerTimings(timings, result.headers.get("server-timing") ?? "");
          return result;
        },
      },
    },
    context,
  );
  const existing = response.headers.get("server-timing") ?? "";
  const finalTimings: string[] = [];
  // Existing diagnostics get the same allowlist and final byte/count budget; only render is local-only.
  appendServerTimings(finalTimings, existing, true);
  appendServerTimings(finalTimings, timings.join(", "));
  const header = finalTimings.join(", ");
  if (header === existing) return response;
  // Preserve streaming: never buffer HTML or wait for unrelated background work to expose diagnostics.
  const forwarded = new Response(response.body, response);
  if (header.length === 0) forwarded.headers.delete("server-timing");
  else forwarded.headers.set("server-timing", header);
  return forwarded;
}
