export const createServer = (handler: () => void) => ({ listen: (_port: number) => handler() });
export const isIP = (_value: string) => 4;
