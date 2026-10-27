// expect-count: 1
declare const make: (command: string, args: readonly string[]) => unknown;

export const command = make(process.execPath, ['owner.mts', ...process.argv.slice(2)]);
