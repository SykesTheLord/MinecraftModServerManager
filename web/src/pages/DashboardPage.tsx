import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { instancesApi } from "../api/instances";
import { InstanceCard } from "../components/InstanceCard";
import { Layout } from "../components/Layout";
import { useCurrentUser } from "../hooks/useCurrentUser";

export function DashboardPage() {
  const { data: user } = useCurrentUser();
  const { data: instances, isLoading } = useQuery({
    queryKey: ["instances"],
    queryFn: instancesApi.list,
    refetchInterval: 5000,
  });

  return (
    <Layout>
      <div className="page-header">
        <h1>Modpack Servers</h1>
        {user?.globalRole === "superadmin" && <Link to="/instances/new" className="button-link">+ New Instance</Link>}
      </div>

      {isLoading && <p>Loading...</p>}
      {instances?.length === 0 && <p>No modpack servers yet.</p>}

      <div className="instance-grid">
        {instances?.map((instance) => (
          <InstanceCard key={instance.id} instance={instance} />
        ))}
      </div>
    </Layout>
  );
}
