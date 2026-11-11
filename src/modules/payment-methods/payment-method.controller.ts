import type { Request, Response } from 'express';
import { sendSuccess, validatedBody, validatedParams } from '../../common/http/http';
import type { PaymentMethodService } from './payment-method.service';
import {
  createPaymentMethodSchema,
  paymentMethodIdParamsSchema,
} from './payment-method.schemas';

export class PaymentMethodController {
  constructor(private readonly methods: PaymentMethodService) {}

  list = async (req: Request, res: Response): Promise<Response> => {
    return sendSuccess(res, await this.methods.list(req.auth!.userId));
  };

  create = async (req: Request, res: Response): Promise<Response> => {
    const body = validatedBody(req, createPaymentMethodSchema);
    return sendSuccess(res, await this.methods.create(req.auth!.userId, body), 201);
  };

  setDefault = async (req: Request, res: Response): Promise<Response> => {
    const { id } = validatedParams(req, paymentMethodIdParamsSchema);
    return sendSuccess(res, await this.methods.setDefault(req.auth!.userId, id));
  };

  remove = async (req: Request, res: Response): Promise<Response> => {
    const { id } = validatedParams(req, paymentMethodIdParamsSchema);
    await this.methods.remove(req.auth!.userId, id);
    return sendSuccess(res, { message: 'Payout method removed.' });
  };
}
