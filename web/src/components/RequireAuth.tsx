import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { useCurrentUser } from "../hooks/useCurrentUser";

export function RequireAuth({ children }: { children: ReactNode }) {
  const { data: user, isLoading, isError } = useCurrentUser();

  if (isLoading) return <div className="page-loading">Loading...</div>;
  if (isError || !user) return <Navigate to="/login" replace />;

  return <>{children}</>;
}

export function RequireSuperadmin({ children }: { children: ReactNode }) {
  const { data: user, isLoading } = useCurrentUser();

  if (isLoading) return <div className="page-loading">Loading...</div>;
  if (user?.globalRole !== "superadmin") return <Navigate to="/" replace />;

  return <>{children}</>;
}
