export type InstanceStatus =
  | "creating"
  | "awaiting_files"
  | "installing"
  | "running"
  | "stopping"
  | "stopped"
  | "error"
  | "deleting";

export type AutoUpdateMode = "off" | "notify" | "auto";

export interface ServerProperty {
  key: string;
  value: string;
  /** Why it can't be edited, if it can't. */
  managed: string | null;
}

export interface ServerPropertiesView {
  properties: ServerProperty[];
  revision: string;
}

export interface BackupInfo {
  name: string;
  sizeBytes: number;
  createdAt: string;
  reason?: "update" | "manual" | "restore";
  versionId?: number | null;
  versionName?: string | null;
}

export interface UpdateWindow {
  start: string;
  end: string;
  timeZone: string;
}

export interface PackVersionOption {
  id: number;
  name: string;
  minecraftVersion: string | null;
  date: number;
  release: boolean;
  current: boolean;
}

/** A file a blocked CurseForge install waits for (only what the manager stores). */
export interface MissingFile {
  fileId: number;
  fileName: string;
  uploaded: boolean;
}

/** The same file with its name and download page, looked up live from CurseForge. */
export interface MissingFileDetail extends MissingFile {
  modName: string;
  displayName: string;
  pageUrl: string;
}

export type PackProvider = "ftb" | "curseforge";

/** A modpack and version, as picked to link an imported server to. */
export interface PackLinkInput {
  provider: PackProvider;
  packId: number;
  versionId: number;
}

/** What the UI shows about a modpack before deploying (or linking) it. `description` is Markdown-lite text. */
export interface PackPreview {
  id: number;
  name: string;
  summary: string;
  description: string;
  artUrl: string | null;
  bannerUrl: string | null;
  screenshots: { title: string; thumbnailUrl: string; url: string }[];
  authors: string[];
  tags: string[];
  downloads: number;
  updatedAt: string | null;
  releasedAt: string | null;
  websiteUrl: string | null;
  links: { name: string; url: string }[];
}

/** A question the server is waiting on before it can finish starting (Forge's missing registry entries). */
export interface StartupQuery {
  entries: string[];
  excerpt: string;
}

export interface Instance {
  id: string;
  name: string;
  subdomain: string;
  ftb_modpack_id: number;
  ftb_version_id: number;
  ftb_pack_name: string;
  memory_mb: number;
  image: string;
  source: "ftb" | "import" | "curseforge";
  cf_mod_id: number | null;
  cf_file_id: number | null;
  installRunning: boolean;
  missingFiles: MissingFile[];
  auto_update: AutoUpdateMode;
  pack_version_name: string | null;
  available_version_id: number | null;
  available_version_name: string | null;
  update_checked_at: string | null;
  update_result: string | null;
  updating: boolean;
  update_window_start: string | null;
  update_window_end: string | null;
  update_window_tz: string | null;
  /** JSON of the itzg env an imported/CurseForge server runs with (TYPE, VERSION, …). */
  server_env: string | null;
  /** An imported server's modpack, if it was linked to one. */
  pack_link: PackProvider | null;
  linked_pack_name: string | null;
  startupQuery: StartupQuery | null;
  updateWindowOpen: boolean;
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
  installs: number;
  updatedAt: number | null;
  featured: boolean;
  artUrl: string | null;
  tags: string[];
  minecraftVersion: string | null;
  loader: string | null;
}

export interface ModpackVersionSummary {
  id: number;
  name: string;
  type: string;
  updatedAt: number | null;
  minecraftVersion: string | null;
  loader: string | null;
  javaVersion: string | null;
  recommendedMemoryMb: number | null;
}

export interface CfModpackSummary {
  id: number;
  name: string;
  slug: string;
  summary: string;
  downloads: number;
  updatedAt: string | null;
  logoUrl: string | null;
  authors: string[];
  categories: string[];
  minecraftVersions: string[];
  loaders: string[];
  websiteUrl: string | null;
}

export interface CfFileSummary {
  id: number;
  displayName: string;
  fileName: string;
  releaseType: "release" | "beta" | "alpha";
  date: string;
  minecraftVersion: string | null;
  loaders: string[];
  sizeBytes: number | null;
}

export type CfSort = "popularity" | "downloads" | "updated" | "name" | "featured";
export type CfLoader = "forge" | "neoforge" | "fabric" | "quilt";

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

/** One of the host user's SSH keys the manager can use for SSH imports (never the private key itself). */
export interface LocalSshKey {
  name: string;
  type: string | null;
  fingerprint: string | null;
  publicKey: string | null;
  comment: string;
  encrypted: boolean;
}

export interface ImportJob {
  id: string;
  source: "upload" | "ssh";
  label: string;
  state: "receiving" | "processing" | "ready" | "deploying" | "deployed" | "failed";
  receivedBytes: number;
  expectedBytes: number | null;
  error: string | null;
  analysis: ImportAnalysis | null;
  /** The server a deployed import became. */
  instanceId: string | null;
  /** Unix milliseconds. */
  createdAt: number;
}
