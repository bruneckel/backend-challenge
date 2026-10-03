import { arch, cpus, platform, release, totalmem } from 'node:os';
import { resolve } from 'node:path';
import type { EnvironmentInfo } from './types';

export const ROOT = resolve(import.meta.dir, '../..');

const COMPOSE = [
  'docker',
  'compose',
  '-p',
  'wagering-load',
  '-f',
  'docker-compose.yml',
  '-f',
  'test/load/compose.load.yml',
];

export const LOAD_DATABASE_URL =
  'postgresql://wagering:wagering@localhost:25432/wagering';

export const LOAD_SQS = {
  endpoint: 'http://localhost:24566',
  region: 'us-east-1',
  accessKeyId: 'test',
  secretAccessKey: 'test',
};

export async function command(args: readonly string[]): Promise<string> {
  const child = Bun.spawn([...args], {
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [output, errors, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) {
    throw new Error(`${args.join(' ')} failed with ${code}: ${errors.trim()}`);
  }
  return output.trim();
}

export const startInfra = () =>
  command([...COMPOSE, 'up', '-d', '--wait', 'postgres', 'sqs']);

export const stopInfra = () => command([...COMPOSE, 'down', '-v']);

export const pauseDatabase = () => command([...COMPOSE, 'pause', 'postgres']);

export const resumeDatabase = () =>
  command([...COMPOSE, 'unpause', 'postgres']);

const gigabytes = (bytes: number) => Math.round((bytes / 2 ** 30) * 10) / 10;

export async function environmentInfo(
  startedAt: string,
): Promise<EnvironmentInfo> {
  const [commit, branch, docker, compose] = await Promise.all([
    command(['git', 'rev-parse', '--short', 'HEAD']),
    command(['git', 'rev-parse', '--abbrev-ref', 'HEAD']),
    command([
      'docker',
      'info',
      '--format',
      '{{.ServerVersion}} {{.NCPU}} {{.MemTotal}}',
    ]),
    Bun.file(resolve(ROOT, 'docker-compose.yml')).text(),
  ]);
  const [dockerVersion = '', dockerCpus = '0', dockerMemory = '0'] =
    docker.split(' ');
  const images = [...compose.matchAll(/image:\s*(\S+)/g)].map(
    (match) => match[1] ?? '',
  );
  return {
    commit,
    branch,
    startedAt,
    os: `${platform()} ${release()} ${arch()}`,
    cpu: cpus()[0]?.model ?? 'unknown',
    cpus: cpus().length,
    memoryGb: gigabytes(totalmem()),
    bun: Bun.version,
    docker: dockerVersion,
    dockerCpus: Number(dockerCpus),
    dockerMemoryGb: gigabytes(Number(dockerMemory)),
    postgres: images.find((image) => image.startsWith('postgres')) ?? '',
    ministack: images.find((image) => image.includes('ministack')) ?? '',
  };
}
