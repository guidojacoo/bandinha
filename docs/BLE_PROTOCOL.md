# H59 / Colmi-QC BLE Protocol

This is the single source of truth for what H59 Health actually knows about
the H59's Bluetooth LE protocol, and — critically — what it does **not**
know yet. Every claim below is attributed to a source that was actually read
(not recalled from memory), so it can be checked. If you discover something
new (especially via `tools/ble-probe`), add it here in the matching section
before wiring it into the product.

## Sources

| Source | What it is | What we took from it |
|---|---|---|
| [OpenH59](https://github.com/LudovicoPiccolo/OpenH59) (LudovicoPiccolo) | Python/`bleak` client for the H59 specifically, reverse-engineered against a real unit. Read-only (no write/control commands). | The entire read-side protocol: UUIDs, frame format, all history/real-time commands, the bc/big-data channel, sleep + SpO2 decoding. |
| [Gadgetbridge](https://codeberg.org/Freeyourgadget/Gadgetbridge) (`devices/colmi` / `devices/yawell/ring`) | Mature open-source Android app supporting a whole family of Colmi/Yawell rings and bands, including an **unmerged** PR #5039 adding an H59 coordinator. | Confirmation that H59 shares its command set with the ring family (`H59Coordinator extends AbstractYawellRingCoordinator` with **zero** protocol overrides in the PR diff), plus write/control commands OpenH59 never implements (find-device, power-off, factory reset, preferences, goals). |
| [colmi_r02_client](https://github.com/tahnok/colmi_r02_client) (tahnok) | Python client for the Colmi R02 smart ring. | Confirms the exact same Nordic-UART service/characteristic UUIDs and 16-byte/checksum framing are used across this whole device family — this is one SDK ("QC Wireless"/PubuWear), not H59-specific. |

No command in this document was invented. Where a command exists in the
source protocol family but its effect on an actual H59 is unverified, it is
marked **EXPERIMENTAL**, not SUPPORTED.

## Device

- Hardware `H59_V2.0`, firmware `H59_2.00.14_...`, BLE name `H59_xxxx`. Chip: Nordic nRF52832.
- Official app: **QWatch Pro** (`com.qcwireless.qcwatch`, vendor QC Wireless / "Brandless"/"PubuWear").
- USB is charge-only — all data is over BLE.
- **Single master**: the band only maintains one BLE connection at a time. If a phone with QWatch Pro (or the H59 Health mobile app) is connected, nothing else can connect until it disconnects.

## Transport

| | UUID |
|---|---|
| Main service (Nordic UART) | `6e40fff0-b5a3-f393-e0a9-e50e24dcca9e` |
| Write (commands) | `6e400002-b5a3-f393-e0a9-e50e24dcca9e` |
| Notify (responses) | `6e400003-b5a3-f393-e0a9-e50e24dcca9e` |
| Big-data service ("bc" channel) | `de5bf728-d711-4e47-af26-65e3012a5dc7` |
| Big-data write | `de5bf72a-d711-4e47-af26-65e3012a5dc7` |
| Big-data notify | `de5bf729-d711-4e47-af26-65e3012a5dc7` |

**Main channel frame** — fixed 16 bytes: `[cmd(1)][payload(14)][checksum(1)]`,
`checksum = sum(bytes[0..14]) & 0xFF`. A response with `cmd | 0x80` set
signals an error/unsupported command.

**Big-data ("bc") frame** — variable length: `BC(0xBC)][type(1)][len(2, LE)][crc16-modbus(2, LE)][body(len)]`.
Notifications can arrive split across multiple BLE packets and must be
reassembled (see `packages/protocol/src/bcFrame.ts`). Reading from this
channel requires a login handshake first: send type `0x4A` with a UTF-16
(with BOM) encoded QWatch account username, then type `0x30` (init).

Implementation: [`packages/protocol`](../packages/protocol) — pure
TypeScript, zero BLE-library dependency, fully unit-tested against fixtures
derived from the verified examples below (see `packages/protocol/test`).

---

## SUPPORTED

Cross-validated against at least one source that was actually exercised
against real hardware (OpenH59) or a second independent implementation
(Gadgetbridge). "Supported" means "the request/response shape is confirmed
to be correct", not necessarily "confirmed on this exact H59 unit" — always
prefer live confirmation from `tools/ble-probe` where it matters.

| Command | Byte | Notes |
|---|---:|---|
| Set time | `0x01` | BCD payload; **response doubles as the capability bitmap** (see below). |
| Battery | `0x03` | Response: `byte[1]`=level %, `byte[2]`=charging. |
| HR history | `0x15` | Request = 4-byte LE local-midnight timestamp; 5-minute resolution, 288 slots/day. |
| HR log settings | `0x16` | `[2, enabled(1/2), intervalMin]` to write, `[1]` to read. |
| Stress history | `0x37` | Request `[day]`; 30-minute slots. |
| HRV history | `0x39` | Request `[day]`; 30-minute slots, value in ms. |
| Steps/cal/distance | `0x43` | Request `[day, 0x0f, 0x00, 0x5f, 0x01]`; 15-minute slots. |
| Realtime measurement | `0x69` | Start `[type, 1]`; types: 1=HR, 2=BP, 3=SpO2, 8=stress, 10=HRV. Response `[type, errCode, b3, b4, b5, ...]`. |
| Realtime stop | `0x6A` | `[type, 0, 0]`. |
| bc: SpO2 history | `0x2A` | Request `[(-day)&0xFF]`; response `[day] + 24 hourly (min,max) pairs`. Verified byte-for-byte against the app (hours 07→16 = 99,97,97,97,96,99,99,98,99,98). |
| bc: Sleep | `0x27` | Request `[0xFF, 0x01]` returns **every stored night in one blob** (device ignores the day parameter). Verified byte-for-byte against the app (night of 2026-06-14: light 352m, deep 90m, REM 63m, awake 2m, start 00:41). |
| Find device | `0x50` | `[0x55, 0xAA]`. Confirmed to exist and be wired to `supportsFindDevice()` in Gadgetbridge for this device family. **What it physically does on an H59 is EXPERIMENTAL — see below.** |
| Power off | `0x08` | `[0x01]`. Gadgetbridge-only source; not exercised against H59 by us. |
| Factory reset | `0xFF` | `[0x66, 0x66]`. Gadgetbridge-only source; **do not test casually**, not exercised against H59 by us. |
| Preferences (profile) | `0x0A` | Write user gender/age/height/weight/units. Gadgetbridge-only source. |
| Goals | `0x21` | Read/write step/calorie/distance/sleep goals. Gadgetbridge-only source. |
| BP history | `0x14` | **Confirmed to NOT respond.** The band has no real on-device blood-pressure history — QWatch Pro's "hourly" BP curve is synthesized app-side from sparse on-demand readings, not measured. H59 Health never fabricates this curve; see `docs/API.md` and the Health page's on-device disclosure. |

### Capability bitmap (response to `0x01`)

The device declares what it actually supports, independent of marketing:

```
byte[0]      == 1  -> temperature   (observed FALSE on all known units — sensor not present)
byte[3] & 2  != 0  -> SpO2
byte[3] & 4  != 0  -> blood pressure
byte[8]      == 1  -> sleep
byte[13] & 16 != 0 -> stress
byte[13] & 32 != 0 -> HRV
```

Always read this before assuming a feature exists — see `packages/protocol/src/capability.ts`.

---

## EXPERIMENTAL

Exists in the shared protocol family, has a concrete candidate command, but
is **not confirmed on a real H59**. Kept in
[`packages/protocol/src/experimental/`](../packages/protocol/src/experimental)
deliberately separated from the stable API, and never called automatically
by the product without the user having opted into a hardware test.

### Vibration — `experimentalFindDeviceOrVibrate()` (cmd `0x50`, payload `55 AA`)

- **What we know:** Gadgetbridge wires `CMD_FIND_DEVICE = 0x50` to `supportsFindDevice()` for the whole Colmi/Yawell family, and the H59 coordinator (PR #5039, unmerged) inherits it unchanged. On screenless *rings* in this same family, the equivalent "locate" behavior is an **LED blink** (see `colmi_r02_client`'s `CMD_BLINK_TWICE = 0x10`, a different, older-generation command byte) — rings have no vibration motor. The H59 is a **band**, which physically has a vibration motor (QWatch Pro's own alarm feature implies this).
- **What we don't know:** whether `0x50` triggers the vibration motor on an H59, blinks something else, does nothing, or is answered with an error bit.
- **How to test it:** `tools/ble-probe vibrate-test --address <ADDR>` — see `tools/ble-probe/README.md`. Takes under a minute.
- **Promotion rule:** once confirmed on a real H59, move this entry to SUPPORTED, rename the export to drop "experimental", and update `docs/SECURITY.md`'s and the product's "vibration: SI/NO" status.

### Native device alarm — UNKNOWN, not even a candidate yet

See the UNKNOWN section below — there is no candidate command to mark experimental.

---

## UNKNOWN

### Alarm

**No public source we found — OpenH59, Gadgetbridge, or colmi_r02_client — implements setting an alarm on this device family.** This was checked directly, not assumed:

- OpenH59 has zero write/control commands at all (pure read client).
- In Gadgetbridge's H59 PR #5039 discussion, a user asked for alarm support because "the original H59 app has this feature." A maintainer replied that alarms are **not implemented** and would require BLE sniffing to reverse-engineer, mentioning (without confirming) ATT handles `0x0010`/`0x0016` seen while probing.
- `colmi_r02_client`'s own `MYSTERIES.md` lists several unexplained packets but nothing alarm-shaped either.

Since QWatch Pro's UI does expose alarms, the firmware almost certainly
supports them — the gap is that nobody has published the command. This is
exactly the kind of gap `tools/ble-probe/snoop_diff.py` exists to close: it
diffs a baseline BLE capture against one taken while setting an alarm in
QWatch Pro to surface the new command byte. See
`tools/ble-probe/README.md` section 4 for the exact procedure.

**Until this is found, H59 Health implements alarms as local phone
notifications** (`Alarm.nativeDeviceAlarm = false` for every alarm created
today — see `packages/db/prisma/schema.prisma`). This works regardless of
the device and is the honest, guaranteed-correct default. The
`packages/protocol/src/experimental/alarm.ts` stub exists specifically so
whoever finds the real command has an obvious place to put it, with a
runtime guard (`throw`) preventing anyone from accidentally shipping a
guessed command.

### Notifications (call/SMS push to the device)

`CMD_NOTIFICATION = 0x73` exists, but every source that handles it
(Gadgetbridge) only treats it as **incoming**: the device telling the phone
"I have new sensor data, come sync it" (sub-types: new HR/SpO2/steps data,
battery level, live activity). No source sends `0x73` *to* the device to
push a notification onto it. Whether the H59 can even display/vibrate for
phone notifications is unknown — plausible given it likely has a vibration
motor, but unconfirmed. Not implemented in the product; a good next
`tools/ble-probe` experiment once vibration is confirmed.

### HRV real-time value

Real-time type 10 (HRV) is defined in `REALTIME_TYPE`, but per OpenH59's own
notes the value is **not** in `byte[3]` like the other real-time types — in
probing, `bytes[6:7]` grew like an accumulator instead. `packages/protocol`'s
`parseRealtimeFrame` deliberately never populates an HRV field for this
reason (see the code comment). HRV *history* (`0x39`) is unaffected and fully supported.

---

## Explicit verdicts (as requested)

- **VIBRATION_SUPPORTED:** `unknown` (strong experimental candidate: cmd `0x50`, payload `55 AA` — test with `tools/ble-probe vibrate-test`)
- **ALARM_SUPPORTED:** `unknown` (no candidate command found; requires a snoop-log capture — see `tools/ble-probe/README.md`)
- **NOTIFICATIONS_SUPPORTED (push to device):** `unknown` (no outgoing command found in any source)
- **"¿Puedo hacer vibrar el H59 desde mi propia app?"** → **NECESITA PRUEBA** (needs a hardware test — see `tools/ble-probe`)
