// Dynamic specifiers that are not statically a dotenv package.
export const loadPlugin = async (name: string): Promise<unknown> => await import(name);
export const loadFormatter = async (): Promise<unknown> => await import('dotenv-webpack-like-helper');
