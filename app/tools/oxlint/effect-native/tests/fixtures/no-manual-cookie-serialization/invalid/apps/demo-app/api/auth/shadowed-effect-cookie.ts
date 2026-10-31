// expect-count: 1
import { Cookies } from "effect/http";
export function write(headers: Headers, Cookies: { serialize(): string }) {
  headers.set("set-cookie", Cookies.serialize());
}
