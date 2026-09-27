import { useQuery } from "@tanstack/react-query";
import { authApi } from "../api/auth";
import { ApiError } from "../api/client";

export function useCurrentUser() {
  return useQuery({
    queryKey: ["me"],
    queryFn: authApi.me,
    retry: false,
    throwOnError: (error) => !(error instanceof ApiError && error.status === 401),
  });
}
