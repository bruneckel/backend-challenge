import { waitUntil } from './async';

export interface RunningProcess {
  readonly url: string;
  readonly instanceId: string;
  output(): string;
  stop(signal?: NodeJS.Signals): Promise<number>;
}

interface Collected {
  text: string;
}

async function pump(stream: ReadableStream<Uint8Array>, sink: Collected, onLine: (line: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  let pending = '';
  for await (const chunk of stream) {
    const text = decoder.decode(chunk, { stream: true });
    sink.text += text;
    pending += text;
    let newline = pending.indexOf('\n');
    while (newline >= 0) {
      onLine(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
      newline = pending.indexOf('\n');
    }
  }
}

function listeningPort(line: string): number | undefined {
  try {
    const entry = JSON.parse(line) as { msg?: unknown; port?: unknown };
    return entry.msg === 'api listening' && typeof entry.port === 'number' ? entry.port : undefined;
  } catch {
    return undefined;
  }
}

export async function startApiProcess(environment: Record<string, string>, timeoutMs = 20_000): Promise<RunningProcess> {
  const instanceId = environment.INSTANCE_ID ?? `api-${Bun.randomUUIDv7()}`;
  const child = Bun.spawn(['bun', 'src/main.api.ts'], {
    env: { ...process.env, PORT: '0', INSTANCE_ID: instanceId, ...environment },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const collected: Collected = { text: '' };
  let port: number | undefined;
  void pump(child.stdout, collected, (line) => {
    port ??= listeningPort(line);
  });
  void pump(child.stderr, collected, () => undefined);
  await waitUntil(() => port !== undefined || child.exitCode !== null, { timeoutMs, description: `${instanceId} to listen` });
  if (port === undefined) {
    throw new Error(`${instanceId} exited before listening:\n${collected.text}`);
  }
  const url = `http://127.0.0.1:${port}`;
  await waitUntil(
    async () => (await fetch(`${url}/health/ready`).catch(() => undefined))?.status === 200,
    { timeoutMs, description: `${instanceId} to become ready` },
  );
  return {
    url,
    instanceId,
    output: () => collected.text,
    async stop(signal: NodeJS.Signals = 'SIGTERM') {
      child.kill(signal);
      const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
      const code = await child.exited;
      clearTimeout(timer);
      return code;
    },
  };
}
