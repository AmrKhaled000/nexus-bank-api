import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authenticator } from 'otplib';
import { resetDatabase, prisma } from '../helpers/db';
import { createTestContext, type TestContext } from '../helpers/app';
import { clearMailbox, passwordResetTokenFor, verificationTokenFor } from '../helpers/mailbox';

const context: TestContext = createTestContext();
const { agent } = context;

const PASSWORD = 'V3ry!Str0ng#Passw0rd';
const NEW_PASSWORD = 'An0ther!VeryStr0ng#Passw0rd';

interface RegisteredUser {
  name: string;
  email: string;
  password: string;
}

async function registerUser(email: string, name = 'Alice Example', password = PASSWORD): Promise<void> {
  const response = await agent().post('/api/v1/auth/register').send({ name, email, password });
  expect(response.status).toBe(201);
}

async function verifyEmail(email: string): Promise<void> {
  const token = await verificationTokenFor(email);
  const response = await agent().post('/api/v1/auth/verify-email').send({ token });
  expect(response.status).toBe(200);
}

async function registerVerifiedUser(email: string, name = 'Alice Example'): Promise<RegisteredUser> {
  await registerUser(email, name);
  await verifyEmail(email);
  return { name, email, password: PASSWORD };
}

async function login(email: string, password: string) {
  return agent().post('/api/v1/auth/login').send({ email, password });
}

function refreshCookie(setCookie: string[] | string | undefined): string {
  const values = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const cookie = values.find((value) => value.startsWith('nexus_rt='));
  if (!cookie) throw new Error('Expected a nexus_rt refresh cookie');
  return cookie;
}

function cookiePair(cookie: string): string {
  return cookie.split(';')[0]!;
}

describe('authentication', () => {
  beforeEach(async () => {
    await resetDatabase();
    await clearMailbox();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    await context.close();
  });

  it('registers an account as pending verification and blocks sign-in until verified', async () => {
    const email = 'alice-register@nexusbank.test';
    await registerUser(email);

    const blocked = await login(email, PASSWORD);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('EMAIL_NOT_VERIFIED');

    await verifyEmail(email);

    const signedIn = await login(email, PASSWORD);
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.data).toMatchObject({
      accessToken: expect.any(String),
      tokenType: 'Bearer',
      expiresInSeconds: 900,
    });
    expect(signedIn.body.data.user).toMatchObject({ email, status: 'ACTIVE' });
    expect(signedIn.body.data).not.toHaveProperty('refreshToken');

    const setCookie = refreshCookie(signedIn.headers['set-cookie']);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('Path=/api/v1/auth');
  });

  it('rejects duplicate registration with a conflict', async () => {
    const email = 'alice-duplicate@nexusbank.test';
    await registerUser(email);
    const duplicate = await agent()
      .post('/api/v1/auth/register')
      .send({ name: 'Alice Example', email, password: PASSWORD });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('EMAIL_ALREADY_EXISTS');
  });

  it('rejects weak passwords and passwords derived from identity', async () => {
    const weak = await agent()
      .post('/api/v1/auth/register')
      .send({ name: 'Weak Example', email: 'weak@nexusbank.test', password: 'short' });
    expect(weak.status).toBe(400);

    const derived = await agent()
      .post('/api/v1/auth/register')
      .send({ name: 'Weak Example', email: 'weak-derived@nexusbank.test', password: 'weak-derived-123!' });
    expect(derived.status).toBe(400);
    expect(derived.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rotates refresh tokens and detects reuse of a rotated token', async () => {
    const user = await registerVerifiedUser('alice-refresh@nexusbank.test');

    const first = await login(user.email, user.password);
    expect(first.status).toBe(200);
    const firstCookie = refreshCookie(first.headers['set-cookie']);

    const rotated = await agent().post('/api/v1/auth/refresh').set('Cookie', cookiePair(firstCookie));
    expect(rotated.status).toBe(200);
    const secondCookie = refreshCookie(rotated.headers['set-cookie']);
    expect(cookiePair(secondCookie)).not.toBe(cookiePair(firstCookie));

    const reuse = await agent().post('/api/v1/auth/refresh').set('Cookie', cookiePair(firstCookie));
    expect(reuse.status).toBe(401);
    expect(reuse.body.error.code).toBe('REFRESH_TOKEN_REUSE');

    // Reuse revokes the whole token family, including the legitimately rotated token.
    const familyRevoked = await agent().post('/api/v1/auth/refresh').set('Cookie', cookiePair(secondCookie));
    expect(familyRevoked.status).toBe(401);
  });

  it('invalidates refresh tokens on logout and on logout-all', async () => {
    const user = await registerVerifiedUser('alice-logout@nexusbank.test');

    const first = await login(user.email, user.password);
    const firstCookie = refreshCookie(first.headers['set-cookie']);

    const logout = await agent()
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${first.body.data.accessToken}`);
    expect(logout.status).toBe(200);

    const afterLogout = await agent().post('/api/v1/auth/refresh').set('Cookie', cookiePair(firstCookie));
    expect(afterLogout.status).toBe(401);

    // logout-all revokes every active session for the user.
    const second = await login(user.email, user.password);
    const secondCookie = refreshCookie(second.headers['set-cookie']);
    const logoutAll = await agent()
      .post('/api/v1/auth/logout-all')
      .set('Authorization', `Bearer ${second.body.data.accessToken}`);
    expect(logoutAll.status).toBe(200);
    expect(logoutAll.body.data.revokedSessions).toBeGreaterThanOrEqual(1);

    const afterLogoutAll = await agent().post('/api/v1/auth/refresh').set('Cookie', cookiePair(secondCookie));
    expect(afterLogoutAll.status).toBe(401);
  });

  it('lists the current session and revokes other sessions', async () => {
    const user = await registerVerifiedUser('alice-sessions@nexusbank.test');

    const first = await login(user.email, user.password);
    const second = await login(user.email, user.password);
    const firstAccess = first.body.data.accessToken as string;
    const secondAccess = second.body.data.accessToken as string;

    const sessions = await agent().get('/api/v1/auth/sessions').set('Authorization', `Bearer ${firstAccess}`);
    expect(sessions.status).toBe(200);
    expect(sessions.body.data).toHaveLength(2);
    expect(sessions.body.data.filter((s: { current: boolean }) => s.current)).toHaveLength(1);

    const other = sessions.body.data.find((s: { current: boolean }) => !s.current);
    const revoke = await agent()
      .delete(`/api/v1/auth/sessions/${other.id}`)
      .set('Authorization', `Bearer ${firstAccess}`);
    expect(revoke.status).toBe(200);

    const remaining = await agent().get('/api/v1/auth/sessions').set('Authorization', `Bearer ${firstAccess}`);
    expect(remaining.body.data).toHaveLength(1);

    // The revoked session's token is rejected.
    const rejected = await agent().get('/api/v1/auth/sessions').set('Authorization', `Bearer ${secondAccess}`);
    expect(rejected.status).toBe(401);
  });

  it('locks the account after five failed sign-in attempts', async () => {
    const user = await registerVerifiedUser('alice-lockout@nexusbank.test');

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await login(user.email, 'Definitely-Wrong-Password#1');
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('INVALID_CREDENTIALS');
    }

    const locked = await login(user.email, user.password);
    expect(locked.status).toBe(423);
    expect(locked.body.error.code).toBe('ACCOUNT_LOCKED');

    const events = await prisma.securityEvent.findMany({
      where: { user: { email: user.email }, type: 'LOGIN_LOCKED' },
    });
    expect(events.length).toBeGreaterThanOrEqual(1);
  });

  it('enables TOTP two-factor authentication and rejects replayed codes', async () => {
    const user = await registerVerifiedUser('alice-2fa@nexusbank.test');

    const signedIn = await login(user.email, user.password);
    const accessToken = signedIn.body.data.accessToken as string;

    const setup = await agent()
      .post('/api/v1/auth/2fa/setup')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ password: user.password });
    expect(setup.status).toBe(200);
    const secret = setup.body.data.secret as string;
    expect(setup.body.data.otpauthUrl).toContain('otpauth://totp/');

    const enable = await agent()
      .post('/api/v1/auth/2fa/enable')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ code: authenticator.generate(secret) });
    expect(enable.status).toBe(200);

    const passwordOnly = await login(user.email, user.password);
    expect(passwordOnly.status).toBe(200);
    expect(passwordOnly.body.data.mfaRequired).toBe(true);
    const mfaToken = passwordOnly.body.data.mfaToken as string;

    // Enabling two-factor records the current TOTP step as used. Move past it so the next
    // code belongs to a fresh step, mirroring a real user waiting for their authenticator.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 30_000);
    const code = authenticator.generate(secret);
    const verified = await agent().post('/api/v1/auth/2fa/verify').send({ mfaToken, code });
    expect(verified.status).toBe(200);
    expect(verified.body.data.accessToken).toEqual(expect.any(String));

    const replayed = await agent().post('/api/v1/auth/2fa/verify').send({ mfaToken, code });
    expect(replayed.status).toBe(422);
    expect(replayed.body.error.code).toBe('INVALID_TWO_FACTOR_CODE');
  });

  it('resets a forgotten password and revokes existing sessions', async () => {
    const user = await registerVerifiedUser('alice-reset@nexusbank.test');

    const before = await login(user.email, user.password);
    expect(before.status).toBe(200);
    const oldCookie = refreshCookie(before.headers['set-cookie']);

    const requestReset = await agent().post('/api/v1/auth/forgot-password').send({ email: user.email });
    expect(requestReset.status).toBe(202);

    const token = await passwordResetTokenFor(user.email);
    const reset = await agent().post('/api/v1/auth/reset-password').send({ token, newPassword: NEW_PASSWORD });
    expect(reset.status).toBe(200);

    const oldTokenReuse = await agent().post('/api/v1/auth/reset-password').send({ token, newPassword: NEW_PASSWORD });
    expect(oldTokenReuse.status).toBe(400);

    const oldPasswordLogin = await login(user.email, user.password);
    expect(oldPasswordLogin.status).toBe(401);

    const newPasswordLogin = await login(user.email, NEW_PASSWORD);
    expect(newPasswordLogin.status).toBe(200);

    const oldCookieRejected = await agent().post('/api/v1/auth/refresh').set('Cookie', cookiePair(oldCookie));
    expect(oldCookieRejected.status).toBe(401);
  });

  it('requires authentication for protected routes', async () => {
    const response = await agent().get('/api/v1/users/me');
    expect(response.status).toBe(401);

    const malformed = await agent().get('/api/v1/users/me').set('Authorization', 'Bearer not-a-token');
    expect(malformed.status).toBe(401);
    expect(malformed.body.error.code).toBe('INVALID_TOKEN');
  });

  it('rejects unknown verification tokens without leaking state', async () => {
    const response = await agent().post('/api/v1/auth/verify-email').send({ token: 'a'.repeat(43) });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_TOKEN');
  });
});
