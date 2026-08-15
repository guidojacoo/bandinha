# bandinha

This repository holds two independent products.

| Product | What it is | Start here |
|---|---|---|
| **[Bitrot](apps/bitrot/)** | Dependency lifecycle risk, scored from live npm and PyPI registry data. Finds the dependencies that are deprecated, abandoned, or one maintainer away from unmaintained — the half of supply-chain risk CVE scanners cannot see. | [`apps/bitrot/README.md`](apps/bitrot/README.md) |
| **H59 Health** | Self-hosted replacement for the QWatch Pro fitness-band app. | the rest of this file |

They share a workspace and a lockfile but nothing else — separate apps,
separate databases, separate deploys.

---

# H59 Health

A modern, self-hosted replacement for **QWatch Pro** — the app that ships
with the **H59** fitness band (and its rebadged siblings, all built on the
same Colmi/QC BLE protocol). Multi-user, your own database, your own Sleep
Score and Recovery Score, no dependency on QWatch's servers or app.

Bluetooth LE only works from a phone, so the architecture is a mobile app
(BLE + local cache) talking to a Next.js backend (auth, sync, API) with a
matching web dashboard — see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
for the full picture.

## Where to start

| I want to... | Read |
|---|---|
| Understand what's actually known about the BLE protocol (and what's still unknown — vibration, alarms) | [`docs/BLE_PROTOCOL.md`](docs/BLE_PROTOCOL.md) |
| Run this locally / connect my own H59 | [`docs/SETUP.md`](docs/SETUP.md) |
| Understand the system design | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) |
| See every API endpoint | [`docs/API.md`](docs/API.md) |
| Understand the Sleep Score / Recovery Score math | [`docs/SLEEP_ALGORITHM.md`](docs/SLEEP_ALGORITHM.md) |
| Auth, data isolation, privacy posture | [`docs/SECURITY.md`](docs/SECURITY.md) |
| Test hardware-dependent unknowns against a real band | [`tools/ble-probe/README.md`](tools/ble-probe/README.md) |

## What this is built on

The BLE protocol here is reverse-engineered, not guessed — cross-validated
against three independent open-source projects before anything was treated
as reliable:

- [OpenH59](https://github.com/LudovicoPiccolo/OpenH59) — the H59-specific
  reference; proven end-to-end against a real unit by its own author.
- [Gadgetbridge](https://codeberg.org/Freeyourgadget/Gadgetbridge) — the
  write/control side (find-device, power-off, preferences) that OpenH59's
  read-only client doesn't cover.
- [colmi_r02_client](https://github.com/tahnok/colmi_r02_client) —
  confirms this is one shared SDK/protocol family, not H59-specific quirks.

Full citations and the SUPPORTED / EXPERIMENTAL / UNKNOWN breakdown live in
`docs/BLE_PROTOCOL.md`. Nothing in this repo invents a protocol command.

## Repo layout

```
apps/
  bitrot/     Bitrot — separate product, see apps/bitrot/README.md
  mobile/     Expo + TypeScript + react-native-ble-plx — the only place BLE happens
  web/        Next.js — backend API + web dashboard, one deploy
packages/
  protocol/   BLE framing/parsing — pure TS, unit-tested without hardware
  scoring/    Sleep Score + Recovery Score — pure TS, unit-tested
  db/         Prisma schema
  shared/     Cross-cutting TypeScript types
tools/
  ble-probe/  Standalone Python tool for testing vibration/alarm on real hardware
docs/         Everything above
```

## Quick start

```bash
npm install
npm test              # protocol + scoring test suites, no hardware/DB needed
```

Then see [`docs/SETUP.md`](docs/SETUP.md) for the database, backend,
mobile dev-client, and real-hardware pairing steps.
