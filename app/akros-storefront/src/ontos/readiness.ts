// Zerops sends a new container traffic once its readiness check answers 2xx (zerops.yaml deploy.readinessCheck:
// /api/ontos/ready). The boot warm-up (instrumentation.ts) marks the moment the landing first answered, so the first shopper
// after a deploy meets a process that has rendered its landing and holds its shared reads, not the cold first render
// (about 1.5-2 s of CPU on stage).
declare global {
  // The instrumentation hook and the route handlers are separate bundles of one process: the mark is process-wide.
  var ontosLandingAnswered: boolean | undefined;
}

export const markLandingAnswered = () => {
  globalThis.ontosLandingAnswered = true;
};

export const landingAnswered = () => globalThis.ontosLandingAnswered === true;
