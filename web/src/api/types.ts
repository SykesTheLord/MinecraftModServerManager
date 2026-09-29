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
  source: "ftb" | "import";
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

export type ServerType = "FORGE" | "NEOFORGE" | "FABRIC" | "QUILT" | "PAPER" | "VANILLA" | "CUSTOM";

export interface ImportAnalysis {
  serverType: ServerType;
  minecraftVersion: string | null;
  loaderVersion: string | null;
  customJar: string | null;
  javaVersion: number | null;
  javaVersions: number[];
  memoryMb: number | null;
  levelName: string;
  worldFound: boolean;
  motd: string | null;
  jars: string[];
  modCount: number;
  totalBytes: number;
  warnings: string[];
}

export interface ImportJob {
  id: string;
  source: "upload" | "ssh";
  label: string;
  state: "receiving" | "processing" | "ready" | "deploying" | "failed";
  receivedBytes: number;
  expectedBytes: number | null;
  error: string | null;
  analysis: ImportAnalysis | null;
}
