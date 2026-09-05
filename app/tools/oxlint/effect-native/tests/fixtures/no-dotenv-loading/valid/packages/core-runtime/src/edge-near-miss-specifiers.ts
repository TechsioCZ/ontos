// Package names that merely start with or contain "dotenv" are different packages.
import { readEnvironment } from 'dotenvish';
import { helper } from 'my-dotenv-helper';
import { transform } from 'dotenv_flow';

export const loadPlugin = async (base: string): Promise<unknown> => await import(`${base}/dotenv`);
export const loadOther = async (): Promise<unknown> => await import('dotenv-webpack-like-helper');

export const values = [readEnvironment(), helper(), transform()] as const;
