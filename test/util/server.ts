import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** Serve fixed pages from memory on a free localhost port. */
export async function servePages(pages: Record<string, string>): Promise<{ url: (path: string) => string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const body = pages[req.url ?? '/'];
    if (body === undefined) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: (path) => `http://127.0.0.1:${port}${path}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
