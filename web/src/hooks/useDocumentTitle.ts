import { useEffect } from "react";

export const APP_NAME = "Mod Server Manager";

export function useDocumentTitle(title: string | undefined) {
  useEffect(() => {
    document.title = title ? `${title} · ${APP_NAME}` : APP_NAME;
  }, [title]);
}
