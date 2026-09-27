import type { ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { authApi } from "../api/auth";
import { useCurrentUser } from "../hooks/useCurrentUser";

export function Layout({ children }: { children: ReactNode }) {
  const { data: user } = useCurrentUser();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const logout = useMutation({
    mutationFn: authApi.logout,
    onSuccess: () => {
      queryClient.setQueryData(["me"], undefined);
      navigate("/login");
    },
  });

  return (
    <div className="layout">
      <header className="top-nav">
        <Link to="/" className="brand">
          MC Mod Server Manager
        </Link>
        <nav>
          {user?.globalRole === "superadmin" && <Link to="/users">Users</Link>}
          <Link to="/settings">Settings</Link>
          {user && (
            <span className="nav-user">
              {user.username}
              <button onClick={() => logout.mutate()}>Log out</button>
            </span>
          )}
        </nav>
      </header>
      <main>{children}</main>
    </div>
  );
}
