// Neo4j HTTP transactional-commit client.
// Used from Node-side scripts and the web app; Edge Functions have their own
// Deno-compatible copy at services/edge-functions/_shared/neo4j.ts to avoid
// the workspace-import friction called out in Infrastructure/monorepo.md §8.4.

export interface CypherStatement {
  statement: string;
  parameters?: Record<string, unknown>;
}

export interface CypherError {
  code: string;
  message: string;
}

export interface CypherClientOptions {
  uri: string;       // https://xxxxx.databases.neo4j.io  (no trailing slash, no path)
  user: string;      // usually "neo4j"
  password: string;
  database?: string; // defaults to "neo4j"
}

export class CypherError_ extends Error {
  code: string;
  constructor(err: CypherError) {
    super(`Neo4j ${err.code}: ${err.message}`);
    this.code = err.code;
  }
}

export function makeCypherClient(opts: CypherClientOptions) {
  const db = opts.database ?? 'neo4j';
  const auth = 'Basic ' + Buffer.from(`${opts.user}:${opts.password}`).toString('base64');
  const url = `${opts.uri.replace(/\/$/, '')}/db/${db}/tx/commit`;

  async function runMany<T = unknown>(statements: CypherStatement[]): Promise<T[][]> {
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
    if (!res.ok) throw new Error(`Neo4j HTTP ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as {
      results: { data: { row: T[] }[] }[];
      errors: CypherError[];
    };
    if (body.errors?.length) throw new CypherError_(body.errors[0]);
    return body.results.map((r) => r.data.map((d) => d.row as unknown as T));
  }

  async function run<T = unknown>(
    statement: string,
    parameters: Record<string, unknown> = {},
  ): Promise<T[]> {
    const [rows] = await runMany<T>([{ statement, parameters }]);
    return rows.map((r) => (r as unknown as T[])[0]);
  }

  return { run, runMany };
}

export type CypherClient = ReturnType<typeof makeCypherClient>;
