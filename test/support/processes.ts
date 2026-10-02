import { waitUntil } from './async';

export interface SpawnedProcess {
  readonly name: string;
  readonly exited: Promise<number>;
  output(): string;
  port(): number | undefined;
  kill(signal: NodeJS.Signals): void;
}

export interface RunningProcess {
  readonly url: string;
  readonly instanceId: string;
  output(): string;
  stop(signal?: NodeJS.Signals): Promise<number>;
}

interface Collected {
  text: string;
}

async function pump(
  stream: ReadableStream<Uint8Array>,
  sink: Collected,
  onLine: (line: string) => void,
): Promise<void> {
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
    return typeof entry.msg === 'string' &&
      entry.msg.endsWith(' listening') &&
      typeof entry.port === 'number'
      ? entry.port
      : undefined;
  } catch {
    return undefined;
  }
}

export function spawnProcess(
  entrypoint: string,
  environment: Record<string, string>,
  name = entrypoint,
): SpawnedProcess {
  const child = Bun.spawn(['bun', entrypoint], {
    env: { ...process.env, PORT: '0', ...environment },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const collected: Collected = { text: '' };
  let port: number | undefined;
  void pump(child.stdout, collected, (line) => {
    port ??= listeningPort(line);
  });
  void pump(child.stderr, collected, () => undefined);
  return {
    name,
    exited: child.exited,
    output: () => collected.text,
    port: () => port,
    kill: (signal) => child.kill(signal),
  };
}

export async function startProcess(
  entrypoint: string,
  environment: Record<string, string>,
  timeoutMs = 20_000,
): Promise<RunningProcess> {
  const instanceId =
    environment.INSTANCE_ID ??
    `${entrypoint.split('/').at(-1)}-${Bun.randomUUIDv7()}`;
  const spawned = spawnProcess(
    entrypoint,
    { INSTANCE_ID: instanceId, ...environment },
    instanceId,
  );
  let exitCode: number | undefined;
  void spawned.exited.then((code) => {
    exitCode = code;
  });
  await waitUntil(
    () => spawned.port() !== undefined || exitCode !== undefined,
    {
      timeoutMs,
      description: `${instanceId} to listen`,
    },
  );
  const port = spawned.port();
  if (port === undefined) {
    throw new Error(
      `${instanceId} exited before listening:\n${spawned.output()}`,
    );
  }
  const url = `http://127.0.0.1:${port}`;
  await waitUntil(
    async () =>
      (await fetch(`${url}/health/ready`).catch(() => undefined))?.status ===
      200,
    {
      timeoutMs,
      description: `${instanceId} to become ready`,
    },
  );
  return {
    url,
    instanceId,
    output: spawned.output,
    async stop(signal: NodeJS.Signals = 'SIGTERM') {
      spawned.kill(signal);
      const timer = setTimeout(() => spawned.kill('SIGKILL'), 15_000);
      const code = await spawned.exited;
      clearTimeout(timer);
      return code;
    },
  };
}

export const startApiProcess = (
  environment: Record<string, string>,
  timeoutMs?: number,
) => startProcess('src/main.api.ts', environment, timeoutMs);

export const startWorkerProcess = (
  environment: Record<string, string>,
  timeoutMs?: number,
) => startProcess('src/main.worker.ts', environment, timeoutMs);
