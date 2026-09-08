import { Option } from 'effect';
import { ChildProcess } from 'effect/unstable/process';

export const ultramodernLaunch = (
  createBin: Option.Option<string>,
  ultramodernArgs: readonly string[],
  workspaceRoot: string,
  pathSeparator: string
) => {
  const launch = Option.match(createBin, {
    onNone: () => ({
      args: ultramodernArgs,
      executable: 'ultramodern-create',
      shell: pathSeparator === '\\',
      target: 'ultramodern-create from PATH',
    }),
    onSome: (bin) => ({
      args: [bin, ...ultramodernArgs],
      executable: process.execPath,
      shell: false,
      target: `${process.execPath} with ULTRAMODERN_CREATE_BIN=${bin}`,
    }),
  });

  return {
    command: ChildProcess.make(launch.executable, launch.args, {
      env: { ULTRAMODERN_WORKSPACE_ROOT: workspaceRoot },
      extendEnv: true,
      shell: launch.shell,
      stderr: 'inherit',
      stdin: 'inherit',
      stdout: 'inherit',
    }),
    target: launch.target,
  };
};
