import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { authApi } from "../api/auth";
import { ApiError } from "../api/client";

export function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const login = useMutation({
    mutationFn: () => authApi.login(username, password),
    onSuccess: (user) => {
      queryClient.setQueryData(["me"], user);
      navigate("/");
    },
  });

  return (
    <div className="login-page">
      <form
        className="card login-form"
        onSubmit={(e) => {
          e.preventDefault();
          login.mutate();
        }}
      >
        <h1>Minecraft Mod Server Manager</h1>
        <label>
          Username
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {login.isError && (
          <p className="error-text">
            {login.error instanceof ApiError ? login.error.message : "Login failed."}
          </p>
        )}
        <button type="submit" disabled={login.isPending}>
          {login.isPending ? "Signing in..." : "Sign in"}
        </button>
      </form>
    </div>
  );
}
