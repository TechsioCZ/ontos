import { Cookies } from 'effect/unstable/http';

const securePrefix = '__Secure-';
const hostPrefix = '__Host-';

export const sessionNames = (cookies: Cookies.Cookies) =>
  Object.keys(Cookies.toRecord(cookies)).map((name) => {
    if (name.startsWith(securePrefix)) return name.slice(securePrefix.length);
    if (name.startsWith(hostPrefix)) return name.slice(hostPrefix.length);
    return name;
  });

export const isSecureName = (name: string) => name.startsWith('__Secure-');
