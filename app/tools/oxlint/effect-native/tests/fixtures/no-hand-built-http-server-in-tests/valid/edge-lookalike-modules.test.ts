import { createServer } from "node:http-mock";
import * as https from "https-proxy-agent";
import net from "netmask";

export const a = createServer(() => {});
export const b = https.createServer({});
export const c = net.createSecureServer({});
