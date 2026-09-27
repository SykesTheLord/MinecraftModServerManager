import { api } from "./client";

export const settingsApi = {
  baseDomain: () => api.get<{ baseDomain: string }>("/settings/base-domain"),
};
