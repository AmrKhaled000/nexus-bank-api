import type { Request, Response } from 'express';
import type { AppConfig } from '../../config/env';
import { AppError, ErrorCode } from '../../common/errors/app-error';
import { readCookie } from '../../common/http/cookies';
import { clearRefreshCookie, setRefreshCookie } from '../../common/http/refresh-cookie';
import { sendSuccess, validatedBody } from '../../common/http/http';
import { requestMeta } from '../../common/http/request-meta';
import type { AuthService, TokenBundle } from './auth.service';
import {
  changePasswordSchema,
  changePinSchema,
  disableTwoFactorSchema,
  enableTwoFactorSchema,
  forgotPasswordSchema,
  loginSchema,
  refreshSchema,
  registerSchema,
  resendVerificationSchema,
  resetPasswordSchema,
  setPinSchema,
  setupTwoFactorSchema,
  verifyEmailSchema,
  verifyTwoFactorSchema,
} from './auth.schemas';

export class AuthController {
  constructor(
    private readonly config: AppConfig,
    private readonly auth: AuthService,
  ) {}

  register = async (req: Request, res: Response): Promise<Response> => {
    const body = validatedBody(req, registerSchema);
    return sendSuccess(res, await this.auth.register(body), 201);
  };

  verifyEmail = async (req: Request, res: Response): Promise<Response> => {
    const body = validatedBody(req, verifyEmailSchema);
    return sendSuccess(res, await this.auth.verifyEmail(body.token));
  };

  resendVerification = async (req: Request, res: Response): Promise<Response> => {
    const body = validatedBody(req, resendVerificationSchema);
    return sendSuccess(res, await this.auth.resendVerification(body.email), 202);
  };

  login = async (req: Request, res: Response): Promise<Response> => {
    const body = validatedBody(req, loginSchema);
    const result = await this.auth.login(body, requestMeta(req));
    if (result.kind === 'mfa_required') {
      return sendSuccess(res, {
        mfaRequired: true,
        mfaToken: result.mfaToken,
        expiresInSeconds: result.expiresInSeconds,
      });
    }
    this.issueRefreshCookie(res, result.tokens);
    return sendSuccess(res, this.tokenResponse(result.user, result.tokens));
  };

  verifyTwoFactor = async (req: Request, res: Response): Promise<Response> => {
    const body = validatedBody(req, verifyTwoFactorSchema);
    const result = await this.auth.verifyTwoFactor(body, requestMeta(req));
    this.issueRefreshCookie(res, result.tokens);
    return sendSuccess(res, this.tokenResponse(result.user, result.tokens));
  };

  refresh = async (req: Request, res: Response): Promise<Response> => {
    const body = validatedBody(req, refreshSchema);
    const rawToken = readCookie(req, this.config.REFRESH_COOKIE_NAME) ?? body?.refreshToken;
    if (!rawToken) {
      clearRefreshCookie(res, this.config.REFRESH_COOKIE_NAME, this.config.isProduction, this.config.API_PREFIX);
      throw AppError.unauthorized(ErrorCode.INVALID_TOKEN, 'Refresh token is required');
    }
    try {
      const result = await this.auth.refresh(rawToken, requestMeta(req));
      this.issueRefreshCookie(res, result.tokens);
      return sendSuccess(res, this.tokenResponse(result.user, result.tokens));
    } catch (error) {
      clearRefreshCookie(res, this.config.REFRESH_COOKIE_NAME, this.config.isProduction, this.config.API_PREFIX);
      throw error;
    }
  };

  logout = async (req: Request, res: Response): Promise<Response> => {
    await this.auth.logout(req.auth!.userId, req.auth!.sessionId);
    clearRefreshCookie(res, this.config.REFRESH_COOKIE_NAME, this.config.isProduction, this.config.API_PREFIX);
    return sendSuccess(res, { message: 'Signed out.' });
  };

  logoutAll = async (req: Request, res: Response): Promise<Response> => {
    const result = await this.auth.logoutAll(req.auth!.userId);
    clearRefreshCookie(res, this.config.REFRESH_COOKIE_NAME, this.config.isProduction, this.config.API_PREFIX);
    return sendSuccess(res, result);
  };

  listSessions = async (req: Request, res: Response): Promise<Response> => {
    return sendSuccess(res, await this.auth.listSessions(req.auth!.userId, req.auth!.sessionId));
  };

  revokeSession = async (req: Request, res: Response): Promise<Response> => {
    await this.auth.revokeSession(req.auth!.userId, String(req.params.sessionId));
    return sendSuccess(res, { message: 'Session revoked.' });
  };

  forgotPassword = async (req: Request, res: Response): Promise<Response> => {
    const body = validatedBody(req, forgotPasswordSchema);
    return sendSuccess(res, await this.auth.forgotPassword(body.email), 202);
  };

  resetPassword = async (req: Request, res: Response): Promise<Response> => {
    const body = validatedBody(req, resetPasswordSchema);
    return sendSuccess(res, await this.auth.resetPassword(body.token, body.newPassword));
  };

  changePassword = async (req: Request, res: Response): Promise<Response> => {
    const body = validatedBody(req, changePasswordSchema);
    return sendSuccess(
      res,
      await this.auth.changePassword(
        req.auth!.userId,
        body.currentPassword,
        body.newPassword,
        req.auth!.sessionId,
      ),
    );
  };

  setupTwoFactor = async (req: Request, res: Response): Promise<Response> => {
    const body = validatedBody(req, setupTwoFactorSchema);
    return sendSuccess(res, await this.auth.setupTwoFactor(req.auth!.userId, body.password));
  };

  enableTwoFactor = async (req: Request, res: Response): Promise<Response> => {
    const body = validatedBody(req, enableTwoFactorSchema);
    return sendSuccess(res, await this.auth.enableTwoFactor(req.auth!.userId, body.code));
  };

  disableTwoFactor = async (req: Request, res: Response): Promise<Response> => {
    const body = validatedBody(req, disableTwoFactorSchema);
    return sendSuccess(
      res,
      await this.auth.disableTwoFactor(req.auth!.userId, body.password, body.code),
    );
  };

  setPin = async (req: Request, res: Response): Promise<Response> => {
    const body = validatedBody(req, setPinSchema);
    return sendSuccess(res, await this.auth.setTransactionPin(req.auth!.userId, body.password, body.pin), 201);
  };

  changePin = async (req: Request, res: Response): Promise<Response> => {
    const body = validatedBody(req, changePinSchema);
    return sendSuccess(
      res,
      await this.auth.changeTransactionPin(
        req.auth!.userId,
        body.password,
        body.currentPin,
        body.newPin,
      ),
    );
  };

  private tokenResponse(user: unknown, tokens: TokenBundle) {
    return {
      user,
      accessToken: tokens.accessToken,
      tokenType: 'Bearer',
      expiresInSeconds: tokens.accessTokenExpiresIn,
      refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
    };
  }

  private issueRefreshCookie(res: Response, tokens: TokenBundle): void {
    setRefreshCookie(
      res,
      this.config.REFRESH_COOKIE_NAME,
      tokens.refreshToken,
      tokens.refreshTokenExpiresAt,
      this.config.isProduction,
      this.config.API_PREFIX,
    );
  }
}
