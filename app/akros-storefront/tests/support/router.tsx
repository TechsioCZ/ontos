import "next/dist/client/app-bootstrap";
import { spawn } from "node:child_process";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { createContext, useContext, useState, type ReactNode } from "react";
import AppRouter from "next/dist/client/components/app-router";
import { createMutableActionQueue } from "next/dist/client/components/app-router-instance";
import { createInitialRouterState } from "next/dist/client/components/router-reducer/create-initial-router-state";

const Content = createContext<ReactNode>(null);
function CurrentContent() {
  return useContext(Content);
}
function RoutingError() {
  return <p role="alert">Router error</p>;
}
let queue: ReturnType<typeof createMutableActionQueue> | undefined;

/** The real Next AppRouter, hydrated from a complete initial transport payload. */
export function NextRouter({ children }: { children: ReactNode }) {
  const [actionQueue] = useState(() => {
    const data = { r: <CurrentContent />, p: false, v: null };
    const state = createInitialRouterState({
      navigatedAt: Date.now(),
      location: window.location,
      initialRSCPayload: {
        c: [window.location.pathname + window.location.search],
        q: window.location.search,
        i: false,
        S: false,
        m: undefined,
        G: [RoutingError, undefined],
        t: {
          t: {
            s: "",
            d: data,
            c: new Map([["children", { s: "__PAGE__", d: { r: null, p: false, v: null } }]]),
          },
          h: { r: null, p: false, v: null },
        },
      },
    });
    if (!queue) queue = createMutableActionQueue(state);
    else if (queue.pending === null) queue.state = state;
    return queue;
  });
  return (
    <Content.Provider value={children}>
      <AppRouter actionQueue={actionQueue} globalErrorState={[RoutingError, undefined]} />
    </Content.Provider>
  );
}

/** Native React Flight encoding, sent as an actual HTTP response to Next's native router. */
export async function flightResponse(text: string, search = ""): Promise<Response> {
  const body = await new Promise<string>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--conditions=react-server", fileURLToPath(new NodeURL("./flight.cjs", import.meta.url))],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let output = "";
    let errors = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      errors += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(output) : reject(new Error(errors))));
    child.stdin.end(JSON.stringify({ text, search }));
  });
  return new Response(body, { headers: { "content-type": "text/x-component" } });
}
