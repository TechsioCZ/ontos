// expect-count: 1
import { makeRecordsServices } from './owner.ts';

declare const descriptor: never;
declare const pipeline: never;
declare const permissionResolver: never;

function register(defineRead: (...arguments_: unknown[]) => unknown) {
  return defineRead(descriptor, pipeline, makeRecordsServices, permissionResolver);
}
