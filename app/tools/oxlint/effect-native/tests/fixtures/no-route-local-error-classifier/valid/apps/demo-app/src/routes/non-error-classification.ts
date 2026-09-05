import { Exit } from 'effect';

export const classifyGridDensity = (rows: number): 'comfortable' | 'compact' =>
  rows > 50 ? 'compact' : 'comfortable';
export const hasFailed = <A, E>(exit: Exit.Exit<A, E>) => exit._tag === 'Failure';
export const domainLabel = ({ _tag }: { readonly _tag: 'Customer' | 'Supplier' }) => _tag;

type ErrorClassificationInput = { readonly rows: number };
export const count = (input: ErrorClassificationInput) => input.rows;

export const outer = (failure: { _tag: 'Failure' }) => {
  { const failure = { _tag: 'Row' }; return failure._tag; }
};

export const channelErrorEnvelope = (exit: Exit.Exit<number, Error>) => exit._tag === 'Failure';
export const renamedErrorEnvelope = (error: Exit.Exit<number, Error>) => error._tag === 'Failure';
