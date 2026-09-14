#!/bin/sh
# Gelistir cekirdegi - macOS / Linux
# Premiere paneli buna baglanir. Terminali acik tut.
cd "$(dirname "$0")/core"
echo "Gelistir cekirdegi baslatiliyor. Bu terminali acik tut."
echo
exec node bin/gelistir.js serve
