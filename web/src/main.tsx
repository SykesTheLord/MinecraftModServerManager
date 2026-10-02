import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "./index.css";
import { App } from "./App";
import { ApiError } from "./api/client";

// A 401 anywhere means the session ended (idle timeout, manager restart,
// password changed elsewhere). Re-checking "me" fails too, and RequireAuth
// then sends the user to the login page instead of leaving a page of errors.
const onError = (error: unknown) => {
  if (error instanceof ApiError && error.status === 401) {
    void queryClient.invalidateQueries({ queryKey: ["me"] });
  }
};

const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: (error, query) => query.queryKey[0] !== "me" && onError(error) }),
  mutationCache: new MutationCache({ onError }),
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>
);
