# GitHub setup for BaliHQ Auto Reaction Leaderboard Bot

## Fast setup

Create a new empty GitHub repository named:

```text
balihq-auto-reaction-leaderboard-bot
```

Do **not** initialize it with a README, .gitignore, or license because this project already has those files.

Then run:

```bash
unzip balihq-auto-reaction-leaderboard-github-ready.zip
cd balihq-auto-reaction-leaderboard-github-ready

git init
git add .
git commit -m "Initial BaliHQ auto reaction leaderboard bot"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/balihq-auto-reaction-leaderboard-bot.git
git push -u origin main
```

## After pushing to GitHub

On your hosting service, add these environment variables:

```env
DISCORD_TOKEN=your_bot_token
CLIENT_ID=your_application_client_id
GUILD_ID=your_discord_server_id
TRACK_CHANNEL_IDS=your_play_channel_id

WIN_EMOJIS=1445504770164133990
LOSS_EMOJIS=1445505106505109555
REACTOR_POINT_EMOJIS=1445874577010851880

REQUIRE_WEBHOOK=true
AUTO_SYNC_ON_READY=true
AUTO_SYNC_INTERVAL_SECONDS=300
SYNC_LIMIT=100
DATA_FILE=./data/balihq-leaderboard.json
```

Run command deploy once after setting env vars:

```bash
npm run deploy
```

Then start the bot:

```bash
npm start
```

## Current commands

```text
/leaderboard
/record
/botstatus
```

No `/play`, no `/deleteplay`, no `/playinfo`, and no manual sync command.
