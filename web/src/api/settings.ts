import { api } from "./client";

export const settingsApi = {
  baseDomain: () => api.get<{ baseDomain: string }>("/settings/base-domain"),
  version: () => api.get<{ version: string; commit: string }>("/settings/version"),
};
