// Small helpers for reading Supabase from the server and the browser.

type Page = { data: unknown; error: { message: string } | null };

// PostgREST serializes `numeric` as JSON numbers, but be defensive: a value
// that arrives as a string would otherwise break `.toFixed()` downstream.
export function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Every row of a query, paging past PostgREST's 1,000-rows-per-response cap. */
export async function selectAll<T>(
  build: (from: number, to: number) => PromiseLike<Page>,
  pageSize = 1000,
  maxRows = 100000,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < maxRows; from += pageSize) {
    const { data, error } = await build(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < pageSize) break;
  }
  return out;
}

/** Rows of a single-page query, or an Error carrying PostgREST's message. */
export async function rows(q: PromiseLike<Page>): Promise<Record<string, unknown>[]> {
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? []) as Record<string, unknown>[];
}
