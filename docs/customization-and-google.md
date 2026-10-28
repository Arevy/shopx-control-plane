# Store customization and management sign-in

## Start from the original platform

The original store remains a separate application and database identity. The factory reuses the independently built commerce, storefront and admin applications as pinned release images. It creates a new Oracle schema and dedicated services for each business. It does not clone the original store's database.

From `/platforms`, an authenticated global administrator or platform creator can:

1. Choose an empty store or the reviewed demo content pack.
2. Select Graphite, Ocean, Editorial or Orchid as a starting palette, then edit its colors.
3. Set business identity, language, logo, editorial copy and appearance.
4. Review the normalized configuration and create the store.
5. Use **Customize store** to publish subsequent settings, or **Use design for a new store** to copy a design into a new creation form. The new store still requires its own address and owner; customers, accounts and orders are never copied.

The management account and the store's commerce administrator are separate identities. Global roles can see the original store's operator-configured links; those links do not bring it under factory lifecycle control.

## Public configuration contract

`manifest.experience` is optional for backwards compatibility. When supplied, it accepts only these fields:

| Fields                                             | Constraint / default                                                                       |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `logoUrl`                                          | HTTPS URL, at most 1,000 characters; no embedded credentials or fragment; blank by default |
| `tagline`, `heroTitle`                             | Plain text, at most 100 / 140 characters; blank uses translated client copy                |
| `heroDescription`, `footerText`                    | Plain text, at most 500 / 300 characters; line breaks allowed                              |
| `announcement`                                     | Plain text, at most 180 characters; blank hides the announcement                           |
| `supportEmail`                                     | Public contact email, at most 254 characters; blank hides the link                         |
| `showFeatured`, `showNewArrivals`, `showEditorial` | Booleans, default `true`                                                                   |
| `cornerStyle`                                      | `sharp`, `rounded` (default), or `pill` (soft corners)                                     |
| `fontFamily`                                       | `sans` (default), `serif`, or `mono`; local/system fonts only                              |
| `catalogDensity`                                   | `comfortable` (default) or `compact`                                                       |

Unknown fields, executable HTML/CSS, control characters and invalid values are rejected by the API and clients. Logos load directly in the user's client; the backend does not fetch arbitrary URLs. Supply a stable public HTTPS asset whose use you control. Broken logos do not replace the visible business name. Copy is one business-authored text per field, not an automatic translation service.

| Consumer                               | Applied settings                                                                                                                                               |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Next.js storefront                     | Name, logo, palette, font, shape, catalog grid density, hero, announcement, footer/contact and the three homepage section switches                             |
| Store administration                   | Name, logo, tagline, palette and global font/shape tokens; commerce screens retain their task-specific layouts                                                 |
| RN native, RN web and Electron adapter | Name/logo, hero/tagline/announcement, Paper/navigation palette and text contrast, system font and card shape; compact mode adds a column on wide home catalogs |

The RN home screen is a single catalog, so storefront-specific featured/new-arrival/editorial switches and footer copy do not create or hide native sections. An explicit RN light-mode preference retains the app's light palette; its default dark mode uses the managed brand palette, including light brand presets. Choose coherent background/surface/accent colors and inspect the preview and actual screens.

Clients refresh public settings on focus and approximately every 30 seconds while active. A new default locale applies when there is no stored user language preference; it does not overwrite explicit choices. Config changes do not rebuild or republish native binaries. Those binaries must already point at the matching platform ID and backend.

## Publishing and recovery

`POST /v1/platforms/:id/configuration` accepts `expectedRevision`, `displayName`, `locale`, `branding` and optional `experience`. It requires the same-origin management session, an idempotency key, and either global-administrator access or ownership as a platform creator.

Address, schema, owner, release, initial content mode and currency are immutable through this operation. Concurrent edits return `CONFIGURATION_REVISION_CONFLICT`; reopen the editor to load current settings. A queued operation preserves the old manifest until the worker has applied the new revision to the business schema. The existing installer updates configuration only; it does not run the demo seed again.

A configuration operation that failed before its exact target was committed must be retried before another configuration or lifecycle change. If the target revision is already committed and only readiness failed, start/stop/restart and corrective edits remain available. Retry carries the exact target revision and manifest, including after a crash between business-schema and registry updates. A stopped store stays stopped. For running intent, publication reconciles application startup before readiness checks, including on retry. Readiness checks include the published revision when the store is running.

Records created by the new compatible factory release advertise `configurationVersion: 2`. Older pinned platforms can edit name, locale and colors. They cannot accept expanded experience fields until an explicit application upgrade mechanism exists. Building images does not upgrade those platforms, and the UI explains this limitation.

## Optional Google authentication

Email/password remains available. Google is an additional sign-in method for **existing, activated, invited management users**. It is not public registration, store-customer login, MFA, or an automatic email-to-account linking mechanism.

Operator setup:

1. Create a Google OAuth **Web application** client and configure its consent screen. For a testing project, add the intended Google accounts as test users.
2. Register this exact local redirect URI: `http://localhost:3200/api/control/auth/google/callback`. Using `127.0.0.1` instead of `localhost`, or changing the port, is a different origin.
3. In a standalone deployment, add `google: {clientId, clientSecret}` to the private `CONTROL_CONFIG_FILE`. Never put the secret into a public environment variable or browser bundle.
4. In the integration workspace, create `.local/factory/google.private.json` with those two keys and mode `0600`, then run `node scripts/factory.mjs up`. `CONTROL_GOOGLE_CONFIG_FILE` can select another private file. The root adapter copies only those fields into the private API configuration.
5. Sign in with the management password. Under **Account & access → Sign-in methods**, confirm the current password and choose **Connect matching Google account**. Google must return the same verified email as the invited account.
6. Future sign-ins can use **Continue with Google**. Disconnecting Google requires the password and revokes other management sessions; password sign-in remains available.

No credential is shipped in the repository. Without operator configuration, the Google login button is hidden and the account panel explains why. Tests use an injected identity provider; they do not prove that an operator's Google consent screen, client credentials or live account login work.

The server uses the official `google-auth-library`, authorization code exchange, PKCE S256, a browser-bound one-use state and an ID-token nonce. The library verifies the token signature, issuer, audience and expiry; application checks also require verified email and the expected nonce. Pending flows expire after five minutes. Linking rechecks the account, password and original session after the provider response. Disabled users, revoked sessions, mismatched identities and reused callbacks fail closed. Access/refresh tokens are not retained.

The temporary Google flow cookie is HttpOnly/SameSite=Lax to support the provider's top-level callback; the management session remains HttpOnly/SameSite=Strict. Both are Secure when configured for HTTPS. The current Compose provider still restricts deployment to local loopback HTTP; Google support does not remove that deployment boundary.

References: [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect), [OAuth for web servers](https://developers.google.com/identity/protocols/oauth2/web-server).
