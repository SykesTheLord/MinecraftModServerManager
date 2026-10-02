import { api } from "./client";
import type { ModpackSummary, ModpackVersionSummary } from "./types";

export const ftbApi = {
  /** The whole FTB catalog (cached server-side). */
  list: () => api.get<ModpackSummary[]>("/ftb/modpacks"),
  versions: (modpackId: number) => api.get<ModpackVersionSummary[]>(`/ftb/modpacks/${modpackId}/versions`),
};
