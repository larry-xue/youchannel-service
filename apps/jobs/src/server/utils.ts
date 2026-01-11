export function parseTimestamp(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function readHeaderValue(value: string | string[] | undefined): string | undefined {
  if (!value) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

export function parseRequiredString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function parseOptionalString(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function parseOptionalQueryString(value: string | string[] | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function parseStringArray(value: unknown): string[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) return null;
  const items = value.map((item) => (typeof item === "string" ? item.trim() : ""));
  if (items.some((item) => item.length === 0)) return null;
  return items;
}

export function normalizeUnique(values?: string[] | null): string[] | null | undefined {
  if (!values) return values;
  return Array.from(new Set(values));
}

export function parseLimit(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return undefined;
  const limit = Number(value);
  if (!Number.isFinite(limit) || limit <= 0) return null;
  return Math.trunc(limit);
}

export function parseOffset(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return undefined;
  const offset = Number(value);
  if (!Number.isFinite(offset) || offset < 0) return null;
  return Math.trunc(offset);
}
