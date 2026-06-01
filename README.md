# uniforge-explore (JavaScript)

Read-only SDK for the Uniforge entity graph. Zero dependencies — uses Node 18+ built-in `fetch`.

## Install

```bash
npm install uniforge-explore
```

Or copy `index.mjs` directly into your project.

## Usage

```javascript
import { Explorer } from 'uniforge-explore';

const uf = new Explorer(); // reads UNIFORGE_API_KEY + UNIFORGE_URL from env

const g = await uf.entityGraph();       // all tables + links
const p = await uf.paths(src, tgt);     // find link path between tables
const link = await uf.viewLink(linkId); // link detail
const rows = await uf.sql(`SELECT ...`); // read-only SQL
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `UNIFORGE_API_KEY` | Yes | API key (starts with `uf_`) |
| `UNIFORGE_URL` | No | Base URL (default: `http://localhost:8000`) |

## Methods

| Method | Description |
|--------|-------------|
| `entityGraph()` | All tables and links (the map) |
| `paths(src, tgt, {maxHops})` | Find link path(s) between two tables |
| `neighbors(tableId)` | Tables directly linked to one table |
| `viewLink(linkId)` | Full link definition (matcher type, columns) |
| `tables()` | List all tables |
| `schema(tableId)` | Columns, types, PK, sample values |
| `sample(tableId, n)` | Preview rows |
| `search(tableId, query, opts)` | Fuzzy entity lookup (BM25 + vector) |
| `sql(query, limit)` | Read-only SELECT (table IDs auto-rewritten) |

## Errors

All errors extend `ExploreError`:

- `AuthError` — missing or invalid API key
- `TableNotFound` — unknown table ID
- `BadSQL` — invalid SQL (non-SELECT, syntax error)
- `NoSuchLink` — unknown link ID
- `SearchFailed` — search backend error
- `RateLimited` — server busy, retry later

## License

MIT
