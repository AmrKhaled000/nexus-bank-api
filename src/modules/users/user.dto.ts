import type { User } from '@prisma/client';

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  role: string;
  status: string;
  emailVerified: boolean;
  twoFactorEnabled: boolean;
  hasTransactionPin: boolean;
  createdAt: Date;
}

type UserDtoSource = Pick<
  User,
  | 'id'
  | 'email'
  | 'name'
  | 'role'
  | 'status'
  | 'emailVerifiedAt'
  | 'totpEnabled'
  | 'pinHash'
  | 'createdAt'
>;

export function toPublicUser(user: UserDtoSource): PublicUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    status: user.status,
    emailVerified: Boolean(user.emailVerifiedAt),
    twoFactorEnabled: user.totpEnabled,
    hasTransactionPin: Boolean(user.pinHash),
    createdAt: user.createdAt,
  };
}
