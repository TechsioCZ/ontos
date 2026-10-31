import { Data } from 'effect';

export class DemoAccountConflict extends Data.TaggedError('DemoAccountConflict')<{ readonly reason: string }> {}
