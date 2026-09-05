// expect-count: 5
import http from "node:http";
import * as http2 from "node:http2";

export const plain = http.createServer(() => {});
export const secure = http2?.createSecureServer?.({});
export const computed = http["createServer"](() => {});
