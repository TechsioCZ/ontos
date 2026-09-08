// The `new Server(handler)` spelling of the same bridge; the value import is the backstop that
// keeps this file reported even though the constructor and its `.listen` are not tracked.
import { Server } from "node:http";

const server = new Server(() => {});
server.listen(0, "127.0.0.1");
