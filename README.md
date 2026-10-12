# ShopX Control Plane

Local platform factory for independent ShopX businesses. This repository owns the management API, durable Oracle registry, provisioning worker and trusted Compose provider. It does not import sibling repositories. Compatible commerce, storefront and admin **release images** are deployment inputs.

This first provider is intentionally limited to one trusted local Docker host and an existing Oracle 19c application PDB. It is not a public hosting service. The global console is a separate deployment of `admin-portal` in control mode; ordinary store `SUPPORT` accounts cannot manage the factory.

## Implemented scope

- Preview and create a platform through the global console, then start, stop, restart or retry a failed operation.
- Separate Oracle schema, Redis volume, backend, storefront, store admin, gateway, JWT secret and owner credentials per platform.
- Explicit empty-store or demo-store provisioning. Demo uses a content-only starter with 45 reviewed products and images. Existing customer, order, review and account data are never copied.
- Invitation-only management signup, scoped platform creators, account disabling, password changes and session revocation. The configuration form includes identity, owner, language, content and all theme colors before review.
- Oracle-backed desired state and operations, caller-scoped idempotency, reserved slugs/ports, role checks, origin checks, expiring sessions and append-only audit events.
- Checksummed empty-schema installation, resumable DDL checkpoints and repeated-install protection. No reset/drop operation is exposed.
- Gateway probes verify platform identity/config revision, catalog access and an actual product image. Unobserved health expires to `unknown` after 90 seconds.
- Immutable image IDs, retained image tags and release manifests. Rebuilding the factory does not upgrade an existing platform silently.

Native/Electron application signing, store publication, RN web hosting, editing an already-created platform's configuration, customer-domain/TLS automation, backup/restore jobs, legacy-platform adoption, MFA/SSO, upgrades and fine-grained commerce roles are **not implemented** in this milestone. Running applications do not depend on the control API to serve requests. Public configuration is stored in each business schema. See [onboarding, data ownership and access](docs/onboarding.md) for the implemented signup and setup flow.

## Technology and patterns

Node 22, TypeScript, Express 4 and node-oracledb 6. Management uses a small REST API; commerce remains GraphQL. The console keeps React, Next.js, MobX and SCSS. Mobile adapters retain Redux and React Native Paper.

`domain.ts` contains validation and state transitions. `OracleStore` is the repository/transaction boundary; `ComposeProvider` is the infrastructure adapter; the worker is the operation orchestrator. There is no Docker socket or provisioning credential in the API container.

The first registry uses a versioned JSON aggregate in `SX_REGISTRY`, locked with `SELECT ... FOR UPDATE`, plus an append-only `SX_AUDIT` table. Reserving a platform and its operation is one Oracle transaction. No network/Docker work runs while the registry row is locked. This deliberately favors correctness at a small single-host scale; it is not a horizontally scalable job queue. Separate relational job/manifest tables are a later migration, not a requirement imposed on commerce tables.

## Run independently

```sh
npm ci
npm test
docker build -t shopx-control-plane:local .
```

Provision ordinary local Oracle users `SX_CONTROL` and `SX_PROVISIONER` in an application PDB. The control user needs `CREATE SESSION`, `CREATE TABLE`, `CREATE SEQUENCE` and a bounded tablespace quota. The worker's provisioning user needs `CREATE USER` and the three creation privileges with `ADMIN OPTION`; it does not need `SYSDBA`, `DROP USER`, `ALTER USER` or access to existing commerce rows. Supply reviewed credentials through mode-0600 JSON files, outside Git. See [configuration](docs/configuration.md).

1. Prepare private API, worker and one-time bootstrap files. Make the worker state directory and catalog assets available at **the same absolute paths on the Docker host and worker**, because Docker resolves bind mounts on the host.
2. Provide an external Oracle network and a separate probe network. Build compatible application images outside this repository and record their exact `sha256:` image IDs in the operator-controlled release manifest.
3. Set the paths in `.env` from `.env.example`, then run `docker compose --profile setup run --rm bootstrap`.
4. Run `docker compose up -d api worker console`. Open `http://localhost:3200/platforms` and use the private bootstrap account.

In the ShopX integration workspace, the root adapter performs these steps against the existing Oracle container:

```sh
node scripts/factory.mjs build
node scripts/factory.mjs up
node scripts/factory.mjs status
```

Those commands run from the integration workspace, not from this standalone repository. They leave the original ShopX stack and `AREVY` schema in place. Build logs may show that the storefront cannot query an API during static generation; runtime API reachability must still be verified after deployment.

## Operations and recovery

The default local capacity is four registered platforms, including stopped or failed platforms. This is a reservation limit, not a promise of sufficient RAM. Before creation the worker also checks free Docker memory and disk. One platform uses capped production services (backend 256 MiB, storefront 320 MiB, admin 256 MiB, Redis 96 MiB, gateway 32 MiB), not additional development servers. Keep headroom for Oracle and the existing stack.

The worker runs under Linux `flock` on its shared state directory. A second worker cannot mutate the host concurrently. Process death releases the lock; `running` operations are reconciled before queued operations. A failed operation is retained with its last step and safe error code; retry replays the **same intent**, using the same schema, credentials, release and resource ownership checks. It does not delete partial resources.

Only a global administrator can select **Use current release and retry**, and only for a failed platform that has never completed provisioning. This explicitly records a new operation against the operator-approved current release while preserving the schema, credentials and data. Established platforms cannot use this recovery action as an upgrade shortcut. Keep all pinned release images available; release manifests alone do not prevent Docker image pruning. The workspace build command retains release-specific image tags before replacing its development tags.

Stopping services preserves the schema and Redis volume. There is no delete/archive/purge button. If a process died between Oracle user creation and its first session grant, ownership cannot be proven by login; the worker fails with `SCHEMA_OWNERSHIP_UNPROVEN`. An operator must inspect that generated schema and grant access explicitly after proving ownership. Never reset a password to bypass this check.

Initial owner credentials are written to the platform's private `setup.json` and remain local to the operator. Deliver them securely and change the password using the store account flow. An activation-email/password-reset onboarding service is still required before using this with external customers.

Back up the private bootstrap and platform state files securely alongside the database. If the bootstrap file is missing but either management Oracle user already exists, the workspace adapter refuses initialization before generating credentials or granting privileges. Restore the original file; do not reset or adopt existing accounts implicitly.

Probe traffic runs over the dedicated probe network, through each platform's real Nginx virtual hosts. This verifies routing inside Docker. A browser/host smoke test must additionally verify the published loopback ports and local DNS. A platform marked ready does not certify payment processing or native app distribution.

The current loopback-only provider deliberately enables insecure commerce cookies for local HTTP. Do not expose these ports publicly. Production requires HTTPS, secure cookies, MFA/SSO, secret rotation, a backed-up Oracle volume and a tested restore procedure. Docker socket access makes the worker a trusted host administrator; do not accept user-supplied commands, images, SQL or Compose files.

## Verification

`npm test` covers domain state transitions, duplicate requests, capacity/port reservations, roles, CSRF, session revocation, invitation expiry/replacement/reuse, scoped ownership, password rotation, disabled accounts, login throttling and stale health. These tests do not provision Docker or Oracle. Integration evidence and limitations belong in the workspace verification record. Do not replace Oracle 19.3-compatible create/check logic with `CREATE USER IF NOT EXISTS`; that syntax only appears in later 19c releases. See the [Oracle CREATE USER reference](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/CREATE-USER.html).
