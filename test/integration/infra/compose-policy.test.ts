import { beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../../..');

interface Service {
  image?: string;
  build?: { context: string; dockerfile: string };
  read_only?: boolean;
  cap_drop?: string[];
  security_opt?: string[];
  deploy?: { resources?: { limits?: { cpus?: number; memory?: string } } };
}

let services: Record<string, Service>;

beforeAll(async () => {
  const child = Bun.spawn(
    [
      'docker',
      'compose',
      '--profile',
      'observability',
      'config',
      '--format',
      'json',
    ],
    { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' },
  );
  const [output, code] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ]);
  expect(code).toBe(0);
  services = (JSON.parse(output) as { services: Record<string, Service> })
    .services;
});

async function baseImagesOf(service: Service): Promise<string[]> {
  if (service.build === undefined) {
    return [service.image ?? ''];
  }
  const dockerfile = await Bun.file(
    resolve(service.build.context, service.build.dockerfile),
  ).text();
  return [...dockerfile.matchAll(/^FROM\s+(\S+)/gm)].map((match) => match[1]!);
}

const each = (check: (name: string, service: Service) => unknown[]) =>
  Object.entries(services).flatMap(([name, service]) => check(name, service));

describe('compose hardening', () => {
  test('pins every image by digest', async () => {
    const unpinned: string[] = [];
    for (const [name, service] of Object.entries(services)) {
      for (const image of await baseImagesOf(service)) {
        if (!/^[^@\s]+:[^@\s]+@sha256:[0-9a-f]{64}$/.test(image)) {
          unpinned.push(`${name}: ${image}`);
        }
      }
    }

    expect(unpinned).toEqual([]);
  });

  test('runs every container with a read-only root filesystem', () => {
    expect(
      each((name, service) => (service.read_only === true ? [] : [name])),
    ).toEqual([]);
  });

  test('drops every capability and forbids gaining new privileges', () => {
    expect(
      each((name, service) =>
        service.cap_drop?.includes('ALL') &&
        service.security_opt?.includes('no-new-privileges:true')
          ? []
          : [name],
      ),
    ).toEqual([]);
  });

  test('limits the CPU and the memory of every container', () => {
    expect(
      each((name, service) => {
        const limits = service.deploy?.resources?.limits;
        return limits?.cpus !== undefined && limits.memory !== undefined
          ? []
          : [name];
      }),
    ).toEqual([]);
  });
});
