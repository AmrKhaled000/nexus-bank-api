import nodemailer, { type Transporter } from 'nodemailer';
import type { AppConfig } from '../../config/env';
import type { EmailDispatcher, EmailMessage } from './email-dispatcher';

export class SmtpEmailDispatcher implements EmailDispatcher {
  private readonly transporter: Transporter;
  private readonly from: string;

  constructor(config: AppConfig) {
    this.from = config.EMAIL_FROM;
    this.transporter = nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_PORT === 465,
      ...(config.SMTP_USER && config.SMTP_PASSWORD
        ? { auth: { user: config.SMTP_USER, pass: config.SMTP_PASSWORD } }
        : {}),
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
  }

  async send(message: EmailMessage): Promise<void> {
    await this.transporter.sendMail({
      from: this.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
  }
}
