// Neo4j HTTP transactional-commit client for Supabase Edge Functions (Deno).
// See Infrastructure/neo4j.md §3.

export interface Neo4jStatement {
  statement: string;
  parameters?: Record<string, unknown>;
}

function envRequired(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function b64(input: string): string {
  return btoa(input);
}

export interface Neo4jClient {
  run<T = unknown>(statement: string, parameters?: Record<string, unknown>): Promise<T[]>;
  runMany<T = unknown>(statements: Neo4jStatement[]): Promise<T[][]>;
}

export function neo4j(): Neo4jClient {
  const uri = envRequired('NEO4J_URI').replace(/\/$/, '');
  const user = envRequired('NEO4J_USER');
  const password = envRequired('NEO4J_PASSWORD');
  const auth = 'Basic ' + b64(`${user}:${password}`);
  const url = `${uri}/db/neo4j/tx/commit`;

  async function runMany<T = unknown>(statements: Neo4jStatement[]): Promise<T[][]> {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: auth },
      body: JSON.stringify({
        statements: statements.map((s) => ({
          statement: s.statement,
          parameters: s.parameters ?? {},
          resultDataContents: ['row'],
        })),
      }),
    });
    if (!res.ok) {
      throw new Error(`Neo4j HTTP ${res.status}: ${await res.text()}`);
    }
    const body = await res.json();
    if (body.errors?.length) {
      const e = body.errors[0];
      throw new Error(`Neo4j ${e.code}: ${e.message}`);
    }
    return (body.results as Array<{ data: Array<{ row: unknown[] }> }>).map((r) =>
      r.data.map((d) => d.row[0] as T),
    );
  }

  async function run<T = unknown>(
    statement: string,
    parameters: Record<string, unknown> = {},
  ): Promise<T[]> {
    const [rows] = await runMany<T>([{ statement, parameters }]);
    return rows;
  }

  return { run, runMany };
}
