import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { userRepo, type UserRow } from "../db/repositories/userRepo.js";
import { env } from "../config/env.js";
import { appLogger } from "../logging/appLogger.js";

const SALT_ROUNDS = 12;

export function seedSuperadminIfNeeded(): void {
  if (userRepo.count() > 0) return;

  userRepo.create({
    id: crypto.randomUUID(),
    username: env.ADMIN_USERNAME,
    passwordHash: bcrypt.hashSync(env.ADMIN_PASSWORD, SALT_ROUNDS),
    globalRole: "superadmin",
  });
  appLogger.info({ username: env.ADMIN_USERNAME }, "seeded initial superadmin account");
}

// Compared against when the username doesn't exist, so an unknown user costs
// the same bcrypt work as a wrong password — otherwise the response time
// (~300ms vs ~1ms) reveals which usernames are real.
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString("hex"), SALT_ROUNDS);

export async function verifyLogin(username: string, password: string): Promise<UserRow | undefined> {
  const user = userRepo.findByUsername(username);
  const ok = await bcrypt.compare(password, user?.password_hash ?? DUMMY_HASH);
  return user && ok ? user : undefined;
}

export async function verifyPassword(user: UserRow, password: string): Promise<boolean> {
  return bcrypt.compare(password, user.password_hash);
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}
