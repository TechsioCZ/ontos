// expect-count: 3
// The exact shape found three times in the repo: import the factory, boot a listener, await the port.
import { createServer } from "node:http";

export async function startProbe(): Promise<number> {
	const server = createServer((_request, response) => {
		response.end("ok");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return 0;
}
