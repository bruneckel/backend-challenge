import type { EntityManager } from '@mikro-orm/postgresql';
import { MikroOrmInboxRepository } from '@messaging/infrastructure/persistence/mikro-orm-inbox-repository';
import { MikroOrmOutboxRepository } from '@messaging/infrastructure/persistence/mikro-orm-outbox-repository';
import type { WageringScope } from '@wallet/application/ports/wagering-scope';
import { MikroOrmLedgerRepository } from './mikro-orm-ledger-repository';
import { MikroOrmWagerTransactionRepository } from './mikro-orm-wager-transaction-repository';
import { MikroOrmWalletRepository } from './mikro-orm-wallet-repository';

export function createWageringScope(em: EntityManager): WageringScope {
  return {
    wallets: new MikroOrmWalletRepository(em),
    transactions: new MikroOrmWagerTransactionRepository(em),
    ledger: new MikroOrmLedgerRepository(em),
    inbox: new MikroOrmInboxRepository(em),
    outbox: new MikroOrmOutboxRepository(em),
  };
}
