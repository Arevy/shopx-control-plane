# Private observability

ShopX uses Grafana, Loki, Alloy and Prometheus for local operations. The optional deployment lives in this repository and can run independently of the integration workspace. Commerce does not wait for the monitoring pipeline to accept logs.

## What is collected

| Component               | Responsibility                                                                                                 | Exposure                                                            |
| ----------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| ShopX collector         | Discover authorized Docker containers, read resource usage and bounded log batches, sanitize before forwarding | Private network; the only monitoring process with the Docker socket |
| Alloy                   | Receive sanitized events and route each platform into its own Loki tenant                                      | Private network only                                                |
| Loki                    | Store and query operational logs; seven-day retention                                                          | Private network only; no public port                                |
| Prometheus              | Scrape control-plane readiness, collector metrics and pipeline health every 30 seconds                         | Private network only                                                |
| Grafana                 | Global operator dashboard, history, resources, alerts and log exploration                                      | `127.0.0.1:3201`, authenticated                                     |
| Control API and console | Authorize platform-specific status/log requests using existing accounts and roles                              | Existing authenticated console                                      |

The collector checks registry membership, Compose project ownership and service names before collecting a generated platform. The original `shopx` project, `shopx-factory` management services, monitoring services and the explicitly configured Oracle container have separate administrative scopes. Unrelated Docker projects are excluded. Newly created platforms are discovered automatically; no per-platform monitoring container is needed.

Browser traffic enters the platform gateway, which routes to the storefront, admin or backend. The backend uses the platform's Oracle schema and Redis. Readiness history comes from the existing worker's real gateway/dependency probes; a running container alone is not proof that the application is ready. Oracle is observed as shared infrastructure and through application readiness. This does not install a database exporter, request DBA privileges, or collect SQL statements.

## Start from the integration workspace

With the existing Oracle configuration, Docker Desktop and application release prerequisites already prepared, run from the workspace root:

```sh
node scripts/observability.mjs prepare
node scripts/factory.mjs build
node scripts/factory.mjs up
node scripts/observability.mjs pull
node scripts/observability.mjs up
node scripts/observability.mjs check
node scripts/observability.mjs status
```

`prepare` creates or reuses private credentials, generates configuration and creates the owned internal `shopx-observability` network. `factory up` reads the generated API settings and attaches only the management API to that additional network. `observability up` starts the five monitoring services through the root Compose profile without starting the original commerce development stack. A repeated `prepare` preserves credentials.

Open `http://localhost:3200/platforms`, then **Service health & logs**, or use a platform card's **Status & logs** link. Select a platform, service and time window. The visible panel refreshes every 30 seconds; **Refresh** also works immediately. Log results contain at most 200 recent entries, with a maximum 24-hour query window. Older seven-day data can be explored by the global operator in Grafana.

Open `http://localhost:3201/d/shopx-overview` for Grafana. The operator username is `shopx-operator`; the generated password is the `grafanaPassword` field in `.local/observability/credentials.private.json`. Read it privately in your editor/password manager. Do not paste the file into tickets or commit it. Grafana's initial password setting applies when its database is first created; changing that file alone does not rotate an existing Grafana account.

```sh
node scripts/observability.mjs stop
node scripts/observability.mjs up
```

Stopping monitoring preserves its named volumes and leaves shops and Oracle running. Do not use `down -v`. The root profile is optional; ordinary application startup does not require Grafana or Loki.

Existing platform images do not change automatically when a new release is built. Deploy the reviewed structured-logging release through the operator rollout procedure before expecting rich logs from an older platform. The integration workspace's explicit `scripts/security-rollout.mjs plan|apply` procedure preserves commerce fingerprints, pinned rollback images and the actual stopped/running state. A gateway must be recreated after replacing an atomically written bind-mounted configuration; a simple restart can retain the previous mounted file. This is not permission to run an unreviewed release rollout.

## Run from this repository alone

First configure the ordinary standalone control plane as described in the README. Build `shopx-control-plane:local`, then:

```sh
node observability/prepare.mjs
docker network create --internal --label shopx.observability=true shopx-observability
```

Create the network only if it does not exist; if it exists, verify that it is internal and owned by this deployment. The default private directory is `.local/observability` inside this repository. Set `ORACLE_CONTAINER` and `CONTROL_API_ORIGIN` before `prepare.mjs` when the Oracle container name or API service address differs from `oracle19` and `http://api:4100`.

In the private API configuration referenced by `CONTROL_API_CONFIG`, add an `observability` property whose value is the complete generated `.local/observability/api.private.json` object. Preserve all existing account/database/release settings. Never copy that object into a versioned example. Then run:

```sh
docker compose -f compose.yaml -f observability/control.override.yaml up -d api worker console
docker compose -p shopx-observability -f observability/compose.yaml --profile observability pull obs-loki obs-alloy obs-prometheus obs-grafana
docker compose -p shopx-observability -f observability/compose.yaml --profile observability up -d
```

Keep the monitoring project name `shopx-observability` so the collector recognizes its own services. `SHOPX_OBSERVABILITY_DIRECTORY` can point to an alternative absolute private directory. `SHOPX_DOCKER_SOCKET` selects a different local Docker socket when required. This deployment supports one trusted Docker host and one control registry, not an unrestricted multi-host cluster.

## Access and privacy boundaries

- Platform creators can read only platforms they own. Global administrators can also read the control plane, original shop and shared infrastructure. Disabling an account or revoking its session also removes log access.
- The console BFF accepts only fixed routes and bounded `service`/`minutes` filters. The API constructs LogQL/PromQL and the Loki tenant header server-side. Browser-supplied tenant headers, query languages and upstream URLs are not forwarded. Unauthorized foreign platforms return 404.
- Internal metrics, inventory and the Grafana query adapter require a private bearer token. The API applies per-account request limits, a concurrent-request limit, timeouts and response-size checks.
- **Grafana is for trusted global operators only.** Its metrics and logs datasources intentionally span all platforms. Dashboard filters and Grafana Viewer roles do not establish tenant isolation. Do not invite shop owners into this Grafana organization; they use the authorized console instead.
- Only operational fields reach central storage. Headers, bodies, arbitrary error objects, SQL payloads and account fields are excluded. Known credential patterns, email addresses, URL queries and long identifiers are redacted. Nginx access logs omit IPs, URLs, arguments and cookies. New application events must use fixed operational messages; pattern redaction cannot identify every possible secret embedded in arbitrary prose.
- Unstructured legacy messages are withheld and replaced with a marker and, when recognizable, a safe error code. Historical raw Docker logs are not rewritten. Docker administrators may still read those originals. The collector does not collect its own output recursively; its health and errors are metrics.
- The collector's socket mount is `:ro`, but that does **not** make the Docker API read-only. The process is trusted host-level infrastructure. Its implementation exposes no Docker forwarding endpoint and performs only fixed GET requests for container listing, logs and stats. It does not fetch container environment variables or accept exec/control commands from HTTP clients.
- Logs are operational diagnostics, not a tamper-proof security audit. Existing Oracle audit events remain separate. Private Docker networking does not provide encryption at rest. Public or multi-host deployment requires TLS, controlled secret rotation, restricted operator access and a reviewed backup/storage policy.

## Status, resource bounds and alerts

The console distinguishes `UP`, `DEGRADED`, `DOWN`, `STOPPED` and `UNKNOWN`. A stale worker/collector observation becomes unknown after 90 seconds. A registry entry marked ready cannot mask a missing or stopped application container. `STOPPED` requires stopped intent; services stopped directly in Docker while intent remains running correctly appear down and can raise an alert.

Memory caps total **1,600 MiB**: Loki 512, Alloy 256, Prometheus 256, Grafana 384 and collector 192. These are limits, not reservations or a throughput guarantee. CPU caps and Docker log rotation are also configured. Prometheus keeps seven days or approximately 1 GB of samples, whichever retention bound applies first. Loki's seven-day compaction is enabled, but time retention is **not a hard disk quota**. Monitor disk usage and provision a separate bounded storage policy before increasing traffic.

The collector polls every 15 seconds, reads at most 1,000 recent lines/1 MiB per container per cycle, and limits the container-list response. A first observation starts with the last minute. Timestamp positions survive restarts and are saved after Alloy accepts the batch. Delivery is best effort: rotation, saturation, identical timestamps, process failure or downstream outages can cause gaps/duplicates. There is no durable end-to-end acknowledgment from Loki and no guaranteed audit delivery. Collection failure does not fail a commerce request.

Six Prometheus rules cover unavailable desired-running platforms, stale worker observations, failed scrape targets, delayed collection, collection errors and less than 5 GiB free on the collector's Docker filesystem. The Grafana dashboard displays active alerts. No Slack, email, paging destination or external message delivery is configured. Adding notifications requires selecting a destination and securely supplying its credentials; this phase sends no external messages.

## Diagnosis and verification

If the console reports monitoring unavailable, check `observability.mjs status`, API network/configuration, collector health and the four Prometheus scrape targets. An old collection-error alert can remain active briefly after recovery because it evaluates a rolling window. If disk is low, inspect Docker usage before any cleanup; never prune Oracle/application volumes to clear an alert.

The pinned local baseline is Grafana 13.3.0, Loki 3.7.9, Alloy 1.21.2 and Prometheus 3.15.1, reviewed on October 27, 2026. Version upgrades should repeat upstream configuration validation, authenticated datasource queries, tenant-isolation tests and browser checks. Configuration references: [Alloy log receiver](https://grafana.com/docs/alloy/latest/reference/components/loki/loki.source.api/), [Alloy processing](https://grafana.com/docs/alloy/latest/reference/components/loki/loki.process/), [Loki tenancy](https://grafana.com/docs/loki/latest/operations/multi-tenancy/).

`npm test` covers authorization, cross-platform isolation, forged filters/headers, stale status, upstream outages, privacy filtering and container ownership. The admin repository tests its BFF boundary. Workspace verification separately exercises real Grafana queries, Docker-to-Loki delivery and responsive console rendering. Passing source tests alone does not prove live ingestion.

This phase covers deployed server/container services. Browser JavaScript errors, iOS/Android device logs, Electron renderer errors, distributed traces/Tempo and remote uptime probes are not collected. RN web/Metro container output is visible when the original development stack is running. Client telemetry needs a separate consent, authentication, redaction and sampling design.
