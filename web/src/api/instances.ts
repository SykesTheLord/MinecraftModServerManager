import { api } from "./client";
import type { Instance } from "./types";

export interface CreateInstanceInput {
  name: string;
  subdomain: string;
  ftbModpackId: number;
  ftbVersionId: number;
  ftbPackName: string;
  memoryMb: number;
}

export const instancesApi = {
  list: () => api.get<Instance[]>("/instances"),
  get: (id: string) => api.get<Instance>(`/instances/${id}`),
  create: (input: CreateInstanceInput) => api.post<Instance>("/instances", input),
  start: (id: string) => api.post<{ ok: true }>(`/instances/${id}/start`),
  stop: (id: string) => api.post<{ ok: true }>(`/instances/${id}/stop`),
  restart: (id: string) => api.post<{ ok: true }>(`/instances/${id}/restart`),
  updateSubdomain: (id: string, subdomain: string) => api.patch<Instance>(`/instances/${id}`, { subdomain }),
  remove: (id: string, deleteWorldData: boolean) =>
    api.delete<void>(`/instances/${id}?deleteWorldData=${deleteWorldData}`),
  recentLogs: async (id: string): Promise<string> => {
    const res = await fetch(`/api/instances/${id}/logs`, { credentials: "include" });
    return res.text();
  },
};
