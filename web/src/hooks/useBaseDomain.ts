import { useQuery } from "@tanstack/react-query";
import { settingsApi } from "../api/settings";

export function useBaseDomain(): string | undefined {
  const { data } = useQuery({ queryKey: ["base-domain"], queryFn: settingsApi.baseDomain, staleTime: Infinity });
  return data?.baseDomain;
}
