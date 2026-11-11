import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { EmailDispatcher, EmailMessage } from './email-dispatcher';

/**
 * Development/test transport. Writes each email as a JSON document (including one-time
 * tokens) to a git-ignored directory so local flows can be exercised without an SMTP server.
 * Never enable file delivery in production.
 */
export class FileEmailDispatcher implements EmailDispatcher {
  constructor(private readonly directory: string) {}

  async send(message: EmailMessage): Promise<void> {
    const target = resolve(this.directory);
    await mkdir(target, { recursive: true });
    const filename = `${Date.now()}-${randomUUID()}.json`;
    await writeFile(
      join(target, filename),
      JSON.stringify(
        {
          ...message,
          sentAt: new Date().toISOString(),
          transport: 'file',
          warning: 'Development email containing a one-time token. Do not deploy this file transport.',
        },
        null,
        2,
      ),
      { encoding: 'utf8', mode: 0o600 },
    );
  }
}
