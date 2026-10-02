import net from 'node:net';

export interface TcpProxy {
  readonly port: number;
  pause(): void;
  resume(): void;
  close(): Promise<void>;
}

export async function startTcpProxy(
  targetHost: string,
  targetPort: number,
): Promise<TcpProxy> {
  let paused = false;
  const pairs = new Set<{ client: net.Socket; upstream: net.Socket }>();
  const server = net.createServer((client) => {
    if (paused) {
      client.destroy();
      return;
    }
    const upstream = net.connect(targetPort, targetHost);
    const pair = { client, upstream };
    pairs.add(pair);
    const cleanup = () => {
      client.destroy();
      upstream.destroy();
      pairs.delete(pair);
    };
    client.on('error', cleanup);
    upstream.on('error', cleanup);
    client.on('close', cleanup);
    upstream.on('close', cleanup);
    client.pipe(upstream);
    upstream.pipe(client);
  });
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  );
  const address = server.address() as net.AddressInfo;
  return {
    port: address.port,
    pause() {
      paused = true;
      for (const { client, upstream } of pairs) {
        client.destroy();
        upstream.destroy();
      }
      pairs.clear();
    },
    resume() {
      paused = false;
    },
    close() {
      for (const { client, upstream } of pairs) {
        client.destroy();
        upstream.destroy();
      }
      return new Promise((resolve) => {
        const fallback = setTimeout(resolve, 1000);
        server.close(() => {
          clearTimeout(fallback);
          resolve();
        });
      });
    },
  };
}
