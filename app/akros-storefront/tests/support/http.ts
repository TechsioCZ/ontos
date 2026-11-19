import { createServer } from "node:http";
import { setImmediate } from "node:timers/promises";
import type { DetachedWindowAPI } from "happy-dom";

declare global {
  interface Window {
    readonly happyDOM: DetachedWindowAPI;
  }
}

/** Real loopback HTTP. Browser requests use happy-dom's own fetch, never a replaced global. */
export async function serveHttp(answer: (request: Request) => Response | Promise<Response>) {
  const requests: Request[] = [];
  let active = 0;
  let moves = 0;
  const server = createServer(async (incoming, outgoing) => {
    active += 1;
    moves += 1;
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (Array.isArray(value)) for (const item of value) headers.append(name, item);
        else if (value !== undefined) headers.set(name, value);
      }
      const request = new Request(`${origin}${incoming.url}`, {
        method: incoming.method,
        headers,
        ...(chunks.length ? { body: Buffer.concat(chunks).toString() } : {}),
      });
      requests.push(request.clone());
      const response = await answer(request);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      outgoing.writeHead(500, { "content-type": "text/plain" });
      outgoing.end(String(error));
    } finally {
      active -= 1;
      moves += 1;
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing HTTP address");
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    requests,
    async idle() {
      for (;;) {
        const before = moves;
        await setImmediate();
        await setImmediate();
        if (active === 0 && before === moves) return;
      }
    },
    async close() {
      // server.close() drains active responses; destroying sockets first races
      // outgoing.end() and makes Next prefetches report ECONNRESET.
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

/** happy-dom's documented browser control API changes the document URL, not any global implementation. */
export function browserAt(url: string) {
  window.happyDOM.setURL(url);
}
