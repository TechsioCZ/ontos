// An identifier spelling is not the string value of a module specifier.
export async function loadPlugin(process: string): Promise<unknown> {
  const plugin = await import(process);
  return plugin.env;
}
export function loadCommonJsPlugin(process: string): unknown {
  return require(process).env;
}

// Dynamic computed keys remain unknown, even if their identifier is spelled env.
export function dynamicKey(env: string): unknown {
  const { [env as string]: value } = process;
  return [value, process[env as string]];
}
