# Slack Review-Queue Bot Setup

This runbook sets up the **Hemnet Spot-check Review** Slack bot — a one-time operator task.
The bot posts mismatch review messages and reads emoji reactions so the daily poller can
apply verdicts (Plan 13-05). Follow every numbered step in order.

> **Note on env vars:** Keep BOTH:
> - `SLACK_WEBHOOK_URL` — the write-only incoming webhook used by Phase 12 threshold/fetch-failure alerts (existing, do not remove)
> - `SLACK_BOT_TOKEN` — the new bot token (this runbook); required for `chat.postMessage` and `reactions:read`
>
> They are not interchangeable. A write-only incoming webhook cannot read reactions.

---

## Steps

### 1. Create the Slack app

1. Go to **https://api.slack.com/apps** and sign in to your workspace.
2. Click **"Create New App"** → choose **"From scratch"**.
3. Name it something recognisable, e.g. **`Hemnet Spot-check Review`**.
4. Select the workspace where your review channel lives, then click **"Create App"**.

---

### 2. Add the two required bot scopes

1. In the app settings left-hand sidebar, click **"OAuth & Permissions"**.
2. Scroll to **"Scopes"** → **"Bot Token Scopes"** → click **"Add an OAuth Scope"**.
3. Add exactly **two** scopes:
   - **`chat:write`** — allows the bot to post review and digest messages into the channel.
   - **`reactions:read`** — allows the bot to read emoji reactions on its messages.
     This scope is unavailable on a plain incoming webhook; a bot token is required (D-09).
4. Do **not** add any other scopes. Least-privilege: only what is needed (T-13-09).

---

### 3. Install the app to your workspace

1. Scroll up on the "OAuth & Permissions" page, click **"Install to Workspace"**.
2. Review the permission summary (chat:write + reactions:read) and click **"Allow"**.
3. Copy the **"Bot User OAuth Token"** that appears — it starts with **`xoxb-`**.

---

### 4. Set SLACK_BOT_TOKEN in .env on the droplet

```bash
ssh root@<your-droplet-ip>
echo 'SLACK_BOT_TOKEN=xoxb-...' >> /opt/hemnet-cohort-tracker/.env
```

**Security rules (T-13-08):**
- The bot token is a workspace secret — treat it like a password.
- It lives **only** in `/opt/hemnet-cohort-tracker/.env` on the droplet.
- `.env` is git-ignored. **Never commit it. Never echo it into logs.**
- If it leaks: revoke immediately at https://api.slack.com/apps → your app → OAuth & Permissions → Revoke token.

---

### 5. Set SLACK_REVIEW_CHANNEL in .env

1. In Slack, open the review channel (create one if needed, e.g. `#hemnet-spot-check-review`).
2. Click the channel name at the top → **"About"** → scroll to the bottom.
   Copy the **Channel ID** — it looks like `C0xxxxxxx`.
3. On the droplet:

```bash
echo 'SLACK_REVIEW_CHANNEL=C0xxxxxxx' >> /opt/hemnet-cohort-tracker/.env
```

---

### 6. Invite the bot to the review channel

In Slack, type the following command directly in the review channel:

```
/invite @Hemnet Spot-check Review
```

This step is **mandatory**: a bot can only read emoji reactions on messages in channels where it is a member. Without this invite, `reactions.get` will return `channel_not_found`.

---

### 7. Verify the setup

Run this one-liner on the droplet (or locally with the correct .env loaded):

```bash
cd /opt/hemnet-cohort-tracker && node -e "
require('dotenv').config();
const { postDigestMessage } = require('./lib/spotcheck-slack-bot');
postDigestMessage(
  process.env.SLACK_REVIEW_CHANNEL,
  [{ pair_id: 0, street_address: 'setup test', hemnet_id: 1, booli_id: 1 }]
).then(r => console.log(r));
"
```

Expected output: `{ ok: true, ts: '...' }` and a "setup test" digest message appears in the channel.

Then react to it with ✅, ❌, or ❓ to confirm reactions are visible — Plan 13-05's daily poller reads them.

---

## Reaction protocol (reminder)

| Emoji | Meaning | Effect |
|-------|---------|--------|
| ✅ | Confirm mismatch — this pair is NOT the same property | Pair removed from `cohort_pairs` (audit record kept) |
| ❌ | Override — this IS a valid match, keep it | Pair stays, override recorded |
| ❓ | Unsure — leave as UNCERTAIN, resurface later | No action taken |

---

## Summary of new env vars

| Var | Value | Required by |
|-----|-------|-------------|
| `SLACK_BOT_TOKEN` | `xoxb-…` (from step 3) | `lib/spotcheck-slack-bot.js` (post + reactions) |
| `SLACK_REVIEW_CHANNEL` | `C0…` (from step 5) | `lib/spotcheck-slack-bot.js`, `spotcheck-reaction-poller.js` |
