import type { CookieOptions, Response } from 'express';
import { cookieSecurityAttributes } from './cookies';

export function refreshCookiePath(apiPrefix: string): string {
  return `${apiPrefix.replace(/\/$/, '')}/auth`;
}

export function refreshCookieOptions(
  isProduction: boolean,
  apiPrefix: string,
  expiresAt?: Date,
): CookieOptions {
  return {
    ...cookieSecurityAttributes(isProduction, refreshCookiePath(apiPrefix)),
    ...(expiresAt ? { expires: expiresAt } : {}),
  };
}

export function setRefreshCookie(
  res: Response,
  name: string,
  token: string,
  expiresAt: Date,
  isProduction: boolean,
  apiPrefix: string,
): void {
  res.cookie(name, token, refreshCookieOptions(isProduction, apiPrefix, expiresAt));
}

export function clearRefreshCookie(
  res: Response,
  name: string,
  isProduction: boolean,
  apiPrefix: string,
): void {
  res.clearCookie(name, refreshCookieOptions(isProduction, apiPrefix));
}
