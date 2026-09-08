// D tier: Playwright/e2e specs legitimately drive a real server the browser driver owns.
import { createServer } from "node:http";

export const server = createServer(() => {});
server.listen(0, "127.0.0.1");
