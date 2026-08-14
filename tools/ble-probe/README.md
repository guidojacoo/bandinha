# H59 BLE probe — hardware research tool

This is a standalone research script, **separate from the H59 Health product**.
Its only job is to answer the open questions in [`../../docs/BLE_PROTOCOL.md`](../../docs/BLE_PROTOCOL.md)
against your real H59: can we make it vibrate, and can we find the native
alarm command. Run it on a computer with Bluetooth (the same kind of setup
OpenH59 requires — Python + `bleak`; macOS, Linux and Windows all supported
by `bleak`, unlike OpenH59 which is macOS-only because of extra CoreBluetooth
code this tool doesn't need).

## Setup

```bash
cd tools/ble-probe
python -m venv .venv
# macOS/Linux:
.venv/bin/pip install -r requirements.txt
# Windows:
.venv\Scripts\pip install -r requirements.txt
```

**Before every step below: wear the band, and turn your phone's Bluetooth OFF.**
The H59 only talks to one BLE master at a time — if QWatch Pro is still
connected on your phone, this tool will never find the device.

## 1. Find your band's address

```bash
python -m h59_probe scan
```

Look for a device named `H59_xxxx`. Copy its address (a MAC-like address on
Linux/Windows, a CoreBluetooth UUID on macOS).

## 2. Confirm the connection works + read real capabilities

```bash
python -m h59_probe capabilities --address <ADDRESS>
```

This prints exactly what your unit supports (SpO2, blood pressure, stress,
HRV, sleep, temperature) straight from the device's own bitmap — no
guessing — plus battery level. If this works, the BLE link itself is proven
end-to-end for your hardware.

## 3. The big question: can it vibrate?

```bash
python -m h59_probe vibrate-test --address <ADDRESS>
```

This sends the `find device` command (`0x50 0x55 0xAA`) that Gadgetbridge
uses for the ring/band family the H59 shares its protocol with — see
`docs/BLE_PROTOCOL.md` for exactly why this is the leading candidate.
**Watch and feel the band while it runs.** Then tell me (or write down)
one of:

- **Vibrated** — great, this becomes the "buzz now" / alarm trigger command.
- **Blinked an LED / beeped** but did not vibrate — it's a "find device"
  signal, not a vibration motor trigger; we'll need another command for
  vibration (or the H59 might not have a motor after all, contrary to what
  the QWatch Pro app implies).
- **Did nothing you could detect** — the command may not apply to this
  firmware; note the raw response frame (if any) printed by the tool.

## 4. Finding the native alarm command (needs a snoop-log capture)

No public project has found this command yet (see `docs/BLE_PROTOCOL.md`).
This needs comparing what QWatch Pro sends when you actually set an alarm
against a baseline of normal traffic:

1. On Android: Settings → About phone → tap "Build number" 7x to unlock
   Developer Options → enable **USB debugging** and **Bluetooth HCI snoop
   log** (level "Full", not "Filtered") → toggle Bluetooth off/on for a
   clean log.
2. Open QWatch Pro, let it connect, do nothing alarm-related for ~20s, then
   pull the log (`adb bugreport` or `adb pull /sdcard/btsnoop_hci.log`) —
   save it as `baseline.log`.
3. Turn the snoop log off and on again for a fresh capture. In QWatch Pro,
   open the alarm screen and set **one** alarm, nothing else. Pull the log
   again as `action.log`.
4. Run:
   ```bash
   python snoop_diff.py diff baseline.log action.log
   ```
   This prints every command byte that shows up in `action.log` but never in
   `baseline.log` — your candidates for the alarm-set command.
5. Once you have a candidate `cmd` byte and payload, test it safely:
   ```bash
   python -m h59_probe send-raw --address <ADDRESS> --cmd 0xNN --payload NN,NN,... \
       --i-understand-this-is-experimental
   ```
   Then check on the band/in QWatch Pro whether an alarm actually got set.

If `snoop_diff.py diff` finds nothing, the alarm command likely isn't a
16-byte main-channel frame — try `python snoop_diff.py dump action.log` and
look at the bc/big-data channel (handles matching `de5bf72a-...` /
`de5bf729-...`) or frames of a different length.

## Reporting back

Whatever you find — vibration works, doesn't work, or you found the alarm
command — write it into `docs/BLE_PROTOCOL.md` under the matching
SUPPORTED / EXPERIMENTAL / UNKNOWN section, with the exact bytes and what you
observed. That file is the single source of truth the rest of the app (the
`experimental/` folder in `packages/protocol`) is built to be promoted out
of once confirmed.

## Safety notes

- `capabilities`, `vibrate-test` and `watch` only ever send commands already
  confirmed to exist in this protocol family (even if their *effect* on H59
  specifically is unconfirmed).
- `send-raw` requires `--i-understand-this-is-experimental` on purpose. An
  unrecognized command byte should just be ignored or answered with an
  error bit (`cmd | 0x80`) by well-behaved firmware, but that isn't
  guaranteed for every byte — don't script a sweep of all 256 values.
- Nothing in this tool touches the internet. It only talks BLE to the address
  you give it.
