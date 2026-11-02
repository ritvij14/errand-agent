# Deployment

> **Deployment architecture and runbook for [PROJECT NAME].**
> Everything needed to deploy, monitor, and operate this system.
> Last updated: [YYYY-MM-DD]

---

## Environments

| Environment | URL                       | Purpose                | Deploy trigger                    |
| ----------- | ------------------------- | ---------------------- | --------------------------------- |
| Local       | `http://localhost:[PORT]` | Development            | Manual                            |
| Staging     | `[URL]`                   | Pre-production testing | Push to `staging` branch / Manual |
| Production  | `[URL]`                   | Live system            | Push to `main` / Manual approval  |

---

## Infrastructure

**Hosting:** [e.g. Google Cloud Run / Railway / Vercel / EC2]
**Region:** [e.g. us-central1 / eu-west-1]
**Scaling:** [e.g. Auto-scales 0-10 instances based on request load / Fixed 2 instances]

**Services:**

- `[service name]` — [what it runs, how many instances, specs]
- `[service name]` — [what it runs]

**Managed services used:**

- [e.g. Cloud SQL — PostgreSQL database]
- [e.g. Cloud Storage — file uploads]
- [e.g. Pub/Sub — event queue]

---

## Deployment Process

### Deploying to Staging

```bash
# [Steps to deploy to staging]
[command]
[command]
```

### Deploying to Production

```bash
# [Steps to deploy to production]
[command]
[command]
```

**Pre-deploy checklist:**

- [ ] All tests passing
- [ ] Environment variables updated if needed
- [ ] Database migrations ready (if applicable)
- [ ] Feature flags configured

**Post-deploy verification:**

- [ ] Health check endpoint returns 200: `curl [URL]/health`
- [ ] [Key user flow] works end to end
- [ ] Error rate in monitoring is stable

---

## Environment Variables

> For local development values, see `.env.example`. For production, values are managed in [e.g. GCP Secret Manager / Railway dashboard / AWS SSM].

**How to update a production env var:**
[Steps specific to your platform]

---

## Health Check

**Endpoint:** `GET /health`
**Expected response:**

```json
{
  "status": "ok",
  "version": "[git SHA or version]",
  "timestamp": "ISO8601"
}
```

---

## Monitoring & Observability

**Logging:** [e.g. Cloud Logging / Datadog / stdout only]
**Metrics:** [e.g. Cloud Monitoring / Datadog / None]
**Alerts:** [e.g. PagerDuty / Email / Slack — describe what alerts exist]
**Error tracking:** [e.g. Sentry / None]

**Key things to watch:**

- [e.g. p95 response time — alert if >500ms]
- [e.g. Error rate — alert if >1% of requests]
- [e.g. Memory usage — alert if >80%]

---

## Database Operations

**Backups:** [e.g. Automated daily backups, 30-day retention]

**Running migrations:**

```bash
[migration command]
```

**Connecting to production database:**

```bash
# ⚠️ Be careful — this is production
[connection command or steps]
```

---

## Rollback Procedure

**If a deployment goes wrong:**

1. [Step 1 — e.g. Revert to previous image in Cloud Run]
2. [Step 2 — e.g. Roll back database migration if applicable]
3. [Step 3 — e.g. Verify health check passes]
4. [Step 4 — e.g. Notify team]

```bash
# Rollback command
[command]
```

---

## Common Operational Tasks

### [Task — e.g. Clearing the cache]

```bash
[command]
```

### [Task — e.g. Triggering a manual re-index]

```bash
[command]
```

### [Task — e.g. Checking logs for errors]

```bash
[command]
```

---

## Documentation Site (Optional)

> Remove this section if not applicable to this project.

The `docs/` folder in this repo can be published as a static documentation site using **Docusaurus** (prose/markdown) and/or **Swagger UI** (API contracts via OpenAPI spec).

**Per-repo:** Each repo (frontend, backend) runs its own Docusaurus instance independently. Add `docusaurus.config.js` at the repo root and a deploy workflow (`.github/workflows/deploy-docs.yml`). Backend repos can add `docs/infra/openapi.yaml` and use `docusaurus-plugin-openapi-docs` to render interactive API docs.

**Aggregated (optional):** Create a separate `[project]-docs` repo that pulls `docs/` from each service repo (via submodules or a CI script) and publishes a single unified site.

**To set up:** See the [Docusaurus docs](https://docusaurus.io/docs) and [docusaurus-plugin-openapi-docs](https://github.com/PaloAltoNetworks/docusaurus-openapi-docs) for backend API rendering.
