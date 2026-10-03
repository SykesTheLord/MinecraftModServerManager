import type { Instance, InstanceStatus } from "../api/types";

const LABELS: Record<InstanceStatus, string> = {
  creating: "Creating",
  awaiting_files: "Needs files",
  installing: "Starting",
  running: "Running",
  stopping: "Stopping",
  stopped: "Stopped",
  error: "Error",
  deleting: "Deleting",
};

export function StatusBadge({ status }: { status: InstanceStatus }) {
  return <span className={`status-badge status-${status}`}>{LABELS[status]}</span>;
}

const SOURCE_LABELS: Record<Instance["source"], string> = {
  ftb: "FTB",
  curseforge: "CurseForge",
  import: "Imported",
};

export function SourceChip({ source }: { source: Instance["source"] }) {
  return <span className="chip">{SOURCE_LABELS[source]}</span>;
}
