// @vitest-environment node
import { expect, it } from "vitest";
import { serveHttp } from "../support/http";

it("finishes an in-flight response before closing its loopback server", async () => {
  const arrived = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const network = await serveHttp(async () => {
    arrived.resolve();
    await release.promise;
    return new Response("complete response");
  });
  const response = fetch(network.origin).then((reply) => reply.text());
  await arrived.promise;
  const closing = network.close();
  release.resolve();
  expect(await response).toBe("complete response");
  await closing;
});
