# UpstreamOps

[English](README.md) | [简体中文](README.zh.md)

> UpstreamOps is a centralized monitoring and operations dashboard for NewAPI and Sub2API upstream sites. It helps manage upstream accounts, balances, spending, model or group rates, rate changes, upstream API keys, recharge and redeem workflows, announcements, and Telegram / WeCom notification alerts.

> This project is based on [worryzyy/upstream-hub](https://github.com/worryzyy/upstream-hub). Thanks to [@worryzyy](https://github.com/worryzyy) for the original open-source work.

> This repository is a fork of [bejix/upstream-ops](https://github.com/bejix/upstream-ops) with the request gateway, Sub2API subscription management, global proxy, and MySQL support removed. Notification channels are limited to Telegram and WeCom, and the only captcha provider is YesCaptcha.

## Sponsor

<details open>
<summary>Click to expand</summary>

<table>
<tr>
<td width="180"><a href="https://cmzi.com/aff/CHTVTQWE"><img src="https://zhenxiansheng-1251032746.file.myqcloud.com/Markdown/2020/12/29/zi-yuan-32.png" alt="cmzi.com" width="150"></a></td>
<td>Thanks to 触摸云 for sponsoring this project. 触摸云 provides overseas cloud computing services, including Hong Kong cloud servers, US high-defense servers, physical servers, protection services, acceleration CDN, and self-developed CDN systems. UpstreamOps users can use <a href="https://cmzi.com/aff/CHTVTQWE">this link</a>.</td>
</tr>
</table>

</details>

## Why Use UpstreamOps

When you maintain multiple NewAPI or Sub2API upstream accounts, balance, spending, rates, announcements, API keys, and recharge entry points are usually scattered across different admin panels. Manually logging in one by one is repetitive and can easily miss low balances, rate changes, login failures, or upstream announcements.

UpstreamOps focuses on these problems:

- Centralized status view: balances, spending, rates, announcements, and abnormal states across multiple upstreams.
- Less manual checking: scheduled balance, spending, and rate synchronization.
- Faster risk detection: low balances, rate changes, login failures, and monitor failures can be pushed through notifications.
- Historical tracking: rate changes, balance snapshots, notification logs, and upstream announcements are stored locally.
- Easier operations: API key management, recharge, and redeem are available from one entry point.

## Preview

![UpstreamOps preview 1](docs/images/demo1.png)

![UpstreamOps preview 2](docs/images/demo2.png)

![UpstreamOps preview 3](docs/images/demo3.png)

![UpstreamOps preview 4](docs/images/demo4.png)

![UpstreamOps preview 5](docs/images/demo5.png)

![UpstreamOps preview 6](docs/images/demo6.png)

![UpstreamOps preview 7](docs/images/demo7.png)

## Features

### Upstream Channel Management

- Supports NewAPI and Sub2API upstreams.
- Supports username/password credentials and token/cookie credentials.
- Enables or disables monitoring per channel.
- Supports custom channel sort order; higher values are displayed and monitored first.
- Configures low-balance alert thresholds.
- Tests login and manually syncs balances and rates.
- Supports extra login form parameters for modified NewAPI or Sub2API login endpoints.
- Supports Cloudflare Turnstile solving for upstream login flows.
- Opens upstream site URLs directly from channel cards.
- Supports clearing saved login information from channel cards.
- Searches channels by name, username, site URL, notes, or tags; filters by status (healthy / low balance / login failed / not yet synced / paused) or tag; sorts by name, username (Chinese by pinyin), health, or balance.
- Supports custom tags and notes per channel; tags can be used directly as filters.
- Channel cards show the login username; the channel list remembers the per-page size in the browser across reloads.
- Supports a "only show groups with created keys" toggle: when enabled, channel cards, group dialogs, rate panels, and rate-change notifications only cover groups that already have API keys; notification settings still see all groups, and local rate snapshots always keep the full set.
- Deleting a channel cleans related snapshots, rates, announcements, notification cooldowns, and notification logs.

### Balance and Spending Monitoring

- Shows total balance, today spending, total spending, lowest-balance channel, and abnormal channel count.
- Today spending rolls over at midnight Beijing time: if a channel has no spending sample for the current day (for example, monitoring is paused), its today spending shows 0.
- Periodically collects balance and spending data.
- Displays balance history trends.
- Pushes notifications when balance falls below the configured threshold.
- Supports cooldown for repeated low-balance alerts.
- Supports recharge multiplier conversion for balance, spending, and redeem values, using either the upstream multiplier or a manual divide/multiply mode.

### Rate Monitoring

- Syncs upstream model or group rates.
- Stores current rate snapshots.
- Records rate change history.
- Supports paginated rate change history and channel filters.
- Sends rate change notifications.
- Merges multiple rate changes from the same scan into one notification.
- Merges added and removed groups in the same scan into one structure-change notification.
- Filters small rate changes by minimum percentage.
- Supports notification subscriptions filtered by upstream channel and rate group.
- Provides a full channel group overview with search and sorting by channel or rate.

### Captcha Provider Balance Management

- Supports YesCaptcha.
- Queries captcha provider account balances.
- Refreshes one provider balance manually.
- Refreshes all provider balances in batch.
- Shows balance value, balance unit, refresh time, and error message.

### Upstream HTTP Settings

- Configures upstream request timeout and `User-Agent`.

### Upstream Announcements

- Syncs NewAPI announcements from `/api/status` and `/api/notice`.
- Syncs Sub2API user-visible announcements from `/api/v1/announcements`.
- Announcement sync runs with rate sync and does not require a separate cron task.
- The first sync only creates a baseline and does not push historical announcements.
- New announcements are stored locally and pushed through notification channels.
- Shows recent announcements on the dashboard.
- Supports paginated announcement queries and detail views.
- Renders announcement details as Markdown.
- Cleans up related announcements when an upstream channel is deleted.
- Supports retention-based announcement cleanup.
- Supports channel-level `ignore_announcements`.

### Notification Channels

Supported notification channels:

- Telegram
- WeCom

Notification channels support subscription filters:

- Empty or `[]`: receive all events.
- `mode=all`: receive all events from selected upstreams.
- `mode=groups`: receive only selected rate groups for rate-related events. Announcement, balance, login failure, and monitor failure events are still filtered by upstream channel.

### Upstream API Key Management

From each channel card, you can manage upstream API keys:

- List API keys.
- Search by name or key.
- Filter by status.
- Create API keys.
- Edit name, group, status, quota, expiration time, IP allowlist or blocklist, model restrictions, and related fields.
- Delete API keys.
- Reveal and copy full keys.
- From the group overview, create an API key directly in a selected group or move one existing key from the same channel into that group.
- Before moving a key, the target group is revalidated and a source-to-target confirmation is shown. Keys already in the target group remain visible but cannot be selected again.

Available fields depend on the upstream type and its API capability.

### Recharge and Redeem

From each channel card, you can handle upstream recharge and redeem workflows:

- Query upstream recharge configuration.
- Supports upstream-provided payment methods such as Alipay and WeChat Pay.
- Supports QR code, redirect URL, and form-submit payment launch modes.
- Prefers QR code on desktop and redirect on mobile.
- Redeems redeem codes online.
- Shows returned balance, concurrency, group subscription, validity period, and related results.

### System Settings

The system settings page manages:

- Admin login authentication.
- Admin username and password.
- Token signing secret.
- Balance sync cron.
- Rate sync cron.
- Scheduler concurrency.
- Monitor log, balance snapshot, notification log, and announcement retention.
- Rate change notification merge policy.
- Minimum rate change percentage for notifications.
- Low-balance alert cooldown.
- Maximum notification retry attempts.
- Version check result notification.
- Upstream request timeout and `User-Agent`.
- Notification channels.
- Captcha providers.

Saving writes the configuration file. Applying settings hot-reloads authentication, scheduler, notification policy, and upstream HTTP settings. Notification channels and captcha providers take effect immediately after database writes.

## Quick Start

### Docker Compose

UpstreamOps uses a single-file SQLite database.

```bash
cp .env.example .env
```

Edit `.env` and set at least:

```env
APP_SECRET=replace-with-a-random-string-at-least-32-bytes
```

`APP_SECRET` is used to encrypt sensitive fields with AES-GCM, including upstream passwords, tokens, cookies, notification channel secrets, and captcha provider API keys. If you change it later, existing encrypted data cannot be decrypted.

For public access, enable admin login:

```env
AUTH_ENABLED=true
ADMIN_USERNAME=admin
ADMIN_PASSWORD=replace-with-a-strong-password
```

Docker pulls `ghcr.io/yreidev/upstream-ops:${IMAGE_TAG:-latest}` by default. Configuration and data are stored in the host `data/` directory.

Start:

```bash
docker compose up -d
```

Default URL:

```text
http://localhost:8080
```

Default database file inside the container:

```text
/app/data/upstream-ops.db
```

The host file is `data/upstream-ops.db`. Runtime system settings are persisted to `data/config.yaml`.

### Pin the Image Version

The default image tag comes from `.env`:

```env
IMAGE_TAG=latest
```

For production, pin a specific version:

```env
IMAGE_TAG=v0.1.0
```

## Environment Variables

### Basic

```env
HTTP_PORT=8080
IMAGE_TAG=latest
SERVER_MODE=release
LOG_LEVEL=info
```

- `HTTP_PORT`: host port.
- `IMAGE_TAG`: Docker image tag.
- `SERVER_MODE`: Gin mode, usually `release`.
- `LOG_LEVEL`: log level.

### Database

Only SQLite is supported:

```env
DATABASE_PATH=/app/data/upstream-ops.db
```

### Security and Login

```env
APP_SECRET=please-change-me-to-a-long-random-secret-32bytes-min
AUTH_ENABLED=false
ADMIN_USERNAME=admin
ADMIN_PASSWORD=
AUTH_TOKEN_SECRET=
```

- `APP_SECRET`: required master secret.
- `AUTH_ENABLED`: enables admin login.
- `ADMIN_USERNAME`: admin username.
- `ADMIN_PASSWORD`: admin password.
- `AUTH_TOKEN_SECRET`: token signing secret. Falls back to `APP_SECRET` when empty.

## Local Development

Backend:

```bash
go run ./cmd/server
```

Default backend port:

```text
8418
```

Frontend:

```bash
cd frontend
pnpm install
pnpm dev
```

Default frontend development URL:

```text
http://127.0.0.1:3010
```

Checks:

```bash
go test ./...
```

```bash
cd frontend
pnpm lint
pnpm exec tsc --noEmit --incremental false
pnpm build
```

## Upstream HTTP Settings

System settings can configure upstream request settings. Upstream timeout defaults to `30` seconds, and `User-Agent` defaults to `upstream-ops/0.1`.

Configuration fields:

```yaml
upstream:
  timeoutSeconds: 30
  userAgent: upstream-ops/0.1
```

- `upstream.timeoutSeconds`: upstream request timeout.
- `upstream.userAgent`: upstream request `User-Agent`.

## Upstream Channel Configuration

### NewAPI

NewAPI supports two credential modes.

Username/password mode:

- Provide upstream site URL, username, and password.
- If the login endpoint requires extra fields, provide a JSON object in extra form parameters.
- If Turnstile is enabled, configure a captcha provider first, then enable Turnstile in the channel.

Newer NewAPI builds (QuantumNous/new-api and forks) issue short-lived `access_token` Bearer JWTs (default 15 minutes) at login and return a `new_api_refresh` refresh token. UpstreamOps automatically calls `/api/user/auth/refresh` to renew the access token and rotate the refresh token before it expires, so frequent re-login is not needed. Older NewAPI builds still authenticate via `Set-Cookie: session=...` plus the `New-Api-User` header; the connector auto-detects and supports both.

Login and refresh requests send `Origin` / `Referer` derived from the site URL. Only an explicit 401 (refresh token invalid) falls back to password login; other failures such as 403, 409, 429, 5xx, or network errors keep the stored session and record the error, so repeated logins cannot exhaust the upstream session limit. Session refresh and login are serialized per channel.

Token/cookie mode:

```json
{
  "cookie": "session=xxx; other=yyy",
  "user_id": "123"
}
```

NewAPI token mode also supports the system access token (`user.access_token`, the 32 character token generated from the personal settings page). Use `access_token` instead of `cookie`. Cookie and access token are mutually exclusive, but `user_id` is always required:

```json
{
  "access_token": "your-system-access-token",
  "user_id": "123"
}
```

When editing a NewAPI token/cookie channel, the form shows the saved `user_id` for reuse, while the saved cookie or access token remains hidden.

### Sub2API

Sub2API supports username/password mode and token mode.

Token mode credentials:

```json
{
  "access_token": "your-access-token",
  "refresh_token": "your-refresh-token"
}
```

`refresh_token` is optional but recommended. When present, Sub2API sessions and token-mode credentials can be refreshed automatically after access-token expiration. Without `refresh_token`, paste updated credentials when the token expires.

### Clear Login Information

The channel card menu provides a clear-login action:

- Password mode: clears only cached login sessions.
- Token mode: clears cached sessions and the saved token/cookie credential JSON.

## Notification Channel Configuration

Bot tokens and webhook URLs are encrypted at rest. Add or edit a notification channel with the JSON configuration matching its type.

### Telegram

```json
{
  "bot_token": "1234567890:AAEh...",
  "chat_id": "-1001234567890"
}
```

### WeCom

```json
{
  "webhook_url": "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxxx"
}
```

## Subscription Rules

Notification channels can limit which upstreams, events, or rate groups they receive. Empty value, empty string, `null`, or `[]` means all upstreams and all events.

```json
[
  { "channel_ids": [1, 2], "mode": "all" },
  { "channel_ids": [3], "mode": "groups", "groups": ["default", "pro"], "events": ["rate_changed"] },
  { "channel_ids": [4], "mode": "all", "events": ["announcement", "monitor_failed"] }
]
```

- `channel_ids`: upstream channel ID list. Historical `channel_id` single-value rules are still accepted.
- `events`: event type list. Empty means all events for that upstream.
- `mode=all`: receive all rate groups.
- `mode=groups`: receive only selected groups for rate-related events.

## Notification Event Types

- `balance_low`: balance below threshold.
- `rate_changed`: rate changed.
- `rate_structure_changed`: group structure changed.
- `rate_added`: group added. Kept for historical compatibility.
- `rate_removed`: group removed. Kept for historical compatibility.
- `announcement`: new upstream announcement.
- `login_failed`: login failed.
- `captcha_failed`: captcha solving failed.
- `monitor_failed`: balance, spending, or rate collection failed.

## APIs and Operations

Announcement list:

```text
GET /api/announcements?page=1&page_size=20
```

Notification logs:

```text
GET /api/notifications/logs?page=1&page_size=20
```

Notification log rows include the upstream channel ID when the event is tied to a specific upstream channel.

Rate change logs:

```text
GET /api/rate-changes?page=1&page_size=20
GET /api/rate-changes?channel_id=1&page=1&page_size=20
```

Channels:

```text
GET /api/channels?page=1&page_size=20
GET /api/channels?page=1&page_size=-1
GET /api/channels?page=1&page_size=20&q=vip&status=healthy&tag=backup&sort=balance&order=desc
POST /api/channels/:id/clear-login-info
```

Paged mode (with `page` / `page_size`) accepts these optional parameters; the unpaged full list ignores them:

- `q`: substring search over name, username, site URL, notes, and tags (ASCII case-insensitive), up to 200 characters.
- `status`: `healthy`, `low`, `failed`, `idle` (not yet synced), or `paused`.
- `tag`: exact match on a single tag (ASCII case-insensitive), no commas, up to 32 characters.
- `sort`: `default` (channel sort order), `name`, `username`, `health`, or `balance`; name and username put digits and symbols first, then Chinese by pinyin, then letters (case-insensitive), matching the browser's `zh-CN` order (a few polyphonic characters may differ); blank usernames and channels without a balance always come last.
- `order`: `asc` (default) or `desc`; ignored for `sort=default`.

Invalid or over-long values return 400; `total` / `pages` reflect the filtered result.

Recharge:

```text
GET  /api/channels/:id/recharge-info
POST /api/channels/:id/recharge
```

Redeem:

```text
POST /api/channels/:id/redeem
```

Captcha providers:

```text
GET    /api/captcha-configs
POST   /api/captcha-configs
PUT    /api/captcha-configs/:id
POST   /api/captcha-configs/:id/refresh-balance
DELETE /api/captcha-configs/:id
```

SSE progress endpoints:

```text
POST /api/channels/:id/test-login
POST /api/channels/:id/sync
POST /api/channels/sync-all
```

## Runtime Configuration Hot Reload

The system settings page supports runtime hot reload without restarting the service.

Hot-reloadable modules:

- `app`
- `auth`
- `scheduler`
- `notifications`
- `retention`
- `upstream`

Database path, HTTP port, and log level still require restart.

## Scheduler and Retention

Default schedules:

- Balance sync: every 15 minutes.
- Rate sync: every 30 minutes.
- Captcha balance refresh: scheduled and manual refresh are supported.
- History cleanup: daily.

Default retention:

- Monitor logs: 30 days.
- Balance snapshots: 90 days.
- Notification logs: 90 days.
- Upstream announcements: controlled by announcement retention days. `0` disables cleanup.
- Rate change logs are not cleaned by default.

## Data Security

The following sensitive fields are encrypted with `APP_SECRET`:

- Upstream account passwords.
- NewAPI cookies.
- Sub2API access tokens.
- Login session cookies and tokens.
- Notification channel secrets.
- Captcha provider API keys.

Important:

- `APP_SECRET` must remain stable.
- Changing `APP_SECRET` makes existing encrypted data undecryptable.
- Back up `.env` or configuration files together with the database.

## FAQ

### The page opens, but API requests fail

Check whether the backend service is running and whether reverse proxy routes `/api/*` correctly.

Frontend development URL:

```text
http://127.0.0.1:3010
```

Backend URL:

```text
http://127.0.0.1:8418
```

### Upstream login fails

Check the site URL, username, password, Turnstile requirement, captcha provider configuration, and whether token or cookie credentials have expired.

### Announcements are not pushed

Check whether the first announcement baseline sync has completed, rate sync runs successfully, notification channels are enabled, subscription rules include the upstream, and failed notification logs exist.

### Rate changes are not pushed

Check the minimum change percentage, notification subscription groups, and rate change history.

### Added or removed groups are not pushed

Added and removed groups are merged into a `rate_structure_changed` notification for the same scan. If a notification channel uses `mode=groups`, the added/removed list is filtered by subscribed groups before generating the notification.

The first rate sync only creates a baseline and does not push all existing groups as newly added groups.

### Low-balance alerts repeat too rarely

Check the low-balance alert cooldown in system settings. Cooldown state is stored in the database and survives restarts.

## License

MIT
