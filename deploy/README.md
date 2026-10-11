# Leaving it running

There is one answer and it is `npm run worker`. A worker comes up, finds every
campaign that is supposed to be working, works them, and keeps doing that
through reboots and failures — scheduling each campaign's next look from the
campaign's own cadence rather than from a polling interval. The recipes below
are about keeping a worker alive, which is a much smaller problem than keeping
a schedule correct. Nothing here costs money.

```bash
npm start                             # the console and one worker
npm start -- --workers 4              # four workers beside it
npm run worker -- --concurrency 4     # a worker on any other machine
```

Scaling out needs no configuration and no coordinator: a worker only has to
reach the same database. Work is a row, a worker claims it, and the claim is
the only thing that grants the right to act.

Four things make that safe, and they are worth understanding before you pick a
method:

**At most one live job per campaign, enforced by the database.** A unique
index on a dedupe key that is cleared when a job goes terminal, so a running
campaign has exactly one tick row for its whole life. Not a lock — a lock is
held by a process, and when the other process is on another machine the lock
is imaginary. Overlapping ticks would both read "sent today: 4", both decide
there is room, and quietly double the daily cap, the per-domain cap and the
anti-pester gap.

**Claims expire, and any worker reaps them.** A worker renews its claim while
it works; one that is killed stops renewing and the next worker takes the job
over, because the case that needs recovering is precisely the case where a
process died. A clean shutdown hands claims back without spending an attempt,
so a rolling restart costs nothing.

**A dead letter that is loud and temporary.** A job that has used its attempts
becomes visible on the campaign and on the queue page, and an hour later the
campaign is tried again — most dead jobs are something that passes, and
waiting for somebody to notice is worse.

**Monitoring that cannot be fooled.** `GET /api/health` reports `degraded`
when work is queued and nothing is consuming it, which is the one failure
where the console answers every request and nothing happens. `npm run health`
says the same on a terminal and exits non-zero.

Two more things matter more than the scheduler you pick:

**The warmup ramp.** The daily cap is not a constant. It starts at a handful
and reaches whatever you configured over about four weeks, and it halves
itself when bounces pass 2% or complaints pass 0.15%, and stops entirely at 5%
and 0.3%. A new sending domain that emits its full volume on day one is a new
sending domain with a damaged reputation, and the damage is invisible for
weeks — by the time the reply rate drops, the mail has been going to spam for
a fortnight and the only fix is a new domain.

---

## systemd

The one to use if you have a machine that is on anyway. A long-running service
rather than a timer, because the thing being kept alive is a worker that
schedules its own work — a timer firing a one-shot would be a second, dumber
scheduler on top of the one in the database.

Two units, because the console and the worker are separate concerns and you
may well want several of the second. Nothing coordinates them but the
database.

```ini
# /etc/systemd/system/mercurio-console.service
[Unit]
Description=Mercurio console
After=network-online.target

[Service]
WorkingDirectory=/srv/mercurio
EnvironmentFile=/srv/mercurio/.env
ExecStart=/usr/bin/npm start -- --no-worker
Restart=always
RestartSec=5
User=mercurio
ProtectSystem=strict
ReadWritePaths=/srv/mercurio/data /srv/mercurio/.next
PrivateTmp=true
NoNewPrivileges=true
```

```ini
# /etc/systemd/system/mercurio-worker@.service
[Unit]
Description=Mercurio worker %i
After=network-online.target

[Service]
WorkingDirectory=/srv/mercurio
EnvironmentFile=/srv/mercurio/.env
ExecStart=/usr/bin/npm run worker -- --concurrency 2
# A worker handed SIGTERM stops claiming, finishes what it holds and hands
# back the rest without spending an attempt. Worth waiting for: a hard kill
# leaves claims to expire on their lease, which parks those campaigns for a
# few minutes.
KillSignal=SIGTERM
TimeoutStopSec=90
Restart=always
RestartSec=5
User=mercurio
ProtectSystem=strict
ReadWritePaths=/srv/mercurio/data /srv/mercurio/outbox /srv/mercurio/inbox
PrivateTmp=true
NoNewPrivileges=true
```

```bash
sudo systemctl enable --now mercurio-console
sudo systemctl enable --now mercurio-worker@1 mercurio-worker@2
journalctl -u 'mercurio-*' -f
```

Scaling up is `systemctl enable --now mercurio-worker@3`. Scaling down is
`stop`, and the worker hands its work back on the way out.

## Docker

```bash
docker compose up                      # console + one worker
docker compose up --scale worker=4     # four workers
docker compose --profile postgres up   # and a database that takes concurrent writers
```

One image, two roles, chosen by the command. The compose file keeps `./data`,
`./outbox` and `./inbox` in volumes, because a SQLite file inside a container
disappears with the container.

## cron

Only if you cannot keep a process running. A worker is the better answer, so
this is the fallback: a drain run on a schedule, which works through whatever
is due and exits.

```cron
*/20 8-18 * * 1-5  cd /srv/mercurio && /usr/bin/npm run worker -- --drain >> /var/log/mercurio.log 2>&1
```

Overlapping runs are harmless — a job can only be claimed once, and a run that
finds everything claimed exits having done nothing.

## GitHub Actions

Free, and genuinely unattended — no machine of your own. The catch is state:
Actions runners are ephemeral, so the database has to live somewhere. Two ways,
and the second is now the better one:

**A committed SQLite file.** `deploy/github-actions.yml` carries the file
between runs by committing it back to a branch. Ugly, and the alternatives
were worse: an artifact expires so the pipeline silently resets, a cache is
evicted under pressure and is explicitly not durable storage. It is durable,
free and auditable — every run's state change is a diff you can read.

**A free Postgres.** `npm run db:provider -- postgres` and a Neon or Supabase
connection string in the repository secrets, and the runner carries nothing at
all. Still free, and it removes the one genuinely unpleasant part of this
recipe. The whole test suite runs against Postgres, so this is not a leap of
faith.

Either way: copy the workflow to `.github/workflows/`, set the secrets it
names, and have it run `npm run worker -- --drain`.

**Do not do this on a public repository.** The database holds prospect
addresses and message bodies.

## Which to pick

| | systemd | Docker | cron | Actions |
|---|---|---|---|---|
| Needs a machine you keep on | yes | yes | yes | no |
| Survives a reboot | yes | yes | yes | n/a |
| Add a worker | `worker@3` | `--scale worker=3` | no | no |
| Output you can read later | journal | `compose logs` | redirect it | run logs |
| State | local file or Postgres | volume or Postgres | local file | committed, or Postgres |
| Cost | — | — | — | — |

If you have a machine that is on anyway, use systemd, or Docker if you would
rather not install Node on it. If you do not, use Actions with a free Postgres.

Whichever you pick, point a free uptime monitor at `/api/health`. It reports
`degraded` when work is queued and nothing is consuming it, which is the only
failure that looks like success from every other angle.
