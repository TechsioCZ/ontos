const createServer = (handler: () => void) => ({ listen: (_port: number) => handler() });
const server = createServer(() => {});
server.listen(0);

export const app = { listen: (_port: number) => undefined };
app.listen(3000);
