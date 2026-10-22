// The storefront Worker: OpenNext's Next.js handler plus a scheduled catalog warm-up.
// The warm-up runs as a request to the Next.js route, so it uses the same catalog code, bindings and
// Cloudflare request context as a page view.
import handler from "./.open-next/worker.js";

export default {
  fetch: handler.fetch,
  /** @param {unknown} _controller @param {unknown} env @param {{ waitUntil(promise: Promise<unknown>): void }} ctx */
  async scheduled(_controller, env, ctx) {
    const response = await handler.fetch(
      new Request("https://storefront.internal/api/ontos/catalog-warm", { method: "POST" }),
      env,
      ctx,
    );
    console.log(`[AKROS] catalog warm-up ${response.status} ${await response.text()}`);
  },
};
