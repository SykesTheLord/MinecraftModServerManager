import { api } from "./client";
import type { ModpackSummary, ModpackVersionSummary, PackPreview } from "./types";

export const ftbApi = {
  /** The whole FTB catalog (cached server-side). */
  list: () => api.get<ModpackSummary[]>("/ftb/modpacks"),
  preview: (modpackId: number) => api.get<PackPreview>(`/ftb/modpacks/${modpackId}`),
  versions: (modpackId: number) => api.get<ModpackVersionSummary[]>(`/ftb/modpacks/${modpackId}/versions`),
};
