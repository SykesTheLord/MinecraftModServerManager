import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { instancesApi } from "../api/instances";
import { InstanceCard } from "../components/InstanceCard";
import { Layout } from "../components/Layout";
import { PageHeader } from "../components/PageHeader";
import { ImportsList } from "../components/ImportsList";
import { useCurrentUser } from "../hooks/useCurrentUser";
import { useBaseDomain } from "../hooks/useBaseDomain";

export function DashboardPage() {
  const { data: user } = useCurrentUser();
  const baseDomain = useBaseDomain();
  const isSuperadmin = user?.globalRole === "superadmin";
  const { data: instances, isLoading } = useQuery({
    queryKey: ["instances"],
    queryFn: instancesApi.list,
    refetchInterval: 5000,
  });

  const count = (pred: (s: string) => boolean) => instances?.filter((i) => pred(i.status)).length ?? 0;
  const running = count((s) => s === "running");
  const busy = count((s) => s === "creating" || s === "installing" || s === "stopping");
  const attention = count((s) => s === "error" || s === "awaiting_files");

  const actions = isSuperadmin && (
    <>
      <Link to="/instances/import" className="button-link secondary">
        Import server
      </Link>
      <Link to="/instances/new" className="button-link">
        + New server
      </Link>
    </>
  );

  return (
    <Layout title="Servers">
      <PageHeader
        title="Servers"
        subtitle={baseDomain ? `Every server shares port 25565 — players join with <name>.${baseDomain}` : undefined}
        actions={actions}
      />

      {instances && instances.length > 0 && (
        <div className="stat-row">
          <div className="stat">
            <div className="stat-label">Servers</div>
            <div className="stat-value">{instances.length}</div>
          </div>
          <div className="stat">
            <div className="stat-label">Running</div>
            <div className="stat-value success">{running}</div>
          </div>
          <div className="stat">
            <div className="stat-label">Starting / stopping</div>
            <div className="stat-value">{busy}</div>
          </div>
          <div className="stat">
            <div className="stat-label">Need attention</div>
            <div className={attention ? "stat-value danger" : "stat-value"}>{attention}</div>
          </div>
        </div>
      )}

      {isLoading && (
        <div className="page-loading">
          <span className="spinner" aria-label="Loading" />
        </div>
      )}
      {instances?.length === 0 && (
        <div className="empty-state">
          <h2>No servers yet</h2>
          <p>
            {isSuperadmin
              ? "Deploy a modpack from FTB or CurseForge, or bring over a server you already run."
              : "You haven't been given access to any servers yet."}
          </p>
          {isSuperadmin && <div className="form-actions">{actions}</div>}
        </div>
      )}

      {isSuperadmin && <ImportsList title="Imports" />}

      <div className="instance-grid">
        {instances?.map((instance) => (
          <InstanceCard key={instance.id} instance={instance} baseDomain={baseDomain} />
        ))}
      </div>
    </Layout>
  );
}
