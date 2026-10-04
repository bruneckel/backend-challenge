import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  headingSlugs,
  relativeLinks,
  scriptsRun,
  slugify,
} from '@test/support/markdown';

const ROOT = resolve(import.meta.dir, '../../..');
const DOCUMENTS = ['README.md', 'ARCHITECTURE.md', 'LOAD-TEST.md'];

describe('markdown helpers', () => {
  test('slugs headings the way GitHub does', () => {
    expect(slugify('10. API e status HTTP')).toBe('10-api-e-status-http');
    expect(slugify('Streams de tempo real (Etapa 3)')).toBe(
      'streams-de-tempo-real-etapa-3',
    );
    expect(slugify('Por que `numeric` sem precisão')).toBe(
      'por-que-numeric-sem-precisão',
    );
  });

  test('numbers repeated headings and ignores fenced code', () => {
    expect([
      ...headingSlugs('# Testes\n## Testes\n```\n# not a heading\n```\n'),
    ]).toEqual(['testes', 'testes-1']);
  });

  test('lists relative links with their anchors and skips external ones', () => {
    expect(
      relativeLinks(
        '[a](ARCHITECTURE.md#api-http) [b](https://x.dev) [c](#local) [d](LOAD-TEST.md)',
      ),
    ).toEqual([
      { target: 'ARCHITECTURE.md', anchor: 'api-http' },
      { target: '', anchor: 'local' },
      { target: 'LOAD-TEST.md' },
    ]);
  });

  test('lists the scripts a document runs', () => {
    expect(
      scriptsRun(
        'bun run test\nbun run test:load --preset smoke\nbun run test',
      ),
    ).toEqual(['test', 'test:load']);
  });
});

describe('project documentation', () => {
  test.each(DOCUMENTS)(
    '%s links only to files and headings that exist',
    async (document) => {
      const source = resolve(ROOT, document);
      const broken: string[] = [];
      for (const link of relativeLinks(await Bun.file(source).text())) {
        const target =
          link.target === '' ? source : resolve(dirname(source), link.target);
        if (!existsSync(target)) {
          broken.push(link.target);
        } else if (
          link.anchor !== undefined &&
          target.endsWith('.md') &&
          !headingSlugs(await Bun.file(target).text()).has(link.anchor)
        ) {
          broken.push(`${link.target}#${link.anchor}`);
        }
      }

      expect(broken).toEqual([]);
    },
  );

  test('README runs only scripts that package.json defines', async () => {
    const readme = await Bun.file(resolve(ROOT, 'README.md')).text();
    const { scripts } = (await Bun.file(
      resolve(ROOT, 'package.json'),
    ).json()) as { scripts: Record<string, string> };

    expect(scriptsRun(readme).filter((script) => !(script in scripts))).toEqual(
      [],
    );
  });

  test('ARCHITECTURE.md documents every problem code the API answers', async () => {
    const problems = await Bun.file(
      resolve(ROOT, 'src/platform/http/problem.ts'),
    ).text();
    const architecture = await Bun.file(
      resolve(ROOT, 'ARCHITECTURE.md'),
    ).text();
    const codes = [...problems.matchAll(/^ {2}([A-Z][A-Z_]+): \{/gm)].map(
      (match) => match[1]!,
    );

    expect(codes.length).toBeGreaterThan(0);
    expect(
      codes.filter((code) => !architecture.includes(`\`${code}\``)),
    ).toEqual([]);
  });

  test('README shell blocks leave no placeholder to fill in by hand', async () => {
    const readme = await Bun.file(resolve(ROOT, 'README.md')).text();

    expect(readme.match(/^\s*[A-Z_]+=<[^>\n]+>/gm) ?? []).toEqual([]);
  });
});
