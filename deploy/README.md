# Leaving it running

The agent is a tick: read replies, discover, qualify, enrol, send. A tick is
idempotent, resumable and takes a lock, so it is equally at home as a one-shot
command, a loop in a terminal, or a scheduled job. Nothing here costs money.

Three things make unattended running safe, and they are worth understanding
before you pick a method:

**The lock.** `npm run agent` takes a per-campaign lock before it does
anything. A schedule firing every ten minutes against a tick that occasionally
takes twelve *will* overlap, and two overlapping ticks both read "sent today:
4", both decide there is room, and quietly double the daily cap, the
per-domain cap and the anti-pester gap. A second tick finding the lock held
skips rather than queues, and says so.

**The warmup ramp.** The daily cap is not a constant. It starts at a handful
and reaches whatever you configured over about four weeks, and it halves
itself when bounces pass 2% or complaints pass 0.15%, and stops entirely at 5%
and 0.3%. A new sending domain that emits its full volume on day one is a new
sending domain with a damaged reputation, and the damage is invisible for
weeks — by the time the reply rate drops, the mail has been going to spam for
a fortnight and the only fix is a new domain.

**The failure ceiling.** `--loop` stops after three consecutive failures,
with exponential backoff between them. A loop that retries forever on a broken
campaign looks identical to one that is working, which is the worst property
an unattended process can have.

---

## cron

The simplest thing that works. Every twenty minutes during business hours,
which is more than enough — the send window and the daily cap are what control
volume, not how often the tick runs.

```cron
*/20 8-18 * * 1-5  cd /srv/mercurio && /usr/bin/npm run agent -- CAMPAIGN_ID >> /var/log/mercurio.log 2>&1
```

The lock means you do not need to care whether a previous run is still going.

## systemd

Better than cron if you want the agent restarted after a reboot and its output
in the journal. Two units: a service that runs one tick, and a timer.

```ini
# /etc/systemd/system/mercurio.service
[Unit]
Description=Mercurio outbound agent, one tick
After=network-online.target

[Service]
Type=oneshot
WorkingDirectory=/srv/mercurio
EnvironmentFile=/srv/mercurio/.env
ExecStart=/usr/bin/npm run agent -- CAMPAIGN_ID
User=mercurio
# The agent writes to ./data, ./outbox and ./inbox and nothing else.
ProtectSystem=strict
ReadWritePaths=/srv/mercurio/data /srv/mercurio/outbox /srv/mercurio/inbox
PrivateTmp=true
NoNewPrivileges=true
```

```ini
# /etc/systemd/system/mercurio.timer
[Unit]
Description=Run the Mercurio agent on a schedule

[Timer]
OnCalendar=Mon-Fri 08..18:00/20
# Spreads the start, so a dozen agents on one box do not all wake together.
RandomizedDelaySec=120
Persistent=true

[Install]
WantedBy=timers.target
```

```bash
sudo systemctl enable --now mercurio.timer
systemctl list-timers mercurio.timer
journalctl -u mercurio.service -f
```

## GitHub Actions

Free, and genuinely unattended — no machine of your own. The catch is state:
Actions runners are ephemeral, so the SQLite file has to be carried between
runs. `deploy/github-actions.yml` does that by committing it back to a branch,
which works and is ugly, and the honest alternatives are worse:

- An artifact expires, so the pipeline would silently reset.
- A cache is evicted under pressure and is explicitly not durable storage.
- A hosted database is a service with an account and a free tier that ends.

Committing a database file to git is unlovely but it is durable, free, and
auditable — every run's state change is a diff you can read. Copy the workflow
to `.github/workflows/`, set the secrets it names, and edit the campaign id.

**Do not do this on a public repository.** The database holds prospect
addresses and message bodies.

## Which to pick

| | cron | systemd | Actions |
|---|---|---|---|
| Needs a machine you keep on | yes | yes | no |
| Survives a reboot | yes | yes | n/a |
| Output you can read later | redirect it | journal | run logs |
| State | local file | local file | committed to a branch |
| Cost | — | — | — |

If you have a machine that is on anyway, use systemd. If you do not, use
Actions and accept the committed database.
