import { describe, expect, test } from 'bun:test';

async function waitForLive(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(url).catch(() => undefined);
    if (response?.ok) return;
    await Bun.sleep(100);
  }
  throw new Error(`service at ${url} did not become live`);
}

describe('API process shutdown', () => {
  test('runs its shutdown hooks and exits when it receives SIGTERM', async () => {
    const port = 39_000 + Math.floor(Math.random() * 1_000);
    const child = Bun.spawn(['bun', 'src/main.api.ts'], {
      env: { ...process.env, PORT: String(port) },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await waitForLive(`http://127.0.0.1:${port}/health/live`, 15_000);

    child.kill('SIGTERM');
    const exitCode = await child.exited;
    const output = await new Response(child.stdout).text();

    expect(output).toContain('"msg":"shutdown complete"');
    expect(output).toContain('"signal":"SIGTERM"');
    expect(exitCode === 0 || exitCode === 143 || child.signalCode === 'SIGTERM').toBe(true);
  });
});
