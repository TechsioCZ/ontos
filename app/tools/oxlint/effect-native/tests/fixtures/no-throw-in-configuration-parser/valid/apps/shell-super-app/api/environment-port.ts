// An injected environment *port* shadows the ambient host, so nothing here is an ambient read and
// the function is not a configuration parser.
export interface ProcessPort {
  readonly env: Record<string, string>;
}

export const readFromInjectedProcess = (process: ProcessPort, key: string): string => {
  const value = process.env[key];
  if (value === undefined) {
    throw new Error(`${key} is required`);
  }
  return value;
};
