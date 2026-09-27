export type InstanceStatus = "creating" | "installing" | "running" | "stopped" | "error" | "deleting";

export interface Instance {
  id: string;
  name: string;
  subdomain: string;
  ftb_modpack_id: number;
  ftb_version_id: number;
  ftb_pack_name: string;
  memory_mb: number;
  image: string;
  container_id: string | null;
  container_name: string;
  volume_name: string;
  status: InstanceStatus;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  effectiveRole: "admin" | "operator" | null;
}

export type GlobalRole = "superadmin" | "user";
export type InstanceRole = "admin" | "operator";

export interface CurrentUser {
  id: string;
  username: string;
  globalRole: GlobalRole;
}

export interface ManagedUser {
  id: string;
  username: string;
  globalRole: GlobalRole;
}

export interface ModpackSummary {
  id: number;
  name: string;
  synopsis: string;
}

export interface ModpackVersionSummary {
  id: number;
  name: string;
}
