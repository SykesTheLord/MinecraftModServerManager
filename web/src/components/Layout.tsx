import type { ReactNode } from "react";
import { Link, NavLink, useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { authApi } from "../api/auth";
import { useCurrentUser } from "../hooks/useCurrentUser";
import { APP_NAME, useDocumentTitle } from "../hooks/useDocumentTitle";
import { BrandMark } from "./Icons";

const navClass = ({ isActive }: { isActive: boolean }) => (isActive ? "nav-link active" : "nav-link");

export function Layout({ children, narrow = false, title }: { children: ReactNode; narrow?: boolean; title?: string }) {
  const { data: user } = useCurrentUser();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  useDocumentTitle(title);

  const logout = useMutation({
    mutationFn: authApi.logout,
    onSuccess: () => {
      // Drop everything cached for this user, so nothing of theirs is shown to whoever signs in next.
      queryClient.clear();
      navigate("/login");
    },
  });

  return (
    <div className="layout">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <header className="top-nav">
        <Link to="/" className="brand">
          <BrandMark />
          <span className="brand-name">{APP_NAME}</span>
        </Link>
        <nav aria-label="Main">
          <NavLink to="/" end className={navClass}>
            Servers
          </NavLink>
          {user?.globalRole === "superadmin" && (
            <NavLink to="/users" className={navClass}>
              Users
            </NavLink>
          )}
          <NavLink to="/settings" className={navClass}>
            Settings
          </NavLink>
          {user && (
            <span className="nav-user">
              <span className="avatar" aria-hidden="true">
                {user.username.slice(0, 1)}
              </span>
              <span className="username">{user.username}</span>
              <button className="ghost small" onClick={() => logout.mutate()} disabled={logout.isPending}>
                Log out
              </button>
            </span>
          )}
        </nav>
      </header>
      <main id="main" className={narrow ? "narrow" : undefined}>
        {children}
      </main>
    </div>
  );
}
