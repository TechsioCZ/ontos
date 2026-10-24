// OpenNext's Next.js handler with request timing diagnostics.
import handler from "./.open-next/worker.js";
import { withShellTimings } from "./src/ontos/server-timing.ts";

export default {
  fetch: (request, env, ctx) => withShellTimings(request, env, ctx, handler.fetch),
};
