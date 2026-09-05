// expect-count: 3
import { createServer as makeServer } from "node:http";

let server: { listen: (port: number) => void } | undefined;
server = makeServer(() => {});
server.listen(0);

export const Probe = () => <span>probe</span>;
