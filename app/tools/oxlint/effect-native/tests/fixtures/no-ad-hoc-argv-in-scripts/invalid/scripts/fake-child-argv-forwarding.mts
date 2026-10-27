// expect-count: 1
const ChildProcess = { make: (command: string, args: readonly string[]) => ({ command, args }) };

export const command = ChildProcess.make(process.execPath, ['owner.mts', ...process.argv.slice(2)]);
