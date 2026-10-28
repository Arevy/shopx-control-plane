# Operator configuration

Keep all configuration files outside Git with mode `0600`; directories should use `0700`. Values below describe field names, not usable credentials. No credential belongs in a public platform manifest, browser bundle or documentation.

## Database connection

Each private connection object contains `user`, `password`, `connectString` and `pdb`. The API uses `SX_CONTROL`; the worker additionally receives `SX_PROVISIONER`. Use the application PDB service for `connectString`, not the CDB root. The repository verifies the control schema/PDB identity before accessing the registry.

## API file (`CONTROL_CONFIG_FILE`)

| Field          | Meaning                                                                                                                                                   |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `database`     | Private control-schema connection                                                                                                                         |
| `origin`       | Exact console origin; the initial provider accepts loopback HTTP only                                                                                     |
| `release`      | Approved release identifier from the worker release manifest                                                                                              |
| `capacity`     | Maximum number of reserved platforms; workspace default 4                                                                                                 |
| `domain`       | Initial provider uses `localhost`                                                                                                                         |
| `gatewayPort`  | First loopback platform port, normally 9200; subsequent platforms reserve the next port                                                                   |
| `port`, `host` | Listener, normally 4100 and `0.0.0.0` inside the container                                                                                                |
| `google`       | Optional private `{clientId, clientSecret}` for Google OAuth; omitted disables Google sign-in                                                             |
| `initialShop`  | Optional operator-owned `{name, storefront, admin}` links for the preserved original store; visible to global roles, outside factory lifecycle and counts |

## Worker file (`CONTROL_WORKER_FILE`)

| Field                           | Meaning                                                                                                                           |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `database`, `provisioner`       | Separate control and schema-provisioning connections                                                                              |
| `stateDirectory`                | Absolute shared private directory for locks, generated Compose files and per-platform secrets                                     |
| `assetsDirectory`               | Absolute directory of catalog image files, named by their reviewed SHA-256 digests                                                |
| `oracleNetwork`, `probeNetwork` | Existing Docker network names; the worker and platform gateways join the probe network                                            |
| `runtimeDatabase`               | Oracle service reachable from platform backends, e.g. `oracle:1521/ORCLPDB1`                                                      |
| `release`                       | `{id, images}`; images maps `backend`, `storefront`, `admin`, `redis`, `gateway` to immutable local `sha256:` image IDs           |
| `releases`                      | Optional map of retained release IDs to immutable release manifests; required when retrying platforms built from earlier releases |
| `minimumFreeBytes`              | Minimum available disk space on the state volume before provisioning                                                              |

The worker must be started by the Compose `flock` supervisor, with `SHOPX_WORKER_LOCK_HELD=1`. Setting that flag alone does not acquire a lock. Bind mounts must preserve the absolute host paths. Protect and back up the private state directory: without its generated credentials, the worker refuses to take ownership of a pre-existing schema.

## Bootstrap file (`CONTROL_BOOTSTRAP_FILE`)

Contains the control `database` object, management `email` and a randomly generated `password` of at least 24 characters. `bootstrap` creates the two registry tables and one `GLOBAL_ADMIN` only when absent. It never resets an existing account's password. The API session cookie is opaque, HttpOnly, SameSite=Strict, and expires after eight hours; only its hash is stored.

## Public business manifest

The first version accepts only `slug`, `displayName`, `ownerEmail`, `locale`, `currency`, `priceDisplay`, `template`, optional `seedMode`, optional `experience`, and the three hex-color branding tokens `accent`, `background`, `surface`. `currency` is `EUR`, `priceDisplay` is `gross`, and `template` is `general-store-real-v1`. `seedMode` is `empty` or `demo`; omission preserves demo semantics for existing requests, while the new UI defaults explicitly to empty. No connection string, secret, container image reference or SQL identifier is accepted from the console. The only user-supplied asset URL is the validated HTTPS logo in `experience`. IDs, schemas, ports and Compose projects are generated centrally.

The configured locale supplies the initial language when a client has no saved language preference. Explicit user choices take precedence. The global console itself currently uses English copy. Branding and public experience settings are consumed by the client adapters. See [customization and Google](customization-and-google.md) for field limits, client coverage, revision recovery and OAuth configuration.

## Optional monitoring

Optional monitoring adds a private `observability` object to the API file: `token`, `lokiUrl`, `prometheusUrl`, `collectorUrl` and `grafanaUrl`. Generate it with `observability/prepare.mjs` and follow [the deployment guide](observability.md). These are operator-controlled endpoints, never public platform settings. Omitting the object disables monitoring routes without changing commerce. The worker needs no additional monitoring credentials.

## Trusted console forwarding

Set `proxyKey` in the private API file to 32 cryptographically random bytes encoded as 64 hexadecimal characters. Supply the same value as the console server environment `SHOPX_CONTROL_PROXY_KEY`; standalone Compose maps `CONTROL_PROXY_KEY` to it. Do not use `NEXT_PUBLIC_*` variables. The workspace adapter generates and retains this value privately. This key authenticates client-address metadata for throttling; it never grants a management session or bypasses role checks.
