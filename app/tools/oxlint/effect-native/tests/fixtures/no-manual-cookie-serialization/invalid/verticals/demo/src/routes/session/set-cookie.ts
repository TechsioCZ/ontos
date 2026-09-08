// expect-count: 4
export const writeCookies = (headers: Headers, name: string, value: string): void => {
  headers.append('set-cookie', `${name}=${value}; Path=/`);
  headers.set('Set-Cookie', name + '=' + value);
};

export const respond = (name: string, value: string): Response =>
  new Response(null, {
    headers: {
      'content-type': 'text/plain',
      'Set-Cookie': `${name}=${value}; HttpOnly; Secure`,
    },
  });

export const nodeStyle = (res: { setHeader: (name: string, value: readonly string[]) => void }): void => {
  res.setHeader('Set-Cookie', ['a=1; Path=/', 'b=2; Path=/']);
};
