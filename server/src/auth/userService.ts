import crypto from "node:crypto";
import { userRepo, type GlobalRole, type UserRow } from "../db/repositories/userRepo.js";
import {
  instanceAccessRepo,
  roleSatisfies,
  type InstanceRole,
} from "../db/repositories/instanceAccessRepo.js";
import { hashPassword } from "./authService.js";

export async function createUser(username: string, password: string, globalRole: GlobalRole): Promise<UserRow> {
  if (userRepo.findByUsername(username)) {
    throw new Error(`Username "${username}" is already taken.`);
  }
  const id = crypto.randomUUID();
  userRepo.create({ id, username, passwordHash: await hashPassword(password), globalRole });
  return userRepo.findById(id)!;
}

export function deleteUser(userId: string): void {
  userRepo.delete(userId);
}

export function listUsers(): UserRow[] {
  return userRepo.list();
}

export async function changePassword(userId: string, newPassword: string): Promise<void> {
  userRepo.updatePasswordHash(userId, await hashPassword(newPassword));
}

export function grantInstanceAccess(userId: string, instanceId: string, role: InstanceRole): void {
  instanceAccessRepo.grant(userId, instanceId, role);
}

export function revokeInstanceAccess(userId: string, instanceId: string): void {
  instanceAccessRepo.revoke(userId, instanceId);
}

export function listInstanceAccessForUser(userId: string): { instanceId: string; role: InstanceRole }[] {
  return instanceAccessRepo.listForUser(userId).map((a) => ({ instanceId: a.instance_id, role: a.role }));
}

/** True if the user may act on this instance at (at least) the given role. */
export function hasInstanceRole(user: UserRow, instanceId: string, minRole: InstanceRole): boolean {
  if (user.global_role === "superadmin") return true;
  const grant = instanceAccessRepo.get(user.id, instanceId);
  return grant ? roleSatisfies(grant.role, minRole) : false;
}

/** The user's effective role on an instance, for the UI to gate actions by — superadmins are always 'admin'. */
export function effectiveInstanceRole(user: UserRow, instanceId: string): InstanceRole | null {
  if (user.global_role === "superadmin") return "admin";
  return instanceAccessRepo.get(user.id, instanceId)?.role ?? null;
}

/** Instance IDs a non-superadmin user has any access to; superadmins should just list all instances. */
export function accessibleInstanceIds(user: UserRow): string[] {
  if (user.global_role === "superadmin") return [];
  return instanceAccessRepo.listForUser(user.id).map((a) => a.instance_id);
}
