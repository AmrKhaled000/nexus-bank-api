import type { PaymentMethodReference } from '@prisma/client';

export function toPaymentMethodDto(method: PaymentMethodReference) {
  return {
    id: method.id,
    type: method.type,
    provider: method.provider,
    bankName: method.bankName,
    accountLast4: method.accountLast4,
    isDefault: method.isDefault,
    createdAt: method.createdAt,
  };
}
