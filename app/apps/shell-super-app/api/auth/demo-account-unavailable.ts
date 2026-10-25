import { Data } from 'effect';

export class DemoAccountUnavailable extends Data.TaggedError('DemoAccountUnavailable')<{ readonly cause: unknown }> {}
