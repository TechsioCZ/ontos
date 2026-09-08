export const createServer = (handler: () => void) => ({ listen: (_port: number) => handler() });
