# Accounts, original data and platform setup

## Keep the original store intact

The original ShopX deployment still owns its existing Oracle schema, accounts, product images and transaction history. In the integration workspace that is `AREVY` in `ORCLCDB`. No migration is required to keep serving that store. The global console links to it as an **existing, preserved store**, outside factory lifecycle control. This is an operator-configured reference, not automatic adoption or a health certification.

Do not copy its customers, orders, payment rows or password hashes into a new platform. Moving the original store into managed lifecycle later requires a separate backup/restore and identity migration plan. It is not part of creating a demo, and the original Oracle container must not be removed.

## Choose the new store's initial content

The authenticated configuration form offers two explicit options:

| Option                   | Installed content                                                                                                                                                    |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Empty store (UI default) | Business tables and one new store administrator; no products, categories, CMS, customers or transactions                                                             |
| Demo store               | The reviewed 45-product tech/home/lifestyle pack, images, categories and starter CMS; one new store administrator, with no copied customers, transactions or reviews |

Both options use the same isolated schema/application architecture. Demo means populated starting content; it does not mean shared data or relaxed authorization. Prices are the catalog's dated EUR reference snapshot, not a live supplier feed. Content is real backend data, never a frontend mock fallback.

`seedMode` is `empty` or `demo` and is immutable for a provisioning intent. Omitted values retain the original demo behavior for compatibility with existing platforms and saved requests. `SHOPX_PLATFORM_CONTENT` records the selection before catalog installation. A retry cannot silently switch modes or seed an established empty store. New content can subsequently be managed through that store's ordinary administration.

## Invitation-only management accounts

1. The bootstrap global administrator signs in at `/platforms`.
2. Open **Account & access → Invite people & manage access**. Enter an email and choose the least privileged applicable role.
3. Copy the private invitation link and deliver it securely to that person. The application does not send email. Creating another invitation for the same email invalidates its previous link.
4. The recipient opens the link, supplies the same invited email, a name and a unique 15–128-character password/passphrase, then signs in.
5. A platform creator sees the complete store setup form and only the platforms they created. Their store's commerce owner is a separate account.

| Management role    | Access                                                                                        |
| ------------------ | --------------------------------------------------------------------------------------------- |
| `GLOBAL_ADMIN`     | All platforms, provisioning/recovery, invitations and account enable/disable                  |
| `PLATFORM_CREATOR` | Create platforms and read/customize/start/stop/restart/retry only their own platforms         |
| `GLOBAL_OPERATOR`  | Read and start/stop/restart all managed platforms; cannot create platforms or invite accounts |
| `GLOBAL_VIEWER`    | Read-only inventory across managed platforms                                                  |

Invitations cannot create global administrators. The bootstrap administrator is protected from UI disabling. Commerce `SUPPORT` and `CUSTOMER` roles cannot log in to management or inherit its permissions. Old platform records without a creator remain visible only to global roles; they are never assigned to the first person who signs in.

## Setup form

The form configures business name, reserved local address, separate store-owner email, empty/demo content, default locale, all three theme colors, design presets, logo, homepage content, typography, shape and section visibility with a visual preview. The supported monetary contract is shown explicitly as EUR with VAT-inclusive display. The review includes the normalized values, planned access links, content choice and deployment boundaries before submission. Editing a field invalidates the previous review.

The server independently validates every value, authorizes the actor and reserves capacity atomically. A preview does not reserve a port; a concurrent creation can change the final port. Database credentials, schema names, container image references, commands and arbitrary backend URLs are not form inputs. Custom domains, payment integrations, native distribution and other unsupported options are not presented as active settings.

## Security and recovery boundaries

Invitation tokens are random, expire after 24 hours, are stored only as hashes and are consumed atomically once. The URL uses a fragment that is removed from the address bar on page load; referrer and framing restrictions apply. Lists never return token hashes or password hashes. This follows the token-lifecycle principles in [OWASP guidance](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html).

Passwords use salted scrypt. Login failures are throttled; expensive password work is bounded. Sessions use opaque HttpOnly/SameSite cookies, and mutation origins must match exactly. Password changes require the current password, revoke other sessions and rotate the current session. Disabling an invited account revokes its sessions immediately and preserves its shops; the global administrator retains access.

The current provider remains loopback-only. These controls do not turn it into an Internet-ready hosting service. HTTPS deployment, MFA/enterprise SSO, verified email delivery, forgotten-password recovery and durable backups remain separate work. A lost invitation can be replaced before acceptance; password changes for an existing account are not an unauthenticated reset mechanism. Bootstrap reruns never reset an existing password.

## After activation

Invited users can optionally connect a matching Google account after confirming their password. Stores can publish editable settings with revision checks and reuse a design for a new business. See [customization, supported clients and Google operator setup](customization-and-google.md).
