import { createServer } from "./server-double.ts";
import * as net from "./net-double.ts";

export const a = createServer(() => {});
export const b = net.createServer(() => {});
export const c = net.isIP("127.0.0.1");
