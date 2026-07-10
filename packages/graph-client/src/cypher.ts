// Neo4j Query API v2 client — Node-side.
//
// Aura disables the legacy /tx/commit endpoint; use /db/<db>/query/v2 instead.
// Edge Functions have their own Deno-compatible copy at
// services/edge-functions/_shared/neo4j.ts to avoid the workspace-import
// friction called out in Infrastructure/monorepo.md §8.4.

export interface CypherStatement {
  statement: string;
  parameters?: Record<string, unknown>;
}

export interface CypherClientOptions {
  uri: string;       // https://xxxxx.databases.neo4j.io  (no trailing slash, no path)
  user: string;      // usually "neo4j"
  password: string;
  database?: string; // defaults to "neo4j"
}

interface QueryApiResponse {
  data?: { fields: string[]; values: unknown[][] };
  errors?: Array<{ code?: string; error?: string; message?: string }>;
  bookmarks?: string[];
}

export function makeCypherClient(opts: CypherClientOptions) {
  const db = opts.database ?? 'neo4j';
  const auth = 'Basic ' + Buffer.from(`${opts.user}:${opts.password}`).toString('base64');
  const url = `${opts.uri.replace(/\/$/, '')}/db/${db}/query/v2`;

  async function runOne<T>(stmt: CypherStatement): Promise<T[]> {
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
    if (!res.ok) throw new Error(`Neo4j HTTP ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as QueryApiResponse;
    if (body.errors?.length) {
      const e = body.errors[0];
      throw new Error(`Neo4j ${e.code ?? e.error ?? 'Error'}: ${e.message ?? JSON.stringify(e)}`);
    }
    const fields = body.data?.fields ?? [];
    const values = body.data?.values ?? [];
    return values.map((row) => {
      const obj: Record<string, unknown> = {};
      for (let i = 0; i < fields.length; i++) obj[fields[i]] = row[i];
      return obj as unknown as T;
    });
  }

  async function runMany<T = Record<string, unknown>>(
    statements: CypherStatement[],
  ): Promise<T[][]> {
    const out: T[][] = [];
    for (const s of statements) out.push(await runOne<T>(s));
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

export type CypherClient = ReturnType<typeof makeCypherClient>;
