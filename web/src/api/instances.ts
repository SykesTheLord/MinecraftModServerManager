import { api, ApiError } from "./client";
import type { AutoUpdateMode, BackupInfo, Instance, MissingFileDetail, PackLinkInput, PackVersionOption, ServerPropertiesView, UpdateWindow } from "./types";

export interface CreateInstanceInput {
  name: string;
  subdomain: string;
  ftbModpackId: number;
  ftbVersionId: number;
  ftbPackName: string;
  memoryMb: number;
}

export interface CreateCurseForgeInstanceInput {
  name: string;
  subdomain: string;
  modId: number;
  fileId: number;
  memoryMb: number;
  javaVersion: number | null;
}

export const instancesApi = {
  properties: (id: string) => api.get<ServerPropertiesView>(`/instances/${id}/properties`),
  saveProperties: (id: string, properties: Record<string, string>, revision: string, restart: boolean) =>
    api.put<ServerPropertiesView & { restarted: boolean }>(`/instances/${id}/properties`, { properties, revision, restart }),
  /** `refresh`: force CurseForge's version list to be fetched again (otherwise reused for 12 hours). */
  versions: (id: string, refresh = false) => api.get<PackVersionOption[]>(`/instances/${id}/versions${refresh ? "?refresh=1" : ""}`),
  checkForUpdate: (id: string, refresh = false) => api.post<Instance>(`/instances/${id}/updates/check${refresh ? "?refresh=1" : ""}`),
  updateSettings: (id: string, settings: { autoUpdate?: AutoUpdateMode; window?: UpdateWindow | null }) =>
    api.put<Instance>(`/instances/${id}/updates/settings`, settings),
  backups: (id: string) => api.get<BackupInfo[]>(`/instances/${id}/backups`),
  createBackup: (id: string) => api.post<{ name: string }>(`/instances/${id}/backups`),
  restoreBackup: (id: string, name: string, switchVersion: boolean) =>
    api.post<Instance>(`/instances/${id}/backups/${encodeURIComponent(name)}/restore`, { switchVersion }),
  applyUpdate: (id: string, versionId: number) => api.post<Instance>(`/instances/${id}/updates/apply`, { versionId }),
  createCurseForge: (input: CreateCurseForgeInstanceInput) => api.post<Instance>("/instances/curseforge", input),
  retryCurseForgeInstall: (id: string) => api.post<{ ok: true }>(`/instances/${id}/curseforge/retry`),
  answerStartupQuery: (id: string, answer: "confirm" | "cancel") =>
    api.post<Instance>(`/instances/${id}/startup-query`, { answer }),
  /** Links an imported server to the modpack (and version) it is; null unlinks it. Platform admins only. */
  setPackLink: (id: string, pack: PackLinkInput | null) => api.put<Instance>(`/instances/${id}/pack-link`, { pack }),
  missingFiles: (id: string) => api.get<MissingFileDetail[]>(`/instances/${id}/curseforge/missing-files`),
  uploadCurseForgeFile: async (id: string, fileId: number, file: File): Promise<Instance> => {
    const res = await fetch(`/api/instances/${id}/curseforge/files/${fileId}`, {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/octet-stream" },
      body: file,
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new ApiError(res.status, body?.error ?? `Upload failed (${res.status})`);
    return body as Instance;
  },
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
