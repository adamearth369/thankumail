// client/src/lib/apiBase.ts
export function apiBase(): string {
  const v = (import.meta as any).env?.VITE_API_BASE_URL || "";
  return String(v).replace(/\/+$/, "");
}

export function apiUrl(path: string): string {
  const base = apiBase();
  if (!base) return path; // fallback for local/dev
  if (!path) return base;
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${base}${p}`;
}
