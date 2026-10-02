import { describe, expect, test } from 'bun:test';
import { ESLint } from 'eslint';

const eslint = new ESLint({ cwd: process.cwd() });

async function ruleIdsFor(code: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).map((message) => message.ruleId ?? 'fatal');
}

describe('lint guard for path aliases', () => {
  test.each([
    [
      "import { DomainError } from '../../../shared/domain/domain-error';",
      'src/wallet/domain/money/example.ts',
    ],
    [
      "import { Money } from '../money/money';",
      'src/wallet/domain/ledger/example.ts',
    ],
    [
      "import { Money } from '../../../../src/wallet/domain/money/money';",
      'test/unit/wallet/domain/example.test.ts',
    ],
  ])('rejects the parent-relative import %p', async (code, filePath) => {
    expect(await ruleIdsFor(`${code}\nexport {};\n`, filePath)).toContain(
      'no-restricted-imports',
    );
  });

  test.each([
    [
      "import { DomainError } from '@shared/domain/domain-error';",
      'src/wallet/domain/money/example.ts',
    ],
    ["import { support } from './support';", 'test/spike/example.test.ts'],
  ])('accepts %p', async (code, filePath) => {
    expect(await ruleIdsFor(`${code}\nexport {};\n`, filePath)).not.toContain(
      'no-restricted-imports',
    );
  });
});
