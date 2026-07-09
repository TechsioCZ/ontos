
    export type RemoteKeys = 'ticketing/Route' | 'ticketing/Widget' | 'ticketing/pages/TicketingPage';
    type PackageType<T> = T extends 'ticketing/pages/TicketingPage' ? typeof import('ticketing/pages/TicketingPage') :T extends 'ticketing/Widget' ? typeof import('ticketing/Widget') :T extends 'ticketing/Route' ? typeof import('ticketing/Route') :any;