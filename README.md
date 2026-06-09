# BaliHQ Auto Reaction Leaderboard Bot

A Discord bot for BaliHQ that automatically tracks webhook/BaliBot play posts and turns reactions into leaderboards. No `/play`, no `/deleteplay`, no `/playinfo`, and no manual sync command required.

## What it does

When BaliBot/webhook posts in one of your tracked channels, this bot automatically stores that message. From that point on:

- Emoji ID `1445504770164133990` counts as a **win** for the user who reacted.
- Emoji ID `1445505106505109555` counts as a **loss** for the user who reacted.
- Emoji ID `1445874577010851880` gives that user **+1 reactor point**.

The bot also syncs recent posts automatically on startup and on a repeating timer, so it can recover missed events after restarts or deploys.

## Commands

```text
/leaderboard type:Win / Loss
/leaderboard type:Reactors
/record user:@user
/botstatus
```

That is intentionally the full command list.

## Setup

### 1. Install

```bash
npm install
cp .env.example .env
```

### 2. Fill in `.env`

```env
DISCORD_TOKEN=your_bot_token
CLIENT_ID=your_application_client_id
GUILD_ID=your_discord_server_id
TRACK_CHANNEL_IDS=your_play_channel_id
```

The BaliHQ emoji IDs are already set:

```env
WIN_EMOJIS=1445504770164133990
LOSS_EMOJIS=1445505106505109555
REACTOR_POINT_EMOJIS=1445874577010851880
```

Auto-sync is also already enabled:

```env
AUTO_SYNC_ON_READY=true
AUTO_SYNC_INTERVAL_SECONDS=300
SYNC_LIMIT=100
```

`AUTO_SYNC_INTERVAL_SECONDS=300` means it rechecks the latest tracked-channel messages every 5 minutes. Set it to `60` if you want a tighter scan. Keep it at least `30` to avoid pointless API pressure.

### 3. Deploy slash commands

Run this after first setup or whenever command definitions change:

```bash
npm run deploy
```

### 4. Start the bot

```bash
npm start
```

## Discord bot settings

In the Discord Developer Portal, enable these intents:

- Server Members Intent is not required.
- Message Content Intent is not required if you only filter by channel + webhook.
- The bot needs access to the tracked channels.
- The bot needs permission to read messages, read message history, and add/manage reactions.

Recommended bot permissions:

```text
View Channels
Read Message History
Use Application Commands
Add Reactions
Manage Messages
```

`Manage Messages` is only needed if you want the bot to remove the opposite reaction when someone reacts with both win and loss.

## How tracking works

The bot tracks messages that match:

```env
TRACK_CHANNEL_IDS=...
REQUIRE_WEBHOOK=true
```

So the clean default is: only webhook/BaliBot posts inside your selected channels count.

If BaliBot is not posting through a webhook, set:

```env
REQUIRE_WEBHOOK=false
TRACK_AUTHOR_IDS=balibot_user_id
```

## Start time

By default, the bot starts counting from the first time it launches. That prevents old server history from polluting the leaderboard.

To force a specific start time:

```env
TRACK_AFTER_ISO=2026-06-08T00:00:00.000Z
```

## Auto-sync behavior

The bot syncs recent messages in the background. It checks the latest `SYNC_LIMIT` messages per tracked channel and imports qualifying webhook posts/reactions.

This helps with:

- bot restarts
- missed Discord reaction events
- reactions added while the bot was offline
- keeping the leaderboard aligned with the actual Discord reactions

## Data storage

Local JSON storage lives here:

```env
DATA_FILE=./data/balihq-leaderboard.json
```

Back that file up if you move hosts.

## Deploy to GitHub

```bash
git init
git add .
git commit -m "Initial BaliHQ auto reaction leaderboard bot"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/balihq-auto-reaction-leaderboard-bot.git
git push -u origin main
```
