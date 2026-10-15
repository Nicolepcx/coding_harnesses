#!/usr/bin/env bash
# Sets up an Ubuntu 24.04 machine (a DigitalOcean droplet with 16 GB works well)
# to run both plans. Run as root from the repository, wherever it is:
#
#   git clone https://github.com/<you>/harnesses-plural /opt/harnesses-plural
#   bash /opt/harnesses-plural/deploy/bootstrap.sh 2>&1 | tee /var/log/harness-bootstrap.log
#
# Safe to run again: every step checks what already exists.
#
# What it sets up, and why:
#   harness   the user every agent runs as: no sudo, writes only /srv/runs
#   judge     owns the hidden scoreboard; agents cannot read it
#   goldens   the hidden suite's expected outputs are recorded HERE, on real
#             Python 2.7, and never leave this machine (they are not in git)
set -uo pipefail
log() { echo "[$(date +%H:%M:%S)] $*"; }
die() { log "FAILED: $*"; exit 1; }

REPO="$(cd "$(dirname "$0")/.." && pwd)"
[ "$(id -u)" = 0 ] || die "run as root"
[ -f "$REPO/harness/run.ts" ] || die "repository not found next to deploy/"
export DEBIAN_FRONTEND=noninteractive

log "1/10 packages"
apt-get update -q >/dev/null 2>&1
apt-get install -yq build-essential git curl jq ufw zlib1g-dev libssl-dev libffi-dev libbz2-dev \
  libsqlite3-dev python3-venv bubblewrap unzip >/dev/null || die "apt-get install"

log "2/10 users: harness (runs agents), judge (owns the hidden scoreboard)"
id harness >/dev/null 2>&1 || useradd -m -s /bin/bash harness
id judge >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin judge
if [ -f /root/.ssh/authorized_keys ]; then
  mkdir -p /home/harness/.ssh && cp /root/.ssh/authorized_keys /home/harness/.ssh/authorized_keys
  chown -R harness:harness /home/harness/.ssh && chmod 700 /home/harness/.ssh && chmod 600 /home/harness/.ssh/authorized_keys
fi

log "3/10 environment for the harness user"
cat > /etc/profile.d/harness-env.sh <<'EOF'
# Subscriptions: log in once as harness with `claude` and `codex login --device-auth`.
# API keys instead: put ANTHROPIC_API_KEY / OPENAI_API_KEY in /etc/harness/harness.env.
if [ "$(id -un)" = "harness" ] && [ -r /etc/harness/harness.env ]; then
  set -a; . /etc/harness/harness.env; set +a
fi
export PYTHONHASHSEED=0 LC_ALL=C.UTF-8 LANG=C.UTF-8 PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
EOF
mkdir -p /etc/harness
[ -f /etc/harness/harness.env ] || printf '# ANTHROPIC_API_KEY=\n# OPENAI_API_KEY=\n' > /etc/harness/harness.env
chgrp harness /etc/harness/harness.env && chmod 640 /etc/harness/harness.env

log "4/10 firewall: SSH only"
# Never enable the firewall unless SSH is allowed first, or you lock yourself out.
if ufw allow OpenSSH >/dev/null 2>&1 || ufw allow 22/tcp >/dev/null 2>&1; then
  ufw default deny incoming >/dev/null && ufw default allow outgoing >/dev/null && ufw --force enable >/dev/null \
    || log "warning: ufw not enabled"
else
  log "warning: could not allow SSH in ufw, firewall left unchanged"
fi

log "5/10 swap"
if ! swapon --show | grep -q /swapfile; then
  if fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile; then
    grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  else
    log "warning: no swap"
  fi
fi

log "6/10 Codex sandbox: allow unprivileged user namespaces (Ubuntu 24.04 restricts them)"
# Codex sandboxes every command with bubblewrap, which needs user namespaces.
# On a machine that only runs this demo, allowing them is the simple fix.
echo 'kernel.apparmor_restrict_unprivileged_userns=0' > /etc/sysctl.d/60-codex-sandbox.conf
sysctl --system >/dev/null 2>&1 || true

log "7/10 Node 22 and the agent CLIs (Claude Code, Codex, Pi), installed system-wide"
if ! node -v 2>/dev/null | grep -q '^v2[2-9]'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null && apt-get install -yq nodejs >/dev/null || die "nodejs"
fi
npm install -g @anthropic-ai/claude-code @openai/codex >/dev/null 2>&1 || die "npm install claude-code/codex"
npm install -g --ignore-scripts @earendil-works/pi-coding-agent >/dev/null 2>&1 || log "warning: pi not installed"

log "8/10 Python 2.7 from source (a few minutes) and Python 3.12"
if [ ! -x /opt/py27/bin/python2.7 ]; then
  bash "$REPO/tools/build_py27.sh" /opt/py27 || die "python 2.7 build"
fi
ln -sf /opt/py27/bin/python2.7 /usr/local/bin/python2.7
if [ -x /usr/bin/python3.12 ]; then
  ln -sf /usr/bin/python3.12 /usr/local/bin/python3.12
else
  apt-get install -yq python3.12 >/dev/null 2>&1 && ln -sf /usr/bin/python3.12 /usr/local/bin/python3.12 \
    || die "python3.12 not available"
fi

log "9/10 harness dependencies, Playwright and Chromium"
( cd "$REPO/harness" && npm ci --no-audit --no-fund >/dev/null 2>&1 ) || die "harness npm ci"
( cd "$REPO/harness" && PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers npx playwright install --with-deps chromium >/dev/null 2>&1 \
  && chmod -R a+rX /opt/pw-browsers ) || die "playwright"

log "10/10 lock down: hidden suites to /opt/judge, goldens recorded locally, repository read-only"
mkdir -p /opt/judge /srv/runs
for d in "$REPO"/domains/*/; do
  name="$(basename "$d")"
  if [ -d "$d/hidden" ]; then
    rm -rf "/opt/judge/$name" && mkdir -p "/opt/judge/$name" && mv "$d/hidden" "/opt/judge/$name/hidden"
  fi
done
chown -R root:root "$REPO" && chmod -R a+rX,go-w "$REPO"
chown -R judge:judge /opt/judge && chmod -R go-rwx /opt/judge
chown harness:harness /srv/runs && chmod 755 /srv/runs
for h in /opt/judge/*/hidden; do
  name="$(basename "$(dirname "$h")")"
  if [ ! -d "$h/golden" ]; then
    sudo -u judge python3 "$h/runner.py" record --python /usr/local/bin/python2.7 --app "$REPO/domains/$name/app" \
      || die "recording the hidden goldens for $name"
  fi
  log "smoke test ($name): the legacy build must score 100%"
  sudo -u judge python3 "$h/runner.py" score --python /usr/local/bin/python2.7 --app "$REPO/domains/$name/app" | sed -n 2p
done

log "versions: $(python2.7 --version 2>&1), $(python3.12 --version), node $(node -v)"
log "claude $(claude --version 2>/dev/null | head -1), codex $(codex --version 2>/dev/null | head -1), pi $(pi --version 2>/dev/null | head -1)"
log "done. Next: log in as harness (claude, codex login --device-auth), then: sudo -iu harness bash $REPO/tools/smoke_agents.sh"
