import { landingAnswered } from "@/ontos/readiness";

// Zerops' readiness probe (zerops.yaml deploy.readinessCheck, every 10 s): a new container takes traffic once its
// landing has answered the boot warm-up (src/instrumentation.ts). An owner that never answers must not hold a deploy
// (failureTimeout 3 min), so a container up for a minute is ready either way.
const READY_WITHOUT_LANDING_S = 60;

export const dynamic = "force-dynamic";

export const GET = () => {
  const ready = landingAnswered() || process.uptime() > READY_WITHOUT_LANDING_S;
  return new Response(ready ? "ready" : "warming", {
    headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" },
    status: ready ? 200 : 503,
  });
};
