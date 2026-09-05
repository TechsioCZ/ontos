const server = { listen: (_port: number) => undefined, fetch: (_url: string) => undefined };
server.listen(0);
server["listen"](0);
server?.fetch("http://in-memory");
globalThis.fetch("http://in-memory");
