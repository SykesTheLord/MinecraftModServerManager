import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { instancesApi } from "../api/instances";
import { Layout } from "../components/Layout";
import { StatusBadge } from "../components/StatusBadge";
import { ConsoleView } from "../components/ConsoleView";
import { errorMessage, latestMutationError } from "../api/client";

export function InstanceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [subdomainDraft, setSubdomainDraft] = useState<string | null>(null);
  const [deleteWorldData, setDeleteWorldData] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const { data: instance, isLoading, error } = useQuery({
    queryKey: ["instance", id],
    queryFn: () => instancesApi.get(id!),
    refetchInterval: 5000,
    retry: false,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["instance", id] });
    queryClient.invalidateQueries({ queryKey: ["instances"] });
  };

  const start = useMutation({ mutationFn: () => instancesApi.start(id!), onSuccess: invalidate });
  const stop = useMutation({ mutationFn: () => instancesApi.stop(id!), onSuccess: invalidate });
  const restart = useMutation({ mutationFn: () => instancesApi.restart(id!), onSuccess: invalidate });
  const updateSubdomain = useMutation({
    mutationFn: (subdomain: string) => instancesApi.updateSubdomain(id!, subdomain),
    onSuccess: () => {
      setSubdomainDraft(null);
      invalidate();
    },
  });
  const remove = useMutation({
    mutationFn: () => instancesApi.remove(id!, deleteWorldData),
    onSuccess: () => navigate("/"),
  });

  if (!instance) {
    return (
      <Layout>
        {isLoading || !error ? (
          <p>Loading...</p>
        ) : (
          <p className="error-text">{errorMessage(error, "Failed to load this instance.")}</p>
        )}
      </Layout>
    );
  }

  const canOperate = instance.effectiveRole === "admin" || instance.effectiveRole === "operator";
  const canAdmin = instance.effectiveRole === "admin";
  const isRunning = instance.status === "running" || instance.status === "installing";
  const actionError = latestMutationError(start, stop, restart, updateSubdomain, remove);

  return (
    <Layout>
      <div className="page-header">
        <h1>
          {instance.name} <StatusBadge status={instance.status} />
        </h1>
      </div>

      <section className="card">
        <p>
          <strong>Modpack:</strong> {instance.ftb_pack_name}
        </p>
        <p>
          <strong>Subdomain:</strong>{" "}
          {subdomainDraft === null ? (
            <>
              {instance.subdomain}
              {canAdmin && <button onClick={() => setSubdomainDraft(instance.subdomain)}>Edit</button>}
            </>
          ) : (
            <span className="subdomain-edit">
              <input value={subdomainDraft} onChange={(e) => setSubdomainDraft(e.target.value)} />
              <button onClick={() => updateSubdomain.mutate(subdomainDraft)} disabled={updateSubdomain.isPending}>
                Save
              </button>
              <button onClick={() => setSubdomainDraft(null)}>Cancel</button>
            </span>
          )}
        </p>
        <p>
          <strong>Memory:</strong> {instance.memory_mb} MB
        </p>
        <p>
          <strong>Image:</strong> <code>{instance.image}</code>
        </p>
        {instance.status === "error" && instance.last_error && (
          <pre className="instance-error-log">{instance.last_error}</pre>
        )}

        {canOperate && (
          <div className="instance-card-actions">
            {isRunning ? (
              <>
                <button onClick={() => stop.mutate()} disabled={stop.isPending}>
                  Stop
                </button>
                <button onClick={() => restart.mutate()} disabled={restart.isPending}>
                  Restart
                </button>
              </>
            ) : (
              <button onClick={() => start.mutate()} disabled={start.isPending}>
                Start
              </button>
            )}
            {canAdmin && !confirmingDelete && (
              <button className="danger" onClick={() => setConfirmingDelete(true)}>
                Delete
              </button>
            )}
          </div>
        )}

        {confirmingDelete && (
          <div className="delete-confirm">
            <label>
              <input
                type="checkbox"
                checked={deleteWorldData}
                onChange={(e) => setDeleteWorldData(e.target.checked)}
              />
              Also permanently delete world data
            </label>
            <button className="danger" onClick={() => remove.mutate()} disabled={remove.isPending}>
              Confirm delete
            </button>
            <button onClick={() => setConfirmingDelete(false)}>Cancel</button>
          </div>
        )}
        {actionError != null && <p className="error-text">{errorMessage(actionError, "Action failed.")}</p>}
      </section>

      {canOperate && (
        <section className="card">
          <h2>Console</h2>
          {/* Keyed on the container so the console reconnects once a container exists. */}
          <ConsoleView key={instance.container_id ?? "none"} instanceId={instance.id} />
        </section>
      )}
    </Layout>
  );
}
