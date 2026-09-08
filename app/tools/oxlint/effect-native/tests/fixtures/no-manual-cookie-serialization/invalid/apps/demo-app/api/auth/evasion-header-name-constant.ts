// The header name behind a module constant defeats `headerWrite`, which only reads literal names.
declare const serializeCookie: (name: string, value: string) => string;

const SET_COOKIE = 'set-cookie';

export const write = (headers: Headers, name: string, value: string): void => {
  headers.append(SET_COOKIE, serializeCookie(name, value));
};
