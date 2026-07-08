
    export type RemoteKeys = 'ticketing/Route' | 'ticketing/Widget';
    type PackageType<T> = T extends 'ticketing/Widget' ? typeof import('ticketing/Widget') :T extends 'ticketing/Route' ? typeof import('ticketing/Route') :any;