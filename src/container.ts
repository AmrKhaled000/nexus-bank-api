import type { AppConfig } from './config/env';
import { config as defaultConfig } from './config/env';
import { createEmailDispatcher } from './infrastructure/email/create-email-dispatcher';
import type { EmailDispatcher } from './infrastructure/email/email-dispatcher';
import { createPaymentGateway, createPayoutGateway } from './infrastructure/payments/gateway-factory';
import type { PaymentGateway, PayoutGateway } from './infrastructure/payments/types';
import { createPayoutQueue, type PayoutQueue } from './infrastructure/queue/queues';
import { LedgerService } from './modules/ledger/ledger.service';
import type { WalletRepository} from './modules/wallets/wallet.repository';
import { walletRepository } from './modules/wallets/wallet.repository';
import { WalletService } from './modules/wallets/wallet.service';
import { TransactionRepository } from './modules/transactions/transaction.repository';
import { TransactionService } from './modules/transactions/transaction.service';
import { StatementService } from './modules/reports/statement.service';
import { TransferService } from './modules/transfers/transfer.service';
import { DepositService } from './modules/deposits/deposit.service';
import { WithdrawalService } from './modules/withdrawals/withdrawal.service';
import { PaymentMethodService } from './modules/payment-methods/payment-method.service';
import { PaymentWebhookService } from './modules/webhooks/payment-webhook.service';
import { NotificationService } from './modules/notifications/notification.service';
import { SecurityEventService } from './modules/security/security-event.service';
import { PinService } from './modules/security/pin.service';
import { AuditService } from './modules/audit/audit.service';
import { AdminService } from './modules/admin/admin.service';
import { UserService } from './modules/users/user.service';
import { AuthService } from './modules/auth/auth.service';
import { TokenService } from './modules/auth/token.service';
import { TotpService } from './modules/auth/totp.service';
import type { IdempotencyService } from './modules/idempotency/idempotency.service';
import { idempotencyService } from './modules/idempotency/idempotency.service';
import type { FeeService, LimitService } from './modules/limits/limit.service';
import { feeService, limitService } from './modules/limits/limit.service';

export interface AppServices {
  config: AppConfig;
  email: EmailDispatcher;
  tokens: TokenService;
  totp: TotpService;
  securityEvents: SecurityEventService;
  audit: AuditService;
  pins: PinService;
  auth: AuthService;
  users: UserService;
  ledger: LedgerService;
  wallets: WalletRepository;
  walletService: WalletService;
  transactions: TransactionRepository;
  transactionService: TransactionService;
  statements: StatementService;
  transfers: TransferService;
  deposits: DepositService;
  withdrawals: WithdrawalService;
  paymentMethods: PaymentMethodService;
  notifications: NotificationService;
  admin: AdminService;
  webhooks: PaymentWebhookService;
  paymentGateway: PaymentGateway;
  payoutGateway: PayoutGateway;
  payoutQueue: PayoutQueue | null;
  idempotency: IdempotencyService;
  limits: LimitService;
  fees: FeeService;
  /** Releases non-database resources (BullMQ connections). Safe to call more than once. */
  close(): Promise<void>;
}

export interface CreateServicesOptions {
  config?: AppConfig;
  email?: EmailDispatcher;
  payoutQueue?: PayoutQueue | null;
}

/**
 * Composition root for domain services. HTTP wiring lives in `app.ts` so the same objects can
 * back both the API process and the background worker without creating a second connection pool.
 */
export function createServices(options: CreateServicesOptions = {}): AppServices {
  const config = options.config ?? defaultConfig;
  const email = options.email ?? createEmailDispatcher(config);
  const tokens = new TokenService(config);
  const totp = new TotpService(config);
  const securityEvents = new SecurityEventService();
  const audit = new AuditService();
  const pins = new PinService(config, securityEvents);
  const idempotency = idempotencyService;
  const limits = limitService;
  const fees = feeService;
  const notifications = new NotificationService();

  const auth = new AuthService(config, tokens, totp, securityEvents, email);
  const users = new UserService(audit, securityEvents);

  const ledger = new LedgerService();
  const wallets = walletRepository;
  const walletService = new WalletService(undefined, ledger, config, wallets);

  const transactionRepository = new TransactionRepository();
  const transactionService = new TransactionService(transactionRepository, wallets);
  const statements = new StatementService(wallets, transactionRepository);

  const transfers = new TransferService(
    undefined,
    wallets,
    ledger,
    limits,
    fees,
    idempotency,
    notifications,
    securityEvents,
    audit,
    pins,
    config,
  );

  const paymentGateway = createPaymentGateway(config);
  const payoutGateway = createPayoutGateway(config);
  const payoutQueue =
    options.payoutQueue !== undefined ? options.payoutQueue : createPayoutQueue(config);

  const deposits = new DepositService(
    undefined,
    ledger,
    wallets,
    limits,
    idempotency,
    notifications,
    audit,
    config,
  );

  const withdrawals = new WithdrawalService(
    undefined,
    ledger,
    wallets,
    limits,
    fees,
    idempotency,
    notifications,
    securityEvents,
    audit,
    pins,
    config,
    payoutGateway,
    payoutQueue,
  );

  const paymentMethods = new PaymentMethodService(undefined, wallets);
  const admin = new AdminService(
    undefined,
    ledger,
    wallets,
    idempotency,
    notifications,
    securityEvents,
    audit,
  );
  const webhooks = new PaymentWebhookService(
    undefined,
    ledger,
    wallets,
    notifications,
    securityEvents,
    audit,
    config,
  );

  let closed = false;
  return {
    config,
    email,
    tokens,
    totp,
    securityEvents,
    audit,
    pins,
    auth,
    users,
    ledger,
    wallets,
    walletService,
    transactions: transactionRepository,
    transactionService,
    statements,
    transfers,
    deposits,
    withdrawals,
    paymentMethods,
    notifications,
    admin,
    webhooks,
    paymentGateway,
    payoutGateway,
    payoutQueue,
    idempotency,
    limits,
    fees,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await payoutQueue?.close();
    },
  };
}
