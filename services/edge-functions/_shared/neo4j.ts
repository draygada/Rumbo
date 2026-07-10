// Neo4j Query API v2 client for Supabase Edge Functions (Deno).
//
// Aura disables the legacy /db/<db>/tx/commit endpoint (returns 403
// "Denied by administrative rules"). The current supported HTTP interface is
// the Query API v2 at /db/<db>/query/v2. See Infrastructure/neo4j.md §3.

export interface Neo4jStatement {
  statement: string;
  parameters?: Record<string, unknown>;
}

function envRequired(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

export interface Neo4jClient {
  // Returns objects keyed by RETURN column name. Single-column results are
  // still objects — caller can `.map((r) => r.someField)`.
  run<T = Record<string, unknown>>(
    statement: string,
    parameters?: Record<string, unknown>,
  ): Promise<T[]>;
  runMany<T = Record<string, unknown>>(statements: Neo4jStatement[]): Promise<T[][]>;
}

interface QueryApiResponse {
  data?: { fields: string[]; values: unknown[][] };
  errors?: Array<{ code?: string; error?: string; message?: string }>;
  bookmarks?: string[];
}

export function neo4j(): Neo4jClient {
  const uri = envRequired('NEO4J_URI').replace(/\/$/, '');
  const user = envRequired('NEO4J_USER');
  const password = envRequired('NEO4J_PASSWORD');
  // Aura Free names the default database after the instance id, not "neo4j".
  // Fall back to "neo4j" for self-hosted / Aura Pro conventions.
  const database = Deno.env.get('NEO4J_DATABASE') ?? 'neo4j';
  const auth = 'Basic ' + btoa(`${user}:${password}`);
  const url = `${uri}/db/${database}/query/v2`;

  async function runOne<T = Record<string, unknown>>(stmt: Neo4jStatement): Promise<T[]> {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: auth,
      },
      body: JSON.stringify({
        statement: stmt.statement,
        parameters: stmt.parameters ?? {},
      }),
    });
    if (!res.ok) {
      throw new Error(`Neo4j HTTP ${res.status}: ${await res.text()}`);
    }
    const body = (await res.json()) as QueryApiResponse;
    if (body.errors?.length) {
      const e = body.errors[0];
      const code = e.code ?? e.error ?? 'Error';
      const msg = e.message ?? JSON.stringify(e);
      throw new Error(`Neo4j ${code}: ${msg}`);
    }
    const fields = body.data?.fields ?? [];
    const values = body.data?.values ?? [];
    return values.map((row) => {
      const obj: Record<string, unknown> = {};
      for (let i = 0; i < fields.length; i++) obj[fields[i]] = row[i];
      return obj as T;
    });
  }

  async function runMany<T = Record<string, unknown>>(
    statements: Neo4jStatement[],
  ): Promise<T[][]> {
    const out: T[][] = [];
    for (const s of statements) {
      out.push(await runOne<T>(s));
    }
    return out;
  }

  async function run<T = Record<string, unknown>>(
    statement: string,
    parameters: Record<string, unknown> = {},
  ): Promise<T[]> {
    return runOne<T>({ statement, parameters });
  }

  return { run, runMany };
}
