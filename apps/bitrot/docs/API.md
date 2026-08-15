# Bitrot API

All responses are JSON. Errors are `{ "error": "message" }` with a matching
status code.

Authentication is a `bitrot_session` cookie (HS256 JWT, `httpOnly`,
`sameSite=lax`, `secure` in production), set by register/login. Every
authenticated route resolves the user id server-side from that cookie; a
client-supplied user id is never read.

## Public

### `GET /api/health`

Liveness plus database connectivity.

```json
{ "ok": true, "database": "up" }
```

`503` with `{"ok": false, "database": "down", "error": "..."}` if Postgres is
unreachable.

### `GET /api/package/:ecosystem/:name`

Score a single package. **No authentication.** Rate limited to 60 requests per
minute per IP.

- `:ecosystem` — `npm` or `pypi`
- `:name` — may contain a slash for npm scopes: `/api/package/npm/@babel/core`

```jsonc
{
  "package": {
    "ecosystem": "npm",
    "name": "request",
    "latestVersion": "2.88.2",
    "license": "Apache-2.0",
    "repositoryUrl": "https://github.com/request/request",
    "maintainerCount": 4,
    "deprecated": true,
    "deprecationNote": "request has been deprecated, see ...",
    "firstPublishAt": "2011-01-22T00:36:12.640Z",
    "lastPublishAt": "2020-02-11T18:34:03.155Z",
    "releaseDates": ["..."],
    "releaseCount": 126,
    "fetchedAt": "2026-08-15T06:31:00.000Z"
  },
  "rot": {
    "score": 80,
    "grade": "F",
    "verdict": "Critical",
    "signals": [
      { "id": "staleness", "label": "Staleness", "value": 1, "weight": 30,
        "detail": "Last release was 6.5 years ago." }
    ],
    "reasons": ["Maintainers deprecated this package: ..."]
  },
  "cached": false
}
```

A signal with `"value": null` could not be evaluated and was dropped from the
weighting. A signal with `"weight": 0` is an override (see
[ROT_SCORE.md](ROT_SCORE.md#deprecation-is-an-override-not-a-term)).

| Status | Meaning |
|---|---|
| `400` | Unknown ecosystem, or an invalid package name |
| `404` | Not published on that registry |
| `429` | Rate limited — `retry-after` header set |
| `502` | The upstream registry failed or timed out |

## Authentication

### `POST /api/auth/register`

```json
{ "email": "you@example.com", "password": "at least 10 chars", "name": "optional" }
```

`200` → `{ "user": { "id", "email", "name" } }` and sets the session cookie.
`409` if the email is taken. Emails are lowercased.

### `POST /api/auth/login`

```json
{ "email": "you@example.com", "password": "..." }
```

`200` → `{ "user": {...} }` and sets the session cookie. `401` with an identical
message whether the email is unknown or the password is wrong.

### `POST /api/auth/logout`

Clears the cookie. `200` → `{ "ok": true }`.

## Scans — authentication required

### `POST /api/scans`

Parses a manifest, resolves every dependency against the live registry, scores
them, and persists the scan. Synchronous: the response returns once scoring is
complete.

```json
{ "manifest": "<file contents>", "filename": "package.json", "label": "optional" }
```

The format is detected from the content (`package.json`, `package-lock.json`,
`requirements.txt`); `filename` is only a hint. Manifests are capped at 4 MB and
200 dependencies per scan.

```json
{
  "scanId": "cmsu01udj000557kiqqofom0s",
  "kind": "package.json",
  "ecosystem": "npm",
  "dependencyCount": 9,
  "warnings": ["Skipped my-lib: \"workspace:*\" does not resolve to a registry package."]
}
```

`warnings` reports what was skipped or truncated — never silently dropped.

| Status | Meaning |
|---|---|
| `400` | Unparseable manifest, or no dependencies found |
| `401` | Not signed in |
| `413` | Manifest larger than 4 MB |

### `GET /api/scans`

The 50 most recent scans for the signed-in user.

### `GET /api/scans/:id`

One scan with its findings, ordered worst-first. Scoped by user — another
user's scan id returns `404`.

Each finding carries the package identity, the version in use versus latest,
`rotScore`/`grade`, the full `signals` array, human-readable `reasons`, and the
registry facts behind them (`lastPublishAt`, `maintainerCount`, `releaseCount`,
`deprecated`, `license`, `repositoryUrl`). A finding whose lookup failed has a
null `rotScore` and a populated `lookupError`.

### `DELETE /api/scans/:id`

`200` → `{ "ok": true }`. `404` if it is not yours.

## Acknowledgements — authentication required

Marking a package as accepted risk. Acknowledged packages keep their score and
stay visible, but are excluded from the portfolio score.

### `POST /api/acknowledgements`

```json
{ "ecosystem": "npm", "packageName": "request", "note": "optional" }
```

Idempotent — re-posting updates the note.

### `GET /api/acknowledgements`

Everything the signed-in user has acknowledged.

### `DELETE /api/acknowledgements?ecosystem=npm&packageName=request`

`200` → `{ "ok": true }`, or `404` if there was nothing to remove.
