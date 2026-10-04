import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../../..');

interface Step {
  uses?: string;
  run?: string;
  with?: Record<string, string>;
}

interface Job {
  services?: Record<string, { image: string }>;
  steps: Step[];
}

interface Workflow {
  on: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
}

const parsed = async <T>(path: string): Promise<T> =>
  Bun.YAML.parse(await Bun.file(resolve(ROOT, path)).text()) as T;

const workflow = () => parsed<Workflow>('.github/workflows/ci.yml');

const stepsOf = (current: Workflow) =>
  Object.values(current.jobs).flatMap((job) => job.steps);

describe('CI workflow', () => {
  test('runs on every pull request and on main with read-only permissions', async () => {
    const current = await workflow();

    expect(Object.keys(current.on).sort()).toEqual(['pull_request', 'push']);
    expect(current.on.push).toEqual({ branches: ['main'] });
    expect(current.permissions).toEqual({ contents: 'read' });
  });

  test('pins every action to a commit', async () => {
    const unpinned = stepsOf(await workflow()).flatMap((step) =>
      step.uses === undefined || /@[0-9a-f]{40}$/.test(step.uses)
        ? []
        : [step.uses],
    );

    expect(unpinned).toEqual([]);
  });

  test('uses the Bun version and the service images of the project', async () => {
    const current = await workflow();
    const compose = await parsed<{
      services: Record<string, { image?: string }>;
    }>('docker-compose.yml');
    const dockerfile = await Bun.file(resolve(ROOT, 'Dockerfile')).text();
    const bunVersions = new Set(
      stepsOf(current).flatMap((step) =>
        step.with?.['bun-version'] === undefined
          ? []
          : [step.with['bun-version']],
      ),
    );

    expect([...bunVersions]).toEqual([
      dockerfile.match(/oven\/bun:([0-9.]+)-alpine/)?.[1] ?? 'missing',
    ]);
    expect(current.jobs.test?.services?.postgres?.image).toBe(
      compose.services.postgres?.image,
    );
    expect(current.jobs.test?.services?.sqs?.image).toBe(
      compose.services.sqs?.image,
    );
  });

  test('runs lint, typecheck, the suite, the spike and the end-to-end checks', async () => {
    const commands = stepsOf(await workflow()).flatMap((step) =>
      step.run === undefined ? [] : [step.run],
    );

    expect(
      [
        'bun run lint',
        'bun run typecheck',
        'bun run test',
        'bun run test:spike',
        'bun run test:e2e',
      ].filter((command) => !commands.includes(command)),
    ).toEqual([]);
  });
});
