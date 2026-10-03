import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { importsApi } from "../api/imports";
import type { ImportJob } from "../api/types";
import { formatBytes, timeAgo } from "../lib/format";

const STATE_LABELS: Record<ImportJob["state"], string> = {
  receiving: "Copying files",
  processing: "Unpacking and analyzing",
  ready: "Ready to review",
  deploying: "Deploying",
  deployed: "Deployed",
  failed: "Failed",
};

const ACTIVE: ImportJob["state"][] = ["receiving", "processing", "deploying"];

/**
 * Imports the manager is working on or waiting on, so one started earlier
 * (on this page or another, in this tab or another) can be picked up again.
 * Renders nothing when there are none.
 */
export function ImportsList({ title, excludeId }: { title: string; excludeId?: string }) {
  const { data: jobs } = useQuery({
    queryKey: ["imports"],
    queryFn: importsApi.list,
    refetchInterval: (query) => (query.state.data?.some((j) => ACTIVE.includes(j.state)) ? 2000 : 15000),
  });
  const shown = jobs?.filter((j) => j.id !== excludeId) ?? [];
  if (shown.length === 0) return null;

  return (
    <section className="card">
      <h2>{title}</h2>
      <ul className="checklist">
        {shown.map((job) => (
          <li key={job.id}>
            <div className="checklist-main">
              <strong>{job.label}</strong>
              <span className="muted">
                {job.source === "ssh" ? "SSH copy" : "Upload"} · started {timeAgo(new Date(job.createdAt))}
              </span>
            </div>
            <span className="import-state">
              {ACTIVE.includes(job.state) && <span className="spinner" aria-hidden="true" />}
              <span className={job.state === "failed" ? "chip danger" : job.state === "ready" ? "chip accent" : "chip"}>
                {STATE_LABELS[job.state]}
                {job.state === "receiving" && job.receivedBytes > 0 && ` · ${formatBytes(job.receivedBytes)}`}
              </span>
            </span>
            {job.state === "deployed" && job.instanceId ? (
              <Link to={`/instances/${job.instanceId}`} className="button-link secondary small">
                Open server
              </Link>
            ) : (
              <Link to={`/instances/import/${job.id}`} className="button-link secondary small">
                {job.state === "ready" ? "Review" : "Open"}
              </Link>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
