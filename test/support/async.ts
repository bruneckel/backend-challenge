export async function rejectionOf(
  work: PromiseLike<unknown>,
): Promise<unknown> {
  try {
    await work;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the operation to fail, but it succeeded');
}

export function gate(): { open: () => void; opened: Promise<void> } {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

export async function waitUntil(
  condition: () => Promise<boolean> | boolean,
  { timeoutMs = 10_000, intervalMs = 50, description = 'condition' } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out after ${timeoutMs} ms waiting for ${description}`,
      );
    }
    await Bun.sleep(intervalMs);
  }
}
