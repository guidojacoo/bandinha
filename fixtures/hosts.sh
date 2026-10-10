#!/usr/bin/env bash
#
# Points the fixture domains at localhost.
#
# The fixture web uses names in `.test`, which RFC 2606 reserves precisely so
# it can never collide with a real domain. They still need to resolve, so this
# adds them to /etc/hosts. Run it once; it is idempotent and prints what it
# changed.
#
#   sudo npm run fixtures:hosts          # add
#   sudo npm run fixtures:hosts remove   # take them back out
set -euo pipefail

HOSTS_FILE="${HOSTS_FILE:-/etc/hosts}"
MARKER="# mercurio-fixtures"
DOMAINS=(
  northwind.test
  fableworks.test
  meridianpay.test
  atlasgrid.test
  quaypoint.test
  harborstack.test
  burnrate.test
  tinycrew.test
  opaque.test
  noreply.test
)

if [[ "${1:-add}" == "remove" ]]; then
  if grep -q "$MARKER" "$HOSTS_FILE"; then
    sed -i.mercurio-bak "/$MARKER/d" "$HOSTS_FILE"
    echo "Removed ${#DOMAINS[@]} fixture hosts from $HOSTS_FILE."
  else
    echo "No fixture hosts in $HOSTS_FILE."
  fi
  exit 0
fi

added=0
for domain in "${DOMAINS[@]}"; do
  if grep -qE "^[^#]*[[:space:]]$domain([[:space:]]|$)" "$HOSTS_FILE"; then
    continue
  fi
  printf '127.0.0.1\t%s\t%s\n' "$domain" "$MARKER" >> "$HOSTS_FILE"
  added=$((added + 1))
done

if [[ $added -eq 0 ]]; then
  echo "All ${#DOMAINS[@]} fixture hosts already in $HOSTS_FILE."
else
  echo "Added $added fixture host(s) to $HOSTS_FILE."
fi
