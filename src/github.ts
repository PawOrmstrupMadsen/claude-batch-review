// Thin GitHub REST and Actions-runtime helpers (no @actions/* dependency).
import { appendFileSync } from "node:fs";

export function input(name: string, fallback = ""): string {
  const v = process.env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`];
  return v === undefined || v.trim() === "" ? fallback : v.trim();
}

export function setOutput(name: string, value: string): void {
  const file = process.env.GITHUB_OUTPUT;
  if (file) appendFileSync(file, `${name}=${value}\n`);
}

/** Appends Markdown to the job summary on the run's page. */
export function summary(markdown: string): void {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) appendFileSync(file, `${markdown}\n`);
}

/** `title` heads the annotation in the PR's checks tab and on the run's page. */
const annotate = (kind: string) => (m: string, title?: string) =>
  console.log(`::${kind}${title ? ` title=${escapeProperty(title)}` : ""}::${escape(m)}`);

export const log = {
  info: (m: string) => console.log(m),
  notice: annotate("notice"),
  warning: annotate("warning"),
  error: annotate("error"),
  mask: (secret: string) => console.log(`::add-mask::${secret}`),
};

function escape(m: string): string {
  return m.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function escapeProperty(m: string): string {
  return escape(m).replace(/:/g, "%3A").replace(/,/g, "%2C");
}

export class GitHub {
  private readonly api: string;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly token: string,
    readonly owner: string,
    readonly repo: string,
    fetchImpl: typeof fetch = fetch,
  ) {
    // Wrapped so the native fetch is never called with this object as `this`.
    this.fetchImpl = (input, init) => fetchImpl(input, init);
    this.api = process.env.GITHUB_API_URL || "https://api.github.com";
  }

  async request(path: string, init: RequestInit & { accept?: string } = {}): Promise<Response> {
    const url = path.startsWith("http") ? path : `${this.api}${path}`;
    const res = await this.fetchImpl(url, {
      ...init,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: init.accept ?? "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "claude-batch-review",
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
    });
    return res;
  }

  async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.request(path, init);
    if (!res.ok) throw new Error(`GitHub ${init.method ?? "GET"} ${path}: ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }

  /** Follows `Link: rel="next"` up to `maxPages`. */
  async paginate<T>(path: string, maxPages = 30): Promise<T[]> {
    const out: T[] = [];
    let next: string | null = `${path}${path.includes("?") ? "&" : "?"}per_page=100`;
    for (let page = 0; next && page < maxPages; page++) {
      const res = await this.request(next);
      if (!res.ok) throw new Error(`GitHub GET ${next}: ${res.status} ${await res.text()}`);
      out.push(...((await res.json()) as T[]));
      next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get("link") ?? "")?.[1] ?? null;
    }
    return out;
  }

  /** Raw file content at `ref`, or null when the path does not exist there. */
  async file(path: string, ref: string): Promise<string | null> {
    const res = await this.request(
      `/repos/${this.owner}/${this.repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${ref}`,
      { accept: "application/vnd.github.raw" },
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub raw ${path}@${ref}: ${res.status}`);
    return await res.text();
  }
}
