# Deploying the backend to your IONOS VPS

The desktop app stays exactly as it is — people still download a `.dmg`/`.exe`
and run it locally. The only thing moving to the server is the **backend**
(the FastAPI service that talks to Anthropic and holds the shared `team.db`).
Once it's running on the VPS, every teammate's app points at one shared URL
instead of `localhost:8000`, so everyone sees the same leads/calendar/data.

No domain yet, so this sets up plain HTTP over the server's bare IP address.
Everything works (lookups, leads, calendar, AI features) **except** the
Gmail/Microsoft "Connect" buttons in the email writer — those require HTTPS
in production. Add a domain later and follow the "Upgrading to HTTPS" section
at the bottom; nothing else needs to change.

Assumes Ubuntu (IONOS VPS default). Run everything below over SSH as root
the first time.

## 1. First-time server setup

```bash
ssh root@YOUR_SERVER_IP
```

```bash
# Update system, install what we need
apt update && apt upgrade -y
apt install -y python3 python3-venv python3-pip git nginx ufw

# A non-root user to run the app (never run app code as root)
adduser --disabled-password --gecos "" appuser

# Firewall: allow SSH + web traffic, nothing else
ufw allow OpenSSH
ufw allow 80/tcp
ufw --force enable
```

## 2. Get the code onto the server

```bash
mkdir -p /opt/v1-agent
chown appuser:appuser /opt/v1-agent
su - appuser
git clone https://github.com/YOUR_GITHUB_USERNAME/YOUR_REPO_NAME.git /opt/v1-agent
cd /opt/v1-agent/backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

If the repo is private, you'll need to authenticate (a GitHub personal access
token works as the password when git asks, or set up a deploy key).

## 3. Configure secrets

Still as `appuser`, in `/opt/v1-agent/backend`:

```bash
cp .env.example .env
nano .env   # or vim
```

Fill in:
- `ANTHROPIC_API_KEY` — your real key
- Leave the Google/Microsoft OAuth fields blank for now (no domain yet, so
  email-sending OAuth can't work in production regardless of what you put here)
- `OAUTH_REDIRECT_BASE_URL` — leave as-is for now, irrelevant until you add OAuth

This file never gets committed to git and never gets touched by deploys.

## 4. Run it as a real service (auto-starts, auto-restarts)

Back as `root`:

```bash
exit   # back out of the appuser shell if still in it
mkdir -p /opt/v1-agent/backend/data && chown appuser:appuser /opt/v1-agent/backend/data
cp /opt/v1-agent/backend/deploy/phone-lookup-backend.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now phone-lookup-backend
systemctl status phone-lookup-backend   # should say "active (running)"
```

The `mkdir` matters on a fresh clone: `backend/data/` is gitignored (it holds
the database), so it won't exist yet, and the service file's sandboxing
(`ReadWritePaths=.../data`) fails to start without it already present.

This binds uvicorn to `127.0.0.1:8000` — not exposed to the internet
directly. Nginx (next step) is what's actually public-facing.

## 5. Put nginx in front (public port 80 -> backend)

```bash
cp /opt/v1-agent/backend/deploy/nginx.conf.example /etc/nginx/sites-available/phone-lookup-backend
ln -s /etc/nginx/sites-available/phone-lookup-backend /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx
```

## 6. Verify it's live

From your own laptop:

```bash
curl http://YOUR_SERVER_IP/health
# -> {"status":"ok"}
```

If that works, the backend is live at `http://YOUR_SERVER_IP`.

## 7. Point the desktop app at it

Two ways — do both:

**A. Already-installed apps** (your team's current installs): open the app
-> Settings -> Backend Connection -> paste `http://YOUR_SERVER_IP` -> save.
Each person does this once.

**B. Future installer builds** (so new installs don't need step A): in the
GitHub repo -> Settings -> Secrets and variables -> Actions -> Variables tab
-> add a repository variable `BACKEND_BASE_URL` = `http://YOUR_SERVER_IP`.
The release workflow (`.github/workflows/release.yml`) already reads this and
bakes it in as the default for every future tagged build.

## Shipping updates later

You said you need to keep making changes and have them deploy without losing
data. The flow:

1. Make changes locally, commit, push to `main` (same as always).
2. SSH in and run the deploy script:

```bash
ssh appuser@YOUR_SERVER_IP
/opt/v1-agent/backend/deploy/deploy.sh
```

That pulls the latest code, updates dependencies, and restarts the service.
`backend/data/` (the actual database, backups, usage log) is gitignored and
lives only on the server's disk — `git pull` never touches it, so every
update preserves all existing data. The schema-migration system already in
`db.py` handles any database schema changes safely on restart (versioned,
backed up automatically before any real migration runs — see
`backend/tests/test_db_migrations.py`).

If you change the desktop app itself (not just the backend), that's a
separate step: bump the version in `app/package.json` / `app/src-tauri/Cargo.toml`,
push a tag like `v0.2.0`, and the GitHub Actions release workflow builds new
installers automatically. They land as a **draft** release on GitHub — you
publish it manually when ready, then send teammates the new download link.

## Upgrading to HTTPS once you have a domain

1. Point an A record for your domain at `YOUR_SERVER_IP`.
2. On the server: `apt install -y certbot python3-certbot-nginx`
3. `certbot --nginx -d yourdomain.com` — it edits the nginx config in place
   and sets up auto-renewal.
4. Update the desktop app's Backend Connection setting (and the
   `BACKEND_BASE_URL` repo variable) to `https://yourdomain.com`.
5. Now fill in the Google/Microsoft OAuth fields in `.env` for real — their
   redirect URIs require HTTPS, which you now have.
