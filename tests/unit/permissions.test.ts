import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/common/errors/app-error';
import { Permission, assertPermission, hasPermission } from '../../src/common/security/permissions';

describe('role permission matrix', () => {
  it('grants customers no administrative permissions', () => {
    for (const permission of Object.values(Permission)) {
      expect(hasPermission('CUSTOMER', permission)).toBe(false);
    }
  });

  it('grants support read-only access', () => {
    expect(hasPermission('SUPPORT', Permission.ADMIN_READ)).toBe(true);
    expect(hasPermission('SUPPORT', Permission.AUDIT_READ)).toBe(true);
    expect(hasPermission('SUPPORT', Permission.LEDGER_READ)).toBe(true);
    expect(hasPermission('SUPPORT', Permission.WITHDRAWALS_REVIEW)).toBe(false);
    expect(hasPermission('SUPPORT', Permission.LEDGER_ADJUST)).toBe(false);
    expect(hasPermission('SUPPORT', Permission.TRANSFERS_REVERSE)).toBe(false);
    expect(hasPermission('SUPPORT', Permission.USERS_MANAGE)).toBe(false);
    expect(hasPermission('SUPPORT', Permission.ROLES_MANAGE)).toBe(false);
  });

  it('grants finance admins ledger and withdrawal review but not role management', () => {
    expect(hasPermission('FINANCE_ADMIN', Permission.ADMIN_READ)).toBe(true);
    expect(hasPermission('FINANCE_ADMIN', Permission.AUDIT_READ)).toBe(true);
    expect(hasPermission('FINANCE_ADMIN', Permission.WITHDRAWALS_REVIEW)).toBe(true);
    expect(hasPermission('FINANCE_ADMIN', Permission.LEDGER_READ)).toBe(true);
    expect(hasPermission('FINANCE_ADMIN', Permission.LEDGER_ADJUST)).toBe(true);
    expect(hasPermission('FINANCE_ADMIN', Permission.TRANSFERS_REVERSE)).toBe(true);
    expect(hasPermission('FINANCE_ADMIN', Permission.USERS_MANAGE)).toBe(false);
    expect(hasPermission('FINANCE_ADMIN', Permission.ROLES_MANAGE)).toBe(false);
  });

  it('grants super admins every permission', () => {
    for (const permission of Object.values(Permission)) {
      expect(hasPermission('SUPER_ADMIN', permission)).toBe(true);
    }
  });

  it('fails closed for unknown roles', () => {
    expect(hasPermission('PLATFORM_ROOT', Permission.ADMIN_READ)).toBe(false);
    expect(hasPermission('', Permission.ADMIN_READ)).toBe(false);
  });
});

describe('assertPermission', () => {
  it('passes silently when authorized', () => {
    expect(() => assertPermission('FINANCE_ADMIN', Permission.LEDGER_ADJUST)).not.toThrow();
  });

  it('throws a 403 AppError when unauthorized', () => {
    try {
      assertPermission('CUSTOMER', Permission.LEDGER_ADJUST);
      throw new Error('expected assertPermission to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).statusCode).toBe(403);
      expect((error as AppError).code).toBe('ROLE_NOT_ALLOWED');
    }
  });
});
