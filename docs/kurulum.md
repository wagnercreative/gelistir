# Kurulum

Uc parca var ve sirayla kurulmasi gerekiyor: once cekirdek, sonra Premiere
paneli, en son Chrome eklentisi.

---

## 1. Cekirdek (zorunlu)

### ffmpeg

Kesim, gurluk ve kodlamanin tamami ffmpeg ile yapiliyor.

```bash
# macOS
brew install ffmpeg

# Windows (winget)
winget install Gyan.FFmpeg

# Debian / Ubuntu
sudo apt install ffmpeg
```

`ffmpeg -version` ve `ffprobe -version` calismali. PATH'e eklemek istemezsen
yollari ayarla:

```bash
gelistir config ffmpeg=/opt/ffmpeg/bin/ffmpeg ffprobe=/opt/ffmpeg/bin/ffprobe
```

### whisper (onerilir)

Dokum olmadan sistem yalniz sessizlik kesimi yapar: dolgu sozcugu temizligi,
altyazi, bolumler ve YouTube metinleri uretilemez. Uc secenek:

**A) whisper.cpp** - hizli, GPU gerekmez

```bash
brew install whisper-cpp
# model dosyasini indir (orta boy, Turkce icin yeterli)
curl -L -o ~/ggml-medium.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin
gelistir config whisper=whisper-cli whisperModel=~/ggml-medium.bin
```

**B) OpenAI whisper CLI** - kelime bazli zaman damgasi verir (kesim hassasiyeti
daha iyi)

```bash
pipx install openai-whisper
gelistir config whisper=whisper whisperModel=medium
```

**C) Hazir dokum** - kendi `.srt` dosyani ver

```bash
gelistir run cekim.mp4 --srt cekim.srt
```

### Node paketleri ve API anahtari

```bash
cd core
npm install
export ANTHROPIC_API_KEY=sk-ant-...   # kalici olmasi icin shell profiline ekle
```

Kontrol:

```bash
node bin/gelistir.js doctor
```

Cikti soyle gorunmeli:

```
  OK    ffmpeg (ffmpeg version 7.1 ...)
  OK    ffprobe (ffprobe version 7.1 ...)
  OK    whisper (whisper-cli)
  OK    ANTHROPIC_API_KEY (ayarli)
```

### Global komut (istege bagli)

```bash
cd core && npm link      # artik her yerde `gelistir` yazabilirsin
```

---

## 2. Premiere paneli

### a) Imzasiz panellere izin ver

CEP panelleri normalde Adobe imzasi ister. Gelistirme modunu acmak gerekiyor -
bu tek seferlik bir islem.

**macOS:**
```bash
defaults write com.adobe.CSXS.11 PlayerDebugMode 1
defaults write com.adobe.CSXS.12 PlayerDebugMode 1
```

**Windows** (regedit veya PowerShell):
```powershell
New-ItemProperty -Path "HKCU:\Software\Adobe\CSXS.11" -Name PlayerDebugMode -Value 1 -PropertyType String -Force
New-ItemProperty -Path "HKCU:\Software\Adobe\CSXS.12" -Name PlayerDebugMode -Value 1 -PropertyType String -Force
```

> Premiere'in surumune gore CSXS numarasi degisir. Emin degilsen 9'dan 12'ye
> kadar hepsini ayarla; fazlasi zarar vermez.

### b) Paneli yerine kopyala

`premiere-panel/` klasorunun tamamini asagidaki dizine **`com.gelistir.premiere`**
adiyla kopyala:

**macOS:**
```
~/Library/Application Support/Adobe/CEP/extensions/com.gelistir.premiere
```

**Windows:**
```
%APPDATA%\Adobe\CEP\extensions\com.gelistir.premiere
```

Kopyalamak yerine sembolik baglanti da kurabilirsin (gelistirme icin daha rahat):

```bash
ln -s "$(pwd)/premiere-panel" \
  "$HOME/Library/Application Support/Adobe/CEP/extensions/com.gelistir.premiere"
```

### c) Sunucuyu baslat ve paneli ac

```bash
gelistir serve
```

Ekrana port ve token yazilir. Sonra Premiere'de:

**Pencere > Uzantilar > Gelistir - YouTube kurgu**

Panel acildiginda ust kisimda iki yesil satir gormelisin: Premiere baglantisi ve
cekirdek baglantisi. Token'i panel `~/.gelistir/token` dosyasindan kendi okur.

### d) Export preset (.epr)

Premiere akisinda master dosyayi Media Encoder aliyor ve bunun icin bir preset
gerekiyor. Premiere'de:

1. **Dosya > Disa Aktar > Medya**
2. Format: **H.264**, Preset: **Match Source - High bitrate** (veya YouTube 1080p)
3. Preset adinin yanindaki kaydet ikonuna bas, bir `.epr` olarak kaydet
4. Panelde **Preset sec (.epr)** dugmesiyle bu dosyayi sec

Master yuksek kaliteli ara dosyadir; YouTube icin son kodlama ve gurluk ayari
cekirdekte yapilir. Bu yuzden preset'te kaliteyi kismamak daha iyi.

---

## 3. Chrome eklentisi (istege bagli)

Sadece YouTube Studio formunu doldurmak icin. Kurgu ile ilgisi yok.

1. Chrome'da `chrome://extensions` adresini ac
2. Sag ustten **Gelistirici modu**nu ac
3. **Paketlenmemis ogeyi yukle** > `chrome-extension/` klasorunu sec
4. Eklentinin **Ayarlar** sayfasini ac
5. Port (varsayilan 8787) ve token'i gir:

```bash
gelistir token     # token'i yazdirir
```

Kullanimi:

1. Videoyu YouTube Studio'ya yukle (dosyayi surukle)
2. Yukleme formu acilinca eklenti simgesine bas
3. **Son isi getir** > **Studio alanlarini doldur**
4. Baslik, aciklama (bolumler dahil) ve etiketler dolar
5. Kalani sen yaparsin: kapak, gorunurluk, yayinla

> Etiket alani formda kapali olabilir. Studio'da **Tumunu goster**e basip
> tekrar dene.

---

## Sorun giderme

**Panel menude gorunmuyor**
PlayerDebugMode ayarlanmadi ya da klasor adi yanlis. Klasor adi tam olarak
`com.gelistir.premiere` olmali ve icinde `CSXS/manifest.xml` bulunmali.
Ayardan sonra Premiere'i tamamen kapatip ac.

**Panel "Cekirdege ulasilamadi" diyor**
`gelistir serve` calismiyor. Baska bir terminalde baslat ve panelde
**Yeniden bagla**ya bas.

**Panel "Token gecersiz" diyor**
Panel token dosyasini okuyamamis. `gelistir token` cikisini kopyalayip panelin
ust kismindaki token alanina yapistir.

**"ExtendScript calistirilamadi"**
Panel Premiere disinda (ornegin tarayicida) acilmis, ya da `host/gelistir.jsx`
kopyalanmamis. Klasorun tamamini kopyaladigindan emin ol.

**Media Encoder baslamiyor**
Adobe Media Encoder kurulu olmali ve Premiere ile ayni surum olmali. Panel
kuyruga gonderir; kodlamayi Media Encoder yapar.

**Kesimler cok agresif**
```bash
gelistir config maxRemovedRatio=0.2 minSilence=0.7 removeFillers=false
```

**Kesimler cok yumusak**
```bash
gelistir config maxRemovedRatio=0.45 minSilence=0.35 silenceThresholdDb=-30
```

**Panelde hata ayiklama**
Panel acikken tarayicidan `http://localhost:8099` adresine git - Chrome
DevTools ile panelin konsoluna bakabilirsin.
