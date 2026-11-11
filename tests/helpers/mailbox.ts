import { readdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const MAILBOX_DIR = resolve(process.cwd(), process.env.DEV_MAIL_DIR ?? '.dev-mail-test');

interface StoredEmail {
  to: string;
  subject: string;
  text: string;
  sentAt?: string;
}

/** Removes all captured development emails. File names are timestamp-prefixed, so ordering is stable. */
export async function clearMailbox(): Promise<void> {
  await rm(MAILBOX_DIR, { recursive: true, force: true });
}

async function listEmails(to: string): Promise<StoredEmail[]> {
  let files: string[] = [];
  try {
    files = await readdir(MAILBOX_DIR);
  } catch {
    return [];
  }
  const messages: StoredEmail[] = [];
  for (const file of files.sort()) {
    if (!file.endsWith('.json')) continue;
    try {
      const parsed = JSON.parse(await readFile(join(MAILBOX_DIR, file), 'utf8')) as StoredEmail;
      if (parsed.to === to) messages.push(parsed);
    } catch {
      // Ignore partially-written files.
    }
  }
  return messages;
}

/** Extracts the one-time token (a standalone 43-character base64url line) from an email body. */
export function extractToken(text: string): string {
  const match = text.match(/^\s*([A-Za-z0-9_-]{43})\s*$/m);
  if (!match) {
    throw new Error('Could not find a one-time token in the email body');
  }
  return match[1]!;
}

export async function findEmail(to: string, subjectIncludes: string): Promise<StoredEmail> {
  const matches = (await listEmails(to)).filter((message) => message.subject.includes(subjectIncludes));
  const latest = matches.at(-1);
  if (!latest) {
    throw new Error(`No email to ${to} with subject containing "${subjectIncludes}" was captured`);
  }
  return latest;
}

export async function verificationTokenFor(email: string): Promise<string> {
  const message = await findEmail(email, 'Verify your NEXUS BANK email');
  return extractToken(message.text);
}

export async function passwordResetTokenFor(email: string): Promise<string> {
  const message = await findEmail(email, 'Reset your NEXUS BANK password');
  return extractToken(message.text);
}
