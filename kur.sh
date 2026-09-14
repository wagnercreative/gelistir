#!/bin/sh
# Gelistir - macOS / Linux kurulum betigi
# Kullanim: sh kur.sh
set -e

cd "$(dirname "$0")/core"

echo "=============================================="
echo " 1/3  Node paketleri kuruluyor"
echo "=============================================="
npm install

echo
echo "=============================================="
echo " 2/3  Gereksinimler kontrol ediliyor"
echo "=============================================="
node bin/gelistir.js doctor || true

echo
echo "=============================================="
echo " 3/3  Premiere paneli yerine konuyor"
echo "=============================================="
node bin/gelistir.js kurulum --uygula

echo
echo "Kurulum bitti. Iki sey kaldi:"
echo
echo "  1) Yukaridaki 'claude mcp add' komutunu kopyalayip yapistir."
echo "  2) Cekirdegi baslat ve terminali acik tut:  sh sunucu.sh"
echo
echo "Sonra Premiere Pro'yu kapat ve tekrar ac."
