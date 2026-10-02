import type { InboxRepository } from '@messaging/application/ports/inbox-repository';
import type { OutboxRepository } from '@messaging/application/ports/outbox-repository';
import type { LedgerRepository } from './ledger-repository';
import type { WagerTransactionRepository } from './wager-transaction-repository';
import type { WalletRepository } from './wallet-repository';

export interface WageringScope {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  inbox: InboxRepository;
  outbox: OutboxRepository;
}
