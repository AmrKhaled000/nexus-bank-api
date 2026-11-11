import type { Request } from 'express';

export function readCookie(req: Request, name: string): string | undefined {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const [rawName, ...rest] = part.trim().split('=');
    if (rawName === name) {
      try {
        return decodeURIComponent(rest.join('='));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

export function cookieSecurityAttributes(isProduction: boolean, path: string) {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'strict' as const,
    path,
  };
}
