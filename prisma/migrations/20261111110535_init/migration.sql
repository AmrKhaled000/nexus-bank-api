-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('CUSTOMER', 'SUPPORT', 'FINANCE_ADMIN', 'SUPER_ADMIN');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'PENDING_VERIFICATION', 'SUSPENDED', 'FROZEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "WalletType" AS ENUM ('PERSONAL', 'SAVINGS');

-- CreateEnum
CREATE TYPE "WalletStatus" AS ENUM ('ACTIVE', 'PENDING_VERIFICATION', 'SUSPENDED', 'FROZEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "LedgerAccountType" AS ENUM ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE');

-- CreateEnum
CREATE TYPE "NormalBalance" AS ENUM ('DEBIT', 'CREDIT');

-- CreateEnum
CREATE TYPE "JournalEntryStatus" AS ENUM ('POSTED');

-- CreateEnum
CREATE TYPE "TransactionType" AS ENUM ('DEPOSIT', 'WITHDRAWAL', 'TRANSFER', 'FEE', 'REFUND', 'REVERSAL', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "TransactionStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED', 'REVERSED');

-- CreateEnum
CREATE TYPE "DepositStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "WithdrawalStatus" AS ENUM ('PENDING', 'UNDER_REVIEW', 'APPROVED', 'PROCESSING', 'COMPLETED', 'REJECTED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PaymentProvider" AS ENUM ('SIMULATED', 'STRIPE');

-- CreateEnum
CREATE TYPE "PaymentMethodType" AS ENUM ('PAYOUT_BANK_ACCOUNT');

-- CreateEnum
CREATE TYPE "IdempotencyStatus" AS ENUM ('IN_PROGRESS', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "VerificationPurpose" AS ENUM ('EMAIL_VERIFICATION', 'PASSWORD_RESET');

-- CreateEnum
CREATE TYPE "LimitScope" AS ENUM ('TRANSFER', 'DEPOSIT', 'WITHDRAWAL');

-- CreateEnum
CREATE TYPE "FeeOperation" AS ENUM ('TRANSFER', 'WITHDRAWAL', 'DEPOSIT');

-- CreateEnum
CREATE TYPE "HoldStatus" AS ENUM ('ACTIVE', 'CONSUMED', 'RELEASED');

-- CreateEnum
CREATE TYPE "WebhookStatus" AS ENUM ('PROCESSED', 'IGNORED', 'FAILED');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('EMAIL_VERIFICATION', 'PASSWORD_RESET', 'DEPOSIT_COMPLETED', 'DEPOSIT_FAILED', 'TRANSFER_SENT', 'TRANSFER_RECEIVED', 'WITHDRAWAL_UPDATE', 'ACCOUNT_UPDATE', 'SECURITY_ALERT', 'STATEMENT_READY');

-- CreateEnum
CREATE TYPE "SecuritySeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "SecurityEventType" AS ENUM ('LOGIN_FAILED', 'LOGIN_LOCKED', 'REFRESH_TOKEN_REUSE', 'PIN_FAILED', 'PIN_LOCKED', 'PASSWORD_CHANGED', 'PASSWORD_RESET', 'TWO_FACTOR_ENABLED', 'TWO_FACTOR_DISABLED', 'WEBHOOK_SIGNATURE_INVALID', 'SUSPICIOUS_TRANSACTION', 'ADMIN_ACTION', 'ACCOUNT_STATUS_CHANGED');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "pinHash" TEXT,
    "pinSetAt" TIMESTAMPTZ(3),
    "role" "UserRole" NOT NULL DEFAULT 'CUSTOMER',
    "status" "UserStatus" NOT NULL DEFAULT 'PENDING_VERIFICATION',
    "emailVerifiedAt" TIMESTAMPTZ(3),
    "totpSecretEncrypted" TEXT,
    "totpEnabled" BOOLEAN NOT NULL DEFAULT false,
    "totpLastUsedStep" INTEGER,
    "failedLoginAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMPTZ(3),
    "pinFailedAttempts" INTEGER NOT NULL DEFAULT 0,
    "pinLockedUntil" TIMESTAMPTZ(3),
    "lastLoginAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceName" TEXT,
    "userAgent" TEXT,
    "ipHash" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),
    "revokedReason" TEXT,

    CONSTRAINT "user_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "usedAt" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),
    "replacedByTokenId" TEXT,
    "reuseDetectedAt" TIMESTAMPTZ(3),

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_verifications" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "purpose" "VerificationPurpose" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "consumedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "currencies" (
    "code" VARCHAR(3) NOT NULL,
    "name" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "exponent" INTEGER NOT NULL DEFAULT 2,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "currencies_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "wallets" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "currencyCode" VARCHAR(3) NOT NULL,
    "name" TEXT NOT NULL,
    "type" "WalletType" NOT NULL DEFAULT 'PERSONAL',
    "status" "WalletStatus" NOT NULL DEFAULT 'ACTIVE',
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "closedAt" TIMESTAMPTZ(3),

    CONSTRAINT "wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_accounts" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "ledgerAccountId" TEXT NOT NULL,
    "balanceMinor" BIGINT NOT NULL DEFAULT 0,
    "heldMinor" BIGINT NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "wallet_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_accounts" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "LedgerAccountType" NOT NULL,
    "normalBalance" "NormalBalance" NOT NULL,
    "currencyCode" VARCHAR(3) NOT NULL,
    "walletId" TEXT,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_holds" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "status" "HoldStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "releasedAt" TIMESTAMPTZ(3),
    "consumedAt" TIMESTAMPTZ(3),

    CONSTRAINT "wallet_holds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_entries" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "transactionId" TEXT,
    "createdById" TEXT,
    "currencyCode" VARCHAR(3) NOT NULL,
    "description" TEXT NOT NULL,
    "status" "JournalEntryStatus" NOT NULL DEFAULT 'POSTED',
    "reversesEntryId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "journal_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_entry_lines" (
    "id" BIGSERIAL NOT NULL,
    "journalEntryId" TEXT NOT NULL,
    "ledgerAccountId" TEXT NOT NULL,
    "debitMinor" BIGINT NOT NULL DEFAULT 0,
    "creditMinor" BIGINT NOT NULL DEFAULT 0,
    "description" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "journal_entry_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "financial_transactions" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "type" "TransactionType" NOT NULL,
    "status" "TransactionStatus" NOT NULL DEFAULT 'PENDING',
    "amountMinor" BIGINT NOT NULL,
    "feeMinor" BIGINT NOT NULL DEFAULT 0,
    "currencyCode" VARCHAR(3) NOT NULL,
    "initiatorUserId" TEXT,
    "sourceWalletId" TEXT,
    "destinationWalletId" TEXT,
    "description" TEXT,
    "failureCode" TEXT,
    "failureReason" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "completedAt" TIMESTAMPTZ(3),

    CONSTRAINT "financial_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transfers" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "senderUserId" TEXT NOT NULL,
    "recipientUserId" TEXT NOT NULL,
    "sourceWalletId" TEXT NOT NULL,
    "destinationWalletId" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "feeMinor" BIGINT NOT NULL DEFAULT 0,
    "currencyCode" VARCHAR(3) NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deposits" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "currencyCode" VARCHAR(3) NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "providerReference" TEXT NOT NULL,
    "status" "DepositStatus" NOT NULL DEFAULT 'PENDING',
    "failureCode" TEXT,
    "failureReason" TEXT,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "completedAt" TIMESTAMPTZ(3),

    CONSTRAINT "deposits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "withdrawals" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "currencyCode" VARCHAR(3) NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "feeMinor" BIGINT NOT NULL DEFAULT 0,
    "status" "WithdrawalStatus" NOT NULL DEFAULT 'PENDING',
    "payoutMethodId" TEXT NOT NULL,
    "payoutReference" TEXT,
    "payoutAttempts" INTEGER NOT NULL DEFAULT 0,
    "lastPayoutError" TEXT,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMPTZ(3),
    "reviewNote" TEXT,
    "rejectionReason" TEXT,
    "failureCode" TEXT,
    "failureReason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "completedAt" TIMESTAMPTZ(3),

    CONSTRAINT "withdrawals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_methods" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "PaymentMethodType" NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "providerToken" TEXT NOT NULL,
    "bankName" TEXT NOT NULL,
    "accountLast4" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "payment_methods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "status" "IdempotencyStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "responseStatus" INTEGER,
    "responseBody" JSONB,
    "resourceType" TEXT,
    "resourceId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ(3),
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transaction_limits" (
    "id" TEXT NOT NULL,
    "scope" "LimitScope" NOT NULL,
    "currencyCode" VARCHAR(3) NOT NULL,
    "userId" TEXT,
    "perTransactionMinMinor" BIGINT NOT NULL DEFAULT 1,
    "perTransactionMaxMinor" BIGINT NOT NULL,
    "dailyMaxMinor" BIGINT,
    "monthlyMaxMinor" BIGINT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "transaction_limits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fee_policies" (
    "id" TEXT NOT NULL,
    "operation" "FeeOperation" NOT NULL,
    "currencyCode" VARCHAR(3) NOT NULL,
    "flatMinor" BIGINT NOT NULL DEFAULT 0,
    "percentBps" INTEGER NOT NULL DEFAULT 0,
    "minFeeMinor" BIGINT NOT NULL DEFAULT 0,
    "maxFeeMinor" BIGINT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "fee_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "actorUserId" TEXT,
    "actorRole" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "beforeState" JSONB,
    "afterState" JSONB,
    "reason" TEXT,
    "requestId" TEXT,
    "ipHash" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "data" JSONB,
    "readAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "security_events" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "type" "SecurityEventType" NOT NULL,
    "severity" "SecuritySeverity" NOT NULL,
    "ipHash" TEXT,
    "userAgent" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "security_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" TEXT NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "eventId" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "status" "WebhookStatus" NOT NULL DEFAULT 'PROCESSED',
    "error" TEXT,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMPTZ(3),

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_status_createdAt_idx" ON "users"("status", "createdAt");

-- CreateIndex
CREATE INDEX "users_role_status_idx" ON "users"("role", "status");

-- CreateIndex
CREATE INDEX "user_sessions_userId_revokedAt_idx" ON "user_sessions"("userId", "revokedAt");

-- CreateIndex
CREATE INDEX "user_sessions_expiresAt_idx" ON "user_sessions"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_tokenHash_key" ON "refresh_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "refresh_tokens_sessionId_idx" ON "refresh_tokens"("sessionId");

-- CreateIndex
CREATE INDEX "refresh_tokens_expiresAt_idx" ON "refresh_tokens"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "user_verifications_tokenHash_key" ON "user_verifications"("tokenHash");

-- CreateIndex
CREATE INDEX "user_verifications_userId_purpose_idx" ON "user_verifications"("userId", "purpose");

-- CreateIndex
CREATE INDEX "user_verifications_expiresAt_idx" ON "user_verifications"("expiresAt");

-- CreateIndex
CREATE INDEX "wallets_userId_status_idx" ON "wallets"("userId", "status");

-- CreateIndex
CREATE INDEX "wallets_currencyCode_idx" ON "wallets"("currencyCode");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_accounts_walletId_key" ON "wallet_accounts"("walletId");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_accounts_ledgerAccountId_key" ON "wallet_accounts"("ledgerAccountId");

-- CreateIndex
CREATE INDEX "wallet_accounts_ledgerAccountId_idx" ON "wallet_accounts"("ledgerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_accounts_code_key" ON "ledger_accounts"("code");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_accounts_walletId_key" ON "ledger_accounts"("walletId");

-- CreateIndex
CREATE INDEX "ledger_accounts_type_currencyCode_idx" ON "ledger_accounts"("type", "currencyCode");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_holds_transactionId_key" ON "wallet_holds"("transactionId");

-- CreateIndex
CREATE INDEX "wallet_holds_walletId_status_idx" ON "wallet_holds"("walletId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "journal_entries_reference_key" ON "journal_entries"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "journal_entries_reversesEntryId_key" ON "journal_entries"("reversesEntryId");

-- CreateIndex
CREATE INDEX "journal_entries_transactionId_idx" ON "journal_entries"("transactionId");

-- CreateIndex
CREATE INDEX "journal_entries_currencyCode_createdAt_idx" ON "journal_entries"("currencyCode", "createdAt");

-- CreateIndex
CREATE INDEX "journal_entries_createdAt_idx" ON "journal_entries"("createdAt");

-- CreateIndex
CREATE INDEX "journal_entry_lines_journalEntryId_idx" ON "journal_entry_lines"("journalEntryId");

-- CreateIndex
CREATE INDEX "journal_entry_lines_ledgerAccountId_idx" ON "journal_entry_lines"("ledgerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "financial_transactions_reference_key" ON "financial_transactions"("reference");

-- CreateIndex
CREATE INDEX "financial_transactions_initiatorUserId_createdAt_idx" ON "financial_transactions"("initiatorUserId", "createdAt");

-- CreateIndex
CREATE INDEX "financial_transactions_sourceWalletId_createdAt_idx" ON "financial_transactions"("sourceWalletId", "createdAt");

-- CreateIndex
CREATE INDEX "financial_transactions_destinationWalletId_createdAt_idx" ON "financial_transactions"("destinationWalletId", "createdAt");

-- CreateIndex
CREATE INDEX "financial_transactions_type_status_createdAt_idx" ON "financial_transactions"("type", "status", "createdAt");

-- CreateIndex
CREATE INDEX "financial_transactions_currencyCode_createdAt_idx" ON "financial_transactions"("currencyCode", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "transfers_transactionId_key" ON "transfers"("transactionId");

-- CreateIndex
CREATE INDEX "transfers_senderUserId_createdAt_idx" ON "transfers"("senderUserId", "createdAt");

-- CreateIndex
CREATE INDEX "transfers_recipientUserId_createdAt_idx" ON "transfers"("recipientUserId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "deposits_transactionId_key" ON "deposits"("transactionId");

-- CreateIndex
CREATE UNIQUE INDEX "deposits_providerReference_key" ON "deposits"("providerReference");

-- CreateIndex
CREATE INDEX "deposits_userId_createdAt_idx" ON "deposits"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "deposits_walletId_createdAt_idx" ON "deposits"("walletId", "createdAt");

-- CreateIndex
CREATE INDEX "deposits_status_expiresAt_idx" ON "deposits"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "withdrawals_transactionId_key" ON "withdrawals"("transactionId");

-- CreateIndex
CREATE INDEX "withdrawals_userId_createdAt_idx" ON "withdrawals"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "withdrawals_walletId_createdAt_idx" ON "withdrawals"("walletId", "createdAt");

-- CreateIndex
CREATE INDEX "withdrawals_status_createdAt_idx" ON "withdrawals"("status", "createdAt");

-- CreateIndex
CREATE INDEX "payment_methods_userId_deletedAt_idx" ON "payment_methods"("userId", "deletedAt");

-- CreateIndex
CREATE INDEX "idempotency_keys_expiresAt_idx" ON "idempotency_keys"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_keys_userId_scope_key_key" ON "idempotency_keys"("userId", "scope", "key");

-- CreateIndex
CREATE INDEX "transaction_limits_scope_currencyCode_isActive_idx" ON "transaction_limits"("scope", "currencyCode", "isActive");

-- CreateIndex
CREATE INDEX "transaction_limits_userId_idx" ON "transaction_limits"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "fee_policies_operation_currencyCode_key" ON "fee_policies"("operation", "currencyCode");

-- CreateIndex
CREATE INDEX "audit_logs_actorUserId_createdAt_idx" ON "audit_logs"("actorUserId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_entityType_entityId_idx" ON "audit_logs"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "audit_logs_action_createdAt_idx" ON "audit_logs"("action", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_createdAt_idx" ON "audit_logs"("createdAt");

-- CreateIndex
CREATE INDEX "notifications_userId_readAt_createdAt_idx" ON "notifications"("userId", "readAt", "createdAt");

-- CreateIndex
CREATE INDEX "security_events_userId_createdAt_idx" ON "security_events"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "security_events_type_createdAt_idx" ON "security_events"("type", "createdAt");

-- CreateIndex
CREATE INDEX "security_events_severity_createdAt_idx" ON "security_events"("severity", "createdAt");

-- CreateIndex
CREATE INDEX "webhook_events_receivedAt_idx" ON "webhook_events"("receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_provider_eventId_key" ON "webhook_events"("provider", "eventId");

-- AddForeignKey
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "user_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_verifications" ADD CONSTRAINT "user_verifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_currencyCode_fkey" FOREIGN KEY ("currencyCode") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_accounts" ADD CONSTRAINT "wallet_accounts_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_accounts" ADD CONSTRAINT "wallet_accounts_ledgerAccountId_fkey" FOREIGN KEY ("ledgerAccountId") REFERENCES "ledger_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_currencyCode_fkey" FOREIGN KEY ("currencyCode") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_holds" ADD CONSTRAINT "wallet_holds_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_holds" ADD CONSTRAINT "wallet_holds_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "financial_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "financial_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_currencyCode_fkey" FOREIGN KEY ("currencyCode") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_reversesEntryId_fkey" FOREIGN KEY ("reversesEntryId") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entry_lines" ADD CONSTRAINT "journal_entry_lines_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entry_lines" ADD CONSTRAINT "journal_entry_lines_ledgerAccountId_fkey" FOREIGN KEY ("ledgerAccountId") REFERENCES "ledger_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_transactions" ADD CONSTRAINT "financial_transactions_currencyCode_fkey" FOREIGN KEY ("currencyCode") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_transactions" ADD CONSTRAINT "financial_transactions_initiatorUserId_fkey" FOREIGN KEY ("initiatorUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_transactions" ADD CONSTRAINT "financial_transactions_sourceWalletId_fkey" FOREIGN KEY ("sourceWalletId") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_transactions" ADD CONSTRAINT "financial_transactions_destinationWalletId_fkey" FOREIGN KEY ("destinationWalletId") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "financial_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_senderUserId_fkey" FOREIGN KEY ("senderUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_recipientUserId_fkey" FOREIGN KEY ("recipientUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_sourceWalletId_fkey" FOREIGN KEY ("sourceWalletId") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_destinationWalletId_fkey" FOREIGN KEY ("destinationWalletId") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "financial_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_currencyCode_fkey" FOREIGN KEY ("currencyCode") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "financial_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_currencyCode_fkey" FOREIGN KEY ("currencyCode") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_payoutMethodId_fkey" FOREIGN KEY ("payoutMethodId") REFERENCES "payment_methods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_methods" ADD CONSTRAINT "payment_methods_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transaction_limits" ADD CONSTRAINT "transaction_limits_currencyCode_fkey" FOREIGN KEY ("currencyCode") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transaction_limits" ADD CONSTRAINT "transaction_limits_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_policies" ADD CONSTRAINT "fee_policies_currencyCode_fkey" FOREIGN KEY ("currencyCode") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "security_events" ADD CONSTRAINT "security_events_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ===========================================================================
-- NEXUS BANK database-enforced financial integrity
-- These checks are deliberately in SQL so that no application bug (or direct
-- SQL client) can persist an unbalanced or inconsistent ledger.
-- ===========================================================================

-- Positive money checks -----------------------------------------------------
ALTER TABLE "financial_transactions"
  ADD CONSTRAINT "financial_transactions_amount_positive" CHECK ("amountMinor" > 0),
  ADD CONSTRAINT "financial_transactions_fee_nonnegative" CHECK ("feeMinor" >= 0);

ALTER TABLE "journal_entry_lines"
  ADD CONSTRAINT "journal_lines_amounts_nonnegative" CHECK ("debitMinor" >= 0 AND "creditMinor" >= 0),
  ADD CONSTRAINT "journal_lines_one_sided" CHECK (("debitMinor" > 0 AND "creditMinor" = 0) OR ("creditMinor" > 0 AND "debitMinor" = 0));

ALTER TABLE "wallet_accounts"
  ADD CONSTRAINT "wallet_accounts_balance_nonnegative" CHECK ("balanceMinor" >= 0),
  ADD CONSTRAINT "wallet_accounts_held_nonnegative" CHECK ("heldMinor" >= 0);

ALTER TABLE "wallet_holds"
  ADD CONSTRAINT "wallet_holds_amount_positive" CHECK ("amountMinor" > 0);

ALTER TABLE "transfers"
  ADD CONSTRAINT "transfers_amount_positive" CHECK ("amountMinor" > 0),
  ADD CONSTRAINT "transfers_fee_nonnegative" CHECK ("feeMinor" >= 0);

ALTER TABLE "deposits"
  ADD CONSTRAINT "deposits_amount_positive" CHECK ("amountMinor" > 0);

ALTER TABLE "withdrawals"
  ADD CONSTRAINT "withdrawals_amount_positive" CHECK ("amountMinor" > 0),
  ADD CONSTRAINT "withdrawals_fee_nonnegative" CHECK ("feeMinor" >= 0);

ALTER TABLE "fee_policies"
  ADD CONSTRAINT "fee_policies_nonnegative" CHECK ("flatMinor" >= 0 AND "percentBps" >= 0 AND "minFeeMinor" >= 0),
  ADD CONSTRAINT "fee_policies_percent_range" CHECK ("percentBps" <= 10000);

ALTER TABLE "transaction_limits"
  ADD CONSTRAINT "transaction_limits_ranges" CHECK (
    "perTransactionMinMinor" >= 0
    AND "perTransactionMaxMinor" >= "perTransactionMinMinor"
    AND ("dailyMaxMinor" IS NULL OR "dailyMaxMinor" >= "perTransactionMinMinor")
    AND ("monthlyMaxMinor" IS NULL OR "monthlyMaxMinor" >= "perTransactionMinMinor")
  );

-- One primary wallet per user ----------------------------------------------
CREATE UNIQUE INDEX "wallets_one_primary_per_user"
  ON "wallets" ("userId") WHERE "isPrimary" = true;

-- Immutability of append-only records --------------------------------------
CREATE OR REPLACE FUNCTION nexus_deny_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'NEXUS_IMMUTABLE_RECORD: % records are append-only', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER "journal_entries_append_only"
  BEFORE UPDATE OR DELETE ON "journal_entries"
  FOR EACH ROW EXECUTE FUNCTION nexus_deny_mutation();

CREATE TRIGGER "journal_entry_lines_append_only"
  BEFORE UPDATE OR DELETE ON "journal_entry_lines"
  FOR EACH ROW EXECUTE FUNCTION nexus_deny_mutation();

CREATE TRIGGER "audit_logs_append_only"
  BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION nexus_deny_mutation();

-- Every journal entry must balance and use at least two accounts -----------
CREATE OR REPLACE FUNCTION nexus_assert_journal_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_debits bigint;
  v_credits bigint;
  v_lines integer;
  v_accounts integer;
  v_bad_currency integer;
BEGIN
  SELECT COALESCE(SUM("debitMinor"), 0), COALESCE(SUM("creditMinor"), 0), COUNT(*)
    INTO v_debits, v_credits, v_lines
    FROM "journal_entry_lines"
   WHERE "journalEntryId" = NEW."id";

  SELECT COUNT(DISTINCT "ledgerAccountId") INTO v_accounts
    FROM "journal_entry_lines"
   WHERE "journalEntryId" = NEW."id";

  SELECT COUNT(*) INTO v_bad_currency
    FROM "journal_entry_lines" l
    JOIN "ledger_accounts" a ON a."id" = l."ledgerAccountId"
   WHERE l."journalEntryId" = NEW."id"
     AND a."currencyCode" <> NEW."currencyCode";

  IF v_lines < 2 THEN
    RAISE EXCEPTION 'NEXUS_UNBALANCED_JOURNAL: entry % has fewer than two lines', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_accounts < 2 THEN
    RAISE EXCEPTION 'NEXUS_UNBALANCED_JOURNAL: entry % must use at least two accounts', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_debits <> v_credits OR v_debits = 0 THEN
    RAISE EXCEPTION 'NEXUS_UNBALANCED_JOURNAL: entry % debits=% credits=%', NEW."id", v_debits, v_credits
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_bad_currency > 0 THEN
    RAISE EXCEPTION 'NEXUS_JOURNAL_CURRENCY_MISMATCH: entry % has lines in another currency', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "journal_entries_must_balance"
  AFTER INSERT ON "journal_entries"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION nexus_assert_journal_balanced();

-- Wallet projections must equal the ledger and active holds at COMMIT ------
CREATE OR REPLACE FUNCTION nexus_assert_wallet_account(p_account_id text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_wallet_id text;
  v_ledger_id text;
  v_balance bigint;
  v_held bigint;
  v_ledger_balance bigint;
  v_active_holds bigint;
BEGIN
  SELECT "walletId", "ledgerAccountId", "balanceMinor", "heldMinor"
    INTO v_wallet_id, v_ledger_id, v_balance, v_held
    FROM "wallet_accounts" WHERE "id" = p_account_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT COALESCE(SUM("creditMinor" - "debitMinor"), 0)
    INTO v_ledger_balance
    FROM "journal_entry_lines" WHERE "ledgerAccountId" = v_ledger_id;

  SELECT COALESCE(SUM("amountMinor"), 0)
    INTO v_active_holds
    FROM "wallet_holds" WHERE "walletId" = v_wallet_id AND "status" = 'ACTIVE';

  IF v_balance <> v_ledger_balance THEN
    RAISE EXCEPTION 'NEXUS_BALANCE_DRIFT: wallet % projected=% ledger=%', v_wallet_id, v_balance, v_ledger_balance
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_held <> v_active_holds THEN
    RAISE EXCEPTION 'NEXUS_HOLD_DRIFT: wallet % projected=% active_holds=%', v_wallet_id, v_held, v_active_holds
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_held > v_balance THEN
    RAISE EXCEPTION 'NEXUS_INSUFFICIENT_FUNDS: wallet % balance=% held=%', v_wallet_id, v_balance, v_held
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION nexus_check_wallet_account_trigger() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM nexus_assert_wallet_account(NEW."id");
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION nexus_check_wallet_from_line_trigger() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_wallet_account_id text;
BEGIN
  SELECT wa."id" INTO v_wallet_account_id
    FROM "wallet_accounts" wa
   WHERE wa."ledgerAccountId" = NEW."ledgerAccountId";

  IF v_wallet_account_id IS NOT NULL THEN
    PERFORM nexus_assert_wallet_account(v_wallet_account_id);
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION nexus_check_wallet_from_hold_trigger() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_wallet_account_id text;
BEGIN
  SELECT "id" INTO v_wallet_account_id
    FROM "wallet_accounts" WHERE "walletId" = NEW."walletId";
  IF v_wallet_account_id IS NOT NULL THEN
    PERFORM nexus_assert_wallet_account(v_wallet_account_id);
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "wallet_accounts_must_match_ledger"
  AFTER INSERT OR UPDATE OF "balanceMinor", "heldMinor" ON "wallet_accounts"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION nexus_check_wallet_account_trigger();

CREATE CONSTRAINT TRIGGER "journal_lines_must_match_wallet"
  AFTER INSERT ON "journal_entry_lines"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION nexus_check_wallet_from_line_trigger();

CREATE CONSTRAINT TRIGGER "wallet_holds_must_match_projection"
  AFTER INSERT OR UPDATE OF "status", "amountMinor" ON "wallet_holds"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION nexus_check_wallet_from_hold_trigger();
