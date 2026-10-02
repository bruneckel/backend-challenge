import { describe, expect, test } from 'bun:test';
import { ESLint } from 'eslint';

const eslint = new ESLint({ cwd: process.cwd() });

async function ruleIdsFor(code: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).map((message) => message.ruleId ?? 'fatal');
}

const sample = (expression: string) =>
  `export const value = (amount: string, big: { toNumber(): number }) => ${expression};\n`;

describe('lint guard against numbers in domain and application code', () => {
  test.each([
    ['parseFloat(amount)', 'no-restricted-globals'],
    ['parseInt(amount, 10)', 'no-restricted-globals'],
    ['Number(amount)', 'no-restricted-syntax'],
    ['Number.parseFloat(amount)', 'no-restricted-properties'],
    ['big.toNumber()', 'no-restricted-properties'],
  ])('forbids %p in domain code', async (expression, ruleId) => {
    expect(await ruleIdsFor(sample(expression), 'src/wallet/domain/example.ts')).toContain(ruleId);
  });

  test('applies the same guard to application code', async () => {
    expect(await ruleIdsFor(sample('Number(amount)'), 'src/wallet/application/example.ts')).toContain(
      'no-restricted-syntax',
    );
  });

  test('allows Number() in platform code such as configuration parsing', async () => {
    const ruleIds = await ruleIdsFor(
      'export const port = (raw: string) => Number(raw);\n',
      'src/platform/config/example.ts',
    );

    expect(ruleIds).not.toContain('no-restricted-syntax');
  });
});
