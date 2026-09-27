import { api } from "./client";
import type { CurrentUser } from "./types";

export const authApi = {
  login: (username: string, password: string) => api.post<CurrentUser>("/auth/login", { username, password }),
  logout: () => api.post<{ ok: true }>("/auth/logout"),
  me: () => api.get<CurrentUser>("/auth/me"),
};
