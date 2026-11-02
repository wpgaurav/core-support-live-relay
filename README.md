# Core Support live chat relay

A Cloudflare Worker that makes [Core Support](https://gauravtiwari.org/product/core-support/) live chat instant. Messages and typing indicators reach visitors and agents over WebSockets instead of the browser checking the site every few seconds.

It runs in your own Cloudflare account, and no chat passes through anyone else's servers. The Workers Free plan is enough for most help desks.

WordPress stays the source of truth: every message is saved by your site first, and the Worker only tells open browsers that something changed. If the Worker stops answering, Core Support falls back to checking the site, so you get slower updates but never lost messages.

## Set it up

You need Core Support 1.5.0-beta.6 or later with live chat turned on, a Cloudflare account, and a GitHub or GitLab account.

1. **Make a secret.** In WordPress, open Core Support → AI and Chat → Chat and Live Chat → Live chat connection and click **Generate a secret**. It fills in the Worker secret field and copies the secret.
2. **Deploy the Worker.** Click the button below. Cloudflare copies this repository into your GitHub or GitLab account, then builds and deploys it to your Cloudflare account. Paste the secret when it asks for `LIVE_SECRET`.

   [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/wpgaurav/core-support-live-relay)

3. **Connect Core Support.** Copy the Worker's address, such as `https://core-support-live-relay.your-name.workers.dev`. It is shown when the deploy finishes, and later under Workers & Pages → your Worker. Paste it into **Worker URL**, set **How messages travel** to **Cloudflare Worker**, click **Send test event**, then **Save settings**.

If Cloudflare didn't ask for the secret, or you want to change it later, open Workers & Pages → your Worker → Settings → Variables and Secrets. Add a **Secret** named `LIVE_SECRET` and deploy.

### With Wrangler instead

```bash
git clone https://github.com/wpgaurav/core-support-live-relay.git
```

```bash
cd core-support-live-relay
```

```bash
npx wrangler secret put LIVE_SECRET
```

```bash
npx wrangler deploy
```

Then connect Core Support as in step 3.

### Keeping the secret out of the database

The Worker URL and the secret can live in `wp-config.php` instead of the settings screen:

```php
define('CORE_SUPPORT_CHAT', [
    'live_transport' => 'cloudflare',
    'live_worker_url' => 'https://core-support-live-relay.your-name.workers.dev',
    'live_worker_secret' => 'the same secret as LIVE_SECRET',
]);
```

`wp core-support doctor` checks that the Worker answers and accepts a signed test event.

## What it costs

Both Durable Object classes use SQLite storage, which is the kind the Workers Free plan offers, and neither stores anything.

- Cloudflare's [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) listed the Free plan's limits as 100,000 requests and 13,000 GB-s a day when checked on November 2, 2026.
- Opening a socket counts as one request, and incoming socket messages are billed at 20 to 1.
- The keep-alive `ping` is answered by the runtime without waking the object.

Check the current limits before relying on them.

## Bindings

| Binding | Value |
| --- | --- |
| `LIVE_SECRET` | Secret shared with Core Support, at least 32 characters. The Worker refuses to publish or connect without it. |
| `CONVERSATIONS` | Durable Object namespace for the `Conversation` class: one object per live chat. |
| `DESKS` | Durable Object namespace for the `Desk` class: one object per help-desk site, for the agents' queue. |

`wrangler.toml` sets up both Durable Object bindings.

## Contract

### WordPress → Worker: `POST /publish`

After each live-chat write is saved, WordPress posts one event with a 2-second timeout. A failed publish is logged under Recent problems on Core Support's Chat → Knowledge tab. Nothing retries it, because the browsers' 60-second safety check fetches the same data from WordPress.

The body is exact UTF-8 JSON, at most 64 KiB: `{"type": "message" | "status" | "test", "thread": "<uuid>", "data": {…}}`. It comes with these headers:

| Header | Value |
| --- | --- |
| `X-Core-Support-Site` | The help desk's site key: its home URL without the scheme, such as `example.com` or `example.com/help` |
| `X-Core-Support-Timestamp` | Unix time; refused when more than 300 seconds from the Worker's clock |
| `X-Core-Support-Delivery` | A random ID, 16 to 64 letters, digits or hyphens |
| `X-Core-Support-Signature` | `v1=` + hex HMAC-SHA256 keyed with `LIVE_SECRET`. It signs these lines joined by `\n`: `v1`, `publish`, site key, timestamp, delivery ID, and the SHA-256 hex of the body |

The Worker answers `{"accepted": true, "delivery_id": "…", "delivered": <sockets reached>}`.

- `message` goes to the conversation's sockets: `{"type": "message", "thread", "message": {"id", "from", "name", "body", "at"}}`.
- `status` goes to the conversation and the agents' queue: `{"type": "status", "thread", "status", "joined", "agent_name"}`.
- `test` goes to the agents' queue only and changes nothing. "Send test event" and the doctor use it.

### Browser → Worker: `GET /connect?token=…` (WebSocket)

Browsers get a token from `POST /wp-json/core-support/v1/chat/live/subscribe`: visitors with their conversation's token, agents with their WordPress session. The token is `v1.` + base64url(JSON claims) + `.` + the hex HMAC-SHA256 of `v1\nsubscribe\n` and the claims segment.

The claims, in this order:

- `role`: `visitor` or `agent`
- `site`
- `thread`: empty for an agent's queue
- `origin`
- `name`: the agent's display name; empty for visitors
- `exp`: Unix time, 5 minutes after the token was issued

The Worker checks the HMAC, the expiry, and that the request's `Origin` header equals `origin`, all without calling WordPress. Connected sites work because Core Support puts the connected site's origin in the token after checking it against Connected sites.

A socket lasts at most an hour. The Worker then closes it with code `4001`, and the browser asks WordPress for a new token. That way a revoked agent or an ended chat drops off within the hour.

On top of the publish events, the Worker sends browsers:

- **Typing:** `{"type": "typing", "thread", "from": "visitor" | "agent", "name"}` means someone else in the chat is typing. Browsers send `{"type": "typing"}`, and the Worker adds the role and name from the token. It goes to everyone else in the chat except the visitor's own other tabs, at most once a second per socket, and is never stored.
- **Presence:** `{"type": "presence", "visitor": true | false}` tells agents in a chat whether the visitor has it open.

Anything else a browser sends is dropped. Browsers send `ping` every 30 seconds and get `pong`.

### Other routes

`GET /health` answers `{"ok": true, "service": "core-support-live-relay", "version": 1, "configured": <secret and bindings present>}`.

## Tests

```bash
npm test
```

The tests use the shared signature vectors in `vectors.json`, which were generated with Python's `hmac`; Core Support's PHP reproduces the same vectors. The tests fake the Durable Object state the way workerd behaves: structured-clone attachments, tags, and sockets that outlive the object. They cover:

- expired, forged, wrong-origin and wrong-thread tokens
- publish fan-out, typing and presence
- session expiry
- an object woken from hibernation

To run the same contract against the real runtime, put `LIVE_SECRET=` plus a 32-character secret in `.dev.vars`, start `npx wrangler dev`, and run:

```bash
LIVE_RELAY_URL=http://localhost:8787 LIVE_SECRET=your-secret npm run test:dev
```

## Status

Tested locally and against `wrangler dev`. A Worker deployed to Cloudflare through the button has not been verified yet. This repository mirrors `tools/live-relay` in Core Support, where changes are made and tested with the plugin.

## License

GPL-3.0-or-later, like Core Support. See [LICENSE](https://github.com/wpgaurav/core-support-live-relay/blob/main/LICENSE).
