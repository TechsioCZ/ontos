// expect-count: 1
import { defineRead } from '@app/core-runtime';
import { makeRecordsServices } from './owner.ts';

declare const descriptor: never;
declare const serviceFactory: never;
declare const permissionResolver: never;

defineRead(descriptor, makeRecordsServices, serviceFactory, permissionResolver);
