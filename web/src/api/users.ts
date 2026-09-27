import { api } from "./client";
import type { GlobalRole, InstanceRole, ManagedUser } from "./types";

export const usersApi = {
  list: () => api.get<ManagedUser[]>("/users"),
  create: (username: string, password: string, globalRole: GlobalRole) =>
    api.post<ManagedUser>("/users", { username, password, globalRole }),
  remove: (id: string) => api.delete<void>(`/users/${id}`),
  listAccess: (userId: string) => api.get<{ instanceId: string; role: InstanceRole }[]>(`/users/${userId}/access`),
  grantAccess: (userId: string, instanceId: string, role: InstanceRole) =>
    api.put<{ ok: true }>(`/users/${userId}/access`, { instanceId, role }),
  revokeAccess: (userId: string, instanceId: string) =>
    api.delete<void>(`/users/${userId}/access/${instanceId}`),
  changeOwnPassword: (currentPassword: string, password: string) =>
    api.put<{ ok: true }>("/users/me/password", { currentPassword, password }),
};
