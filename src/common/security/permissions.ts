import type { UserRole } from '@prisma/client';
import { AppError, ErrorCode } from '../../common/errors/app-error';

export const Permission = {
  ADMIN_READ: 'admin.read',
  AUDIT_READ: 'audit.read',
  USERS_MANAGE: 'users.manage',
  ROLES_MANAGE: 'roles.manage',
  WITHDRAWALS_REVIEW: 'withdrawals.review',
  LEDGER_READ: 'ledger.read',
  LEDGER_ADJUST: 'ledger.adjust',
  TRANSFERS_REVERSE: 'transfers.reverse',
} as const;

export type Permission = (typeof Permission)[keyof typeof Permission];

const ROLE_PERMISSIONS: Record<UserRole, readonly Permission[]> = {
  CUSTOMER: [],
  SUPPORT: [Permission.ADMIN_READ, Permission.AUDIT_READ, Permission.LEDGER_READ],
  FINANCE_ADMIN: [
    Permission.ADMIN_READ,
    Permission.AUDIT_READ,
    Permission.WITHDRAWALS_REVIEW,
    Permission.LEDGER_READ,
    Permission.LEDGER_ADJUST,
    Permission.TRANSFERS_REVERSE,
  ],
  SUPER_ADMIN: Object.values(Permission),
};

export function hasPermission(role: UserRole | string, permission: Permission): boolean {
  return (ROLE_PERMISSIONS[role as UserRole] ?? []).includes(permission);
}

export function assertPermission(role: UserRole | string, permission: Permission): void {
  if (!hasPermission(role, permission)) {
    throw AppError.forbidden(ErrorCode.ROLE_NOT_ALLOWED, 'Your role does not permit this operation');
  }
}
