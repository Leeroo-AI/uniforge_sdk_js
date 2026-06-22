/**
 * uniforge-explore — JS SDK for the Uniforge entity graph.
 *
 * Zero-dependency, Node 18+ (built-in fetch). Same 9 methods as the Python SDK.
 *
 *   import { Explorer } from '/app/sdk/index.mjs';
 *   const uf = new Explorer();
 *   const g = await uf.entityGraph();
 */

class ExploreError extends Error {
  constructor(message, { code = "", requestId = "" } = {}) {
    super(message);
    this.name = "ExploreError";
    this.code = code;
    this.requestId = requestId;
  }
}

class AuthError extends ExploreError {
  constructor(msg, opts) { super(msg, opts); this.name = "AuthError"; }
}
class TableNotFound extends ExploreError {
  constructor(msg, opts) { super(msg, opts); this.name = "TableNotFound"; }
}
class BadSQL extends ExploreError {
  constructor(msg, opts) { super(msg, opts); this.name = "BadSQL"; }
}
class NoSuchLink extends ExploreError {
  constructor(msg, opts) { super(msg, opts); this.name = "NoSuchLink"; }
}
class SearchFailed extends ExploreError {
  constructor(msg, opts) { super(msg, opts); this.name = "SearchFailed"; }
}
class RateLimited extends ExploreError {
  constructor(msg, opts) { super(msg, opts); this.name = "RateLimited"; }
}

const CODE_TO_ERROR = {
  TABLE_NOT_FOUND: TableNotFound,
  NO_CF: NoSuchLink,
  BAD_SQL: BadSQL,
  SEARCH_FAILED: SearchFailed,
  VALIDATION_ERROR: ExploreError,
  TOO_MANY_PKS: ExploreError,
  INTERNAL_ERROR: ExploreError,
};

function errorFromResponse(status, body, fallbackCode = "") {
  let code = fallbackCode;
  let message = "";
  let requestId = "";

  if (body && typeof body === "object") {
    const detail = body.detail ?? body;
    if (typeof detail === "object" && detail !== null) {
      const err = detail.error ?? {};
      if (typeof err === "object") {
        code = err.code || code || "";
        message = err.message || "";
      }
      requestId = detail.request_id || "";
    } else if (typeof detail === "string") {
      message = detail;
    }
  }

  if (!message) message = `HTTP ${status}`;
  const opts = { code, requestId };

  if (status === 401 || status === 403) return new AuthError(message, opts);
  if (status === 429) return new RateLimited(message, opts);

  const Cls = CODE_TO_ERROR[code] || ExploreError;
  return new Cls(message, opts);
}

export class Explorer {
  #baseUrl;
  #key;
  #prefix;
  #timeout;
  #maxRetries;
  #graphCache = null;

  constructor({ apiKey, baseUrl, timeout = 120000, maxRetries = 2 } = {}) {
    this.#baseUrl = (baseUrl || process.env.UNIFORGE_URL || "http://localhost:8000").replace(/\/+$/, "");
    this.#key = apiKey || process.env.UNIFORGE_API_KEY || "";
    if (!this.#key) {
      throw new AuthError(
        "No API key. Set UNIFORGE_API_KEY (a uf_... key) in the environment, or pass apiKey to Explorer()."
      );
    }
    this.#prefix = this.#key.startsWith("uf_") ? "/sdk/v1" : "/api/v1";
    this.#timeout = timeout;
    this.#maxRetries = maxRetries;
  }

  async #request(method, path, { params, json, fallbackCode = "" } = {}) {
    let url = `${this.#baseUrl}${this.#prefix}${path}`;
    if (params) {
      const qs = new URLSearchParams(params).toString();
      if (qs) url += `?${qs}`;
    }

    const headers = { Authorization: `Bearer ${this.#key}` };
    const uid = process.env.UNIFORGE_USER_ID;
    if (uid) headers["X-User-Id"] = uid;

    const fetchOpts = { method, headers, signal: AbortSignal.timeout(this.#timeout) };
    if (json !== undefined) {
      headers["Content-Type"] = "application/json";
      fetchOpts.body = JSON.stringify(json);
    }

    let lastErr = null;
    for (let attempt = 0; attempt <= this.#maxRetries; attempt++) {
      let resp;
      try {
        resp = await fetch(url, fetchOpts);
      } catch (e) {
        lastErr = new ExploreError(`Network error on ${path}: ${e.message}`);
        continue;
      }

      if (resp.ok) {
        const body = await resp.json();
        return body && typeof body === "object" && "data" in body ? body.data : body;
      }

      if (resp.status === 429 || resp.status >= 500) {
        const body = await resp.json().catch(() => ({ detail: resp.statusText }));
        lastErr = errorFromResponse(resp.status, body, fallbackCode);
        if (attempt < this.#maxRetries) continue;
      }

      const body = await resp.json().catch(() => ({ detail: resp.statusText }));
      throw errorFromResponse(resp.status, body, fallbackCode);
    }

    throw lastErr;
  }

  // --- orient ---

  async entityGraph() {
    const g = await this.#request("GET", "/entity-graph");
    this.#graphCache = g;
    return g;
  }

  #edges() {
    return this.#graphCache?.edges ?? [];
  }

  async #ensureGraph() {
    if (!this.#graphCache) await this.entityGraph();
  }

  async neighbors(tableId) {
    await this.#ensureGraph();
    const out = [];
    for (const e of this.#edges()) {
      const sem = e.semantics ?? {};
      let other, direction;
      if (e.src === tableId) { other = e.tgt; direction = "out"; }
      else if (e.tgt === tableId) { other = e.src; direction = "in"; }
      else continue;
      out.push({
        table_id: other,
        link_id: e.link_id ?? null,
        edge_label: sem.edge_label ?? "",
        description: sem.description ?? "",
        direction,
      });
    }
    return out;
  }

  async paths(src, tgt, { maxHops = 4 } = {}) {
    if (src === tgt) return [[]];
    await this.#ensureGraph();

    const adj = {};
    for (const e of this.#edges()) {
      const s = e.src, t = e.tgt;
      const sem = e.semantics ?? {};
      const lid = e.link_id ?? null;
      const lbl = sem.edge_label ?? "";
      if (!s || !t) continue;
      (adj[s] ??= []).push([t, { from_table: s, to_table: t, link_id: lid, edge_label: lbl, direction: "out" }]);
      (adj[t] ??= []).push([s, { from_table: t, to_table: s, link_id: lid, edge_label: lbl, direction: "in" }]);
    }

    const results = [];
    const queue = [[src, [], new Set([src])]];
    while (queue.length) {
      const [node, hops, visited] = queue.shift();
      if (hops.length >= maxHops) continue;
      for (const [nbr, hop] of (adj[node] ?? [])) {
        if (visited.has(nbr)) continue;
        const newHops = [...hops, hop];
        if (nbr === tgt) results.push(newHops);
        else queue.push([nbr, newHops, new Set([...visited, nbr])]);
      }
    }
    results.sort((a, b) => a.length - b.length);
    return results;
  }

  async tables() {
    return this.#request("GET", "/tables");
  }

  // --- drill ---

  async viewLink(linkId) {
    if (!linkId) throw new NoSuchLink("viewLink requires a linkId — read edge.link_id from entityGraph()");
    return this.#request("GET", `/cfs/${linkId}`, { fallbackCode: "NO_CF" });
  }

  // --- inspect ---

  async schema(tableId) {
    return this.#request("GET", `/tables/${tableId}/schema`, { fallbackCode: "TABLE_NOT_FOUND" });
  }

  async sample(tableId, n = 10) {
    const data = await this.#request("GET", `/tables/${tableId}/sample`, {
      params: { limit: n },
      fallbackCode: "TABLE_NOT_FOUND",
    });
    return Array.isArray(data) ? data : (data?.sample_rows ?? []);
  }

  // --- fetch ---

  async search(tableId, query, { topK = 10, mode = "hybrid", alpha, filters } = {}) {
    const payload = { table_id: tableId, query, top_k: topK, mode };
    if (alpha !== undefined) payload.alpha = alpha;
    if (filters !== undefined) payload.filters = filters;
    const data = await this.#request("POST", "/ops/search", { json: payload, fallbackCode: "SEARCH_FAILED" });
    return Array.isArray(data) ? data : (data?.rows ?? []);
  }

  async sql(query, limit = 1000) {
    const data = await this.#request("POST", "/ops/sql", { json: { sql: query, limit }, fallbackCode: "BAD_SQL" });
    const rows = Array.isArray(data) ? data : (data?.rows ?? []);
    const count = data?.count ?? rows.length;
    if (count === limit) {
      process.stderr.write(
        `⚠ sql hit limit=${limit}; result may be truncated — add aggregation or a tighter WHERE, or raise limit.\n`
      );
    }
    return rows;
  }

  // --- resolve across links (CF entity resolution) + judge (LLM verdict) ---

  // Resolve row(s) in fromTable to matching row(s) in toTable by TRAVERSING THE
  // CF LINK (runs the discovered connectivity function, not a hand-written SQL
  // join — works without a foreign key). `pks` is one pk (string) or many
  // (array). Returns resolved target row(s) with match provenance.
  async hop(fromTable, toTable, pks) {
    const payload = { from_table: fromTable, to_table: toTable };
    if (Array.isArray(pks)) payload.pks = pks; else payload.pk = pks;
    const data = await this.#request("POST", "/ops/hop", { json: payload, fallbackCode: "HOP_FAILED" });
    if (data && !Array.isArray(data)) return data.rows ?? data.results ?? [];
    return data;
  }

  // Multi-PK alias of hop() (cross-system value lookup via the CF link).
  async resolve(sourceTable, targetTable, sourcePks) {
    return this.hop(sourceTable, targetTable, Array.from(sourcePks ?? []));
  }

  // Per-row LLM verdict over a candidate set, aligned by index:
  // {is_finding, explanation, confidence}. The precision half of a detect()
  // verify pass. Batched, temp 0 server-side. Costs an LLM call per batch.
  async judge(rows, criteria, { model = "" } = {}) {
    const payload = { rows, criteria };
    if (model) payload.model = model;
    const data = await this.#request("POST", "/ops/judge", { json: payload, fallbackCode: "JUDGE_FAILED" });
    if (data && !Array.isArray(data)) return data.verdicts ?? data.rows ?? [];
    return data;
  }

  // --- snake_case aliases ---------------------------------------------------
  // The canonical verb names are snake_case (identical to the Python SDK) so an
  // agent's detect()/remedy() reads the same in either language. camelCase
  // methods above are kept as the JS-idiomatic spelling; these aliases make the
  // two SDKs name-identical. (sql/search/neighbors/schema/sample/paths/hop/
  // resolve/judge are already single-word and need no alias.)
  async entity_graph() { return this.entityGraph(); }
  async view_link(linkId) { return this.viewLink(linkId); }
}

export {
  ExploreError,
  AuthError,
  TableNotFound,
  BadSQL,
  NoSuchLink,
  SearchFailed,
  RateLimited,
};
