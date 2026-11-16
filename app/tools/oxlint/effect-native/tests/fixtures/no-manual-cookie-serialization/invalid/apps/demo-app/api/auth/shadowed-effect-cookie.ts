// expect-count: 1
import { Cookies } from "effect/unstable/http";
export function write(headers: Headers, Cookies: { serialize(): string }) {
  headers.set("set-cookie", Cookies.serialize());
}
