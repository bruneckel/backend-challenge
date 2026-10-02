import { describe, expect, test } from 'bun:test';
import { ESLint } from 'eslint';

const eslint = new ESLint({ cwd: process.cwd() });

async function ruleIdsFor(code: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(`${code}\nexport {};\n`, { filePath });
  return (result?.messages ?? []).map((message) => message.ruleId ?? 'fatal');
}

describe('lint guard for layer boundaries', () => {
  test.each([
    [
      "import { SQSClient } from '@aws-sdk/client-sqs';",
      'src/wallet/application/use-cases/example.ts',
    ],
    [
      "import { MikroORM } from '@mikro-orm/postgresql';",
      'src/wallet/application/example.ts',
    ],
    [
      "import { Injectable } from '@nestjs/common';",
      'src/wallet/domain/wallet/example.ts',
    ],
    ["import { Pool } from 'pg';", 'src/messaging/domain/example.ts'],
    [
      "import { createOrm } from '@platform/database/orm';",
      'src/messaging/application/example.ts',
    ],
    [
      "import { MikroOrmWalletRepository } from '@wallet/infrastructure/persistence/mikro-orm-wallet-repository';",
      'src/wallet/application/example.ts',
    ],
    [
      "import type { WalletView } from '@wallet/application/views';",
      'src/wallet/domain/wallet/example.ts',
    ],
  ])('rejects %p in %p', async (code, filePath) => {
    expect(await ruleIdsFor(code, filePath)).toContain('no-restricted-imports');
  });

  test.each([
    [
      "import { SQSClient } from '@aws-sdk/client-sqs';",
      'src/messaging/infrastructure/example.ts',
    ],
    [
      "import { MikroORM } from '@mikro-orm/postgresql';",
      'src/platform/database/example.ts',
    ],
    [
      "import type { Clock } from '@shared/application/clock';",
      'src/wallet/application/example.ts',
    ],
    [
      "import type { OutboxMessage } from '@messaging/domain/outbox-message';",
      'src/wallet/application/example.ts',
    ],
    [
      "import { Money } from '@wallet/domain/money/money';",
      'src/wallet/domain/ledger/example.ts',
    ],
  ])('accepts %p in %p', async (code, filePath) => {
    expect(await ruleIdsFor(code, filePath)).not.toContain(
      'no-restricted-imports',
    );
  });

  test('still refuses parent-relative imports inside the guarded layers', async () => {
    expect(
      await ruleIdsFor(
        "import { Money } from '../money/money';",
        'src/wallet/domain/ledger/example.ts',
      ),
    ).toContain('no-restricted-imports');
  });
});
