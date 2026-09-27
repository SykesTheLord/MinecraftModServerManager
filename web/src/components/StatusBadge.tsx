import type { InstanceStatus } from "../api/types";

const LABELS: Record<InstanceStatus, string> = {
  creating: "Creating",
  installing: "Installing",
  running: "Running",
  stopped: "Stopped",
  error: "Error",
  deleting: "Deleting",
};

export function StatusBadge({ status }: { status: InstanceStatus }) {
  return <span className={`status-badge status-${status}`}>{LABELS[status]}</span>;
}
