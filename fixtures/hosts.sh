#!/usr/bin/env bash
# Maps the fixture hostnames to 127.0.0.1 so the crawler resolves them for
# real. Idempotent; safe to re-run.
set -euo pipefail
HOSTS="northwind.test devopsdirectory.test hoverboard.test meridianpay.test lumen-grid.test northgate-health.test atlasfreight.test sloscope.test tinybakery.test quietleaf.test"
MARKER="# rainmaker-fixtures"
if grep -q "$MARKER" /etc/hosts 2>/dev/null; then
  echo "Fixture hosts already present in /etc/hosts"
else
  printf '\n%s\n127.0.0.1 %s\n' "$MARKER" "$HOSTS" >> /etc/hosts
  echo "Added fixture hosts to /etc/hosts"
fi
