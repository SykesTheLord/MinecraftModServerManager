import { api } from "./client";
import type { ModpackSummary, ModpackVersionSummary } from "./types";

export const ftbApi = {
  search: (query: string) => api.get<ModpackSummary[]>(`/ftb/modpacks?query=${encodeURIComponent(query)}`),
  versions: (modpackId: number) => api.get<ModpackVersionSummary[]>(`/ftb/modpacks/${modpackId}/versions`),
};
