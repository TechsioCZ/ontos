/**
 * FALSE POSITIVE (adversarial review, no-promise-shaped-port).
 *
 * `loader` is exempt via `allowNames`, but its whole body is one expression delegated to
 * `loadHomePageModel`, which hands a single composed Effect to Modern.js's own adapter
 * (`runEffectRequest` from `@modern-js/plugin-bff/effect-client`). The `allowNames` escape hatch is
 * defeated by one line of indirection, and the reported function is the framework adapter seam the
 * audit blesses (D tier; A9: "React and TanStack still require Promise adapters").
 *
 * Real hit reproduced here: apps/shell-super-app/src/routes/[lang]/page.data.ts:73.
 */
import { Effect } from "effect";

// Modern.js ships its own Effect adapter; `currentSession` is a first-party Effect-returning client.
import { currentSession, runEffectRequest } from "@modern-js/plugin-bff/effect-client";

export const loadHomePageModel = (request: Request): Promise<{ readonly state: string }> =>
	runEffectRequest(
		currentSession.pipe(Effect.map((session) => ({ state: `${request.method}:${session.state}` }))),
	);

export const loader = ({ request }: { readonly request: Request }): Promise<{ readonly state: string }> =>
	loadHomePageModel(request);
