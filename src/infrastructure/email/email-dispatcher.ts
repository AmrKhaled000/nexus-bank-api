export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface EmailDispatcher {
  send(message: EmailMessage): Promise<void>;
}

export class NullEmailDispatcher implements EmailDispatcher {
  async send(_message: EmailMessage): Promise<void> {
    // Intentionally does nothing. Used in tests and when email delivery is not configured.
  }
}
