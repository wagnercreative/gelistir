# Gelistir

Premiere Pro'yu **Claude Code'a baglayan** bir MCP sunucusu. Chrome'a nasil
bagliyorsan Premiere'e de ayni sekilde: sohbet terminalde kalir, araclar
Premiere'in icinde kosar.

```bash
claude mcp add premiere -s user -- node /yol/gelistir/core/bin/gelistir-mcp.js
```

```
> premiere'de acik sequence'te ne var?

  premiere_get_sequence
  Ana sequence, 10:12. Tek video kanalinda 1 klip, iki ses kanali.

> sessizlikleri ve dolgu sozcuklerini kes

  media_transcribe        (whisper, ~40 sn)
  transcript_read         0-300 sn
  media_detect_silence    18 sessizlik, 2:14
  build_cut_plan          plan-1: 10:12 -> 8:03 (%21)
  premiere_apply_keeps    "Gelistir kurgu" - 34 parca

  Yeni sequence kurdum, orijinale dokunmadim. Atilanlar: 2:14 sessizlik,
  31 sn dolgu sozcugu, 4. dakikada iki tekrar cekim.
```

**Kurulum ve kullanim: [docs/claude-code.md](docs/claude-code.md)**

Premiere'in icinde de bir sohbet paneli var (Claude Code kullanmak
istemezsen) ve sohbetsiz tek tuslu bir akis. Ucu de ayni araclari kullanir.

---

## Baglanti nasil kuruluyor

Premiere **disaridan baglanti kabul edemez** - Chrome'un aksine bir hata
ayiklama portu yok. O yuzden yon tersine cevrildi: Premiere'in icindeki
panel cekirdege baglanip "bana is ver" diye bekliyor (uzun-yoklama).

```
Claude Code ──stdio──► gelistir-mcp ──HTTP──► gelistir cekirdegi
                                                    │
                                       uzun-yoklama │
                                                    ▼
                                          Premiere paneli (CEP)
                                          ExtendScript calistirir
```

**Panel acik olmadan Premiere araclari calismaz** - baglantinin kendisi o.
Panelde "Kopru acik - Claude Code kullanabilir" yaziyorsa hazir.

Premiere'in icine giren parca bir **CEP paneli**: Premiere icinde acilan bir
web sayfasi + ExtendScript ile projeye tam erisim. Bir Chrome eklentisi
Premiere'e erisemez (tarayici kum havuzunun disinda), bu yuzden
`chrome-extension/` yalniz YouTube Studio tarafinda kullaniliyor.

---

## Parcalar

```
                    ┌─────────────────────────────────────────┐
                    │  core/  (Node.js, senin bilgisayarinda) │
                    │                                          │
  Premiere ◄────────┤  • whisper ile dokum                     │
  paneli   HTTP     │  • ffmpeg ile sessizlik analizi          │
  (CEP)             │  • Claude ile kurgu karari + metinler    │
                    │  • ffmpeg ile kesim, gurluk, kodlama     │
  Chrome   ◄────────┤  • YouTube paketi (mp4 + srt + metinler) │
  eklentisi  HTTP   └─────────────────────────────────────────┘
```

- **`core/`** - isi yapan cekirdek: araclar, Premiere koprusu, boru hatti.
  MCP sunucusu (`bin/gelistir-mcp.js`) da burada. Tek basina da calisir:
  `gelistir run video.mp4` Premiere olmadan yayina hazir paket uretir.
- **`premiere-panel/`** - Premiere icindeki panel. Iki isi var: (1) komut
  calistirici - Claude Code'un istedigi ExtendScript'i kosturur, (2) kendi
  sohbet arayuzu (Claude Code kullanmak istemezsen).
- **`chrome-extension/`** - uretilen baslik/aciklama/bolum/etiketleri YouTube
  Studio formuna doldurur. **Yayinla dugmesine basmaz.**

Video, ses ve dokum senin makinende kalir. Claude'a giden tek sey **yazi
dokumu** (transkript) - goruntu veya ses dosyasi degil.

---

## Uc kullanim yolu

Ucu de ayni 17 araci ve ayni guvenlik kurallarini kullanir.

### 1. Claude Code (MCP) - ana yol

Sohbet terminalde, araclar Premiere'de. Kurulum ve ornekler:
**[docs/claude-code.md](docs/claude-code.md)**

### 2. Premiere panelindeki sohbet

Claude Code kullanmak istemezsen panelin kendi sohbeti var. Aradaki tek
fark izni kimin sordugu: MCP yolunda Claude Code, panelde cekirdek.
Ayrintilar: [docs/ajan.md](docs/ajan.md)

### 3. Tek tusla (sohbetsiz)

Sabit adimli akis; kararlari yapilandirma dosyasindaki esikler verir.
Kesimleri gozden gecirmek istemiyorsan en kisa yol. Panelde alttaki
"Tek tusla" bolumunde, ya da terminalden:

```bash
gelistir run cekim.mp4     # Premiere hic gerekmez
```

Her iki yolda da ayni boru hatti kosuyor:

1. **Dokum** - whisper ile kelime kelime zaman damgali transkript
2. **Sessizlik analizi** - `ffmpeg silencedetect` ile olu hava tespiti
3. **Kurgu karari** - sessizlik, dolgu sozcukleri ("eee", "yani"), tekrar
   cekimler, konusmacinin kendi duzelttigi hatali bilgiler
4. **Guvenlik budamasi** - kelime ortasindan kesilmez, 0.35 sn'den kisa parca
   birakilmaz, toplam surenin en fazla %35'i atilir, kesim noktalarina nefes
   payi birakilir
5. **Kesim** - Premiere zaman cizgisinde (yeni sequence olarak) ya da ffmpeg ile
6. **Altyazi** - kesilmis zaman cizgisine tasinmis `.srt`
7. **Ses** - iki gecisli `loudnorm` ile **-14 LUFS / -1 dBTP**
8. **Kodlama** - H.264 high / yuv420p / faststart, cozunurluge gore YouTube'un
   onerdigi bit hizi, AAC 384k 48kHz
9. **Metinler** - baslik adaylari, aciklama, etiketler, sabit yorum, kapak anlari
10. **Paket** - mp4, srt, kapak adaylari, `metadata.json`, `aciklama.txt`,
    `bolumler.txt` ve bir `rapor.md`

Bolumler (chapters) YouTube'un gercek kurallarina gore duzeltilir: ilki `0:00`,
en az 3 bolum, her bolum en az 10 saniye. Kurallar saglanamazsa bolum listesi
hic yazilmaz - yarim liste yazmaktan iyidir.

## Ne yapmiyor

Dürüst olmak gerekirse bunlar **elle** yapilacak isler:

- Renk duzenleme, LUT, grade
- Muzik, ses efekti, b-roll secimi ve yerlestirmesi
- Kapak gorseli tasarimi (sadece aday kareler cikarilir)
- Coklu kamera / coklu klip kurgusu (hizli akis tek kaynak dosya bekler;
  Premiere akisi zaman cizgisini sen kurdugun icin bu sinir yok)
- **Yayinlama.** Ne panel ne eklenti "Yayinla"ya basar. Gorunurluk, kapak ve
  yayin zamani senin kararin.

---

## Hizli baslangic

```bash
# 0. ffmpeg gerekli:  brew install ffmpeg  /  winget install Gyan.FFmpeg

cd core
npm install
node bin/gelistir.js doctor            # ffmpeg/whisper kontrolu

node bin/gelistir.js kurulum           # ne yapacagini gosterir
node bin/gelistir.js kurulum --uygula  # paneli yerine koyar, izni acar

claude mcp add premiere -s user -- node "$(pwd)/bin/gelistir-mcp.js"

# Premiere'i kapat-ac, sonra: Pencere > Uzantilar > Gelistir
# Panelde "Kopru acik - Claude Code kullanabilir" yaziyorsa hazir.
```

Windows'ta `kur.cmd` dosyasina cift tikla (cmd.exe'de `$(pwd)` calismaz).
macOS/Linux'ta `sh kur.sh`.

Adim adim: **[docs/claude-code.md](docs/claude-code.md)**

Premiere olmadan denemek icin (ANTHROPIC_API_KEY gerekir):

```bash
export ANTHROPIC_API_KEY=sk-ant-...
node bin/gelistir.js run ~/Videolar/cekim.mp4
```

Cikti `~/Videolar/cekim-youtube/` klasorune yazilir.

Premiere paneli ve Chrome eklentisi icin: **[docs/kurulum.md](docs/kurulum.md)**

### Gereksinimler

| Ne | Neden | Yoksa |
|---|---|---|
| Node.js 18.17+ | cekirdek | zorunlu |
| ffmpeg + ffprobe | analiz, kesim, kodlama | zorunlu |
| `ANTHROPIC_API_KEY` | panel sohbeti ve tek tusla akis | Claude Code (MCP) yolunda **gerekmez** |
| whisper (herhangi biri) | dokum | dolgu sozcugu temizligi, altyazi, bolumler ve metinler uretilemez |
| Premiere Pro 2021+ | panel | cekirdek yine de tek basina calisir |

whisper icin `whisper` (OpenAI CLI), `whisper-cli` / `whisper-cpp`
(whisper.cpp) destekleniyor. Hazir bir dokum de verebilirsin: `--srt dokum.srt`

---

## Komutlar

```bash
gelistir kurulum          # paneli yerine koy, PlayerDebugMode'u ac
gelistir-mcp              # MCP sunucusu (Claude Code bunu calistirir)
gelistir run <video>      # bastan sona: yayina hazir paket
gelistir plan <video>     # sadece dokum + kesim plani (panel bunu kullanir)
gelistir deliver <master> --state <job.json>   # Premiere master'ini paketle
gelistir serve            # panel ve eklentinin baglandigi yerel sunucu
gelistir doctor           # araclari kontrol et
gelistir config           # ayarlari goster / degistir
gelistir token            # yerel API token'ini yazdir
```

Sik kullanilan ayarlar:

```bash
gelistir config maxRemovedRatio=0.25   # en fazla %25'i at (varsayilan 0.35)
gelistir config minSilence=0.6         # 0.6 sn'den kisa sessizligi kesme
gelistir config targetLufs=-14         # YouTube gurluk hedefi
gelistir config removeOffTopic=true    # konu disi bolumleri de at (riskli)
```

Tam liste: `gelistir config` veya [core/src/config.js](core/src/config.js)

---

## Guvenlik

- **Izni kim sorar:** MCP yolunda Claude Code'un kendi izin sistemi
  (yikici araclar `destructiveHint` ile isaretli). Panel sohbetinde
  cekirdek, panelde onay karti gosterir.
- **Koddaki kurallar izinden bagimsiz:** kesim onerileri `build_cut_plan`'da
  budanir (kelime sinirina hizalama, nefes payi, en fazla %35 atma),
  `premiere_apply_keeps` orijinale dokunmaz, paket `private` isaretlenir.
- Yerel sunucu yalnizca `127.0.0.1`'e baglanir ve her istek icin
  `~/.gelistir/token` dosyasindaki token'i ister. Boylece tarayicida acik
  rastgele bir sayfa kurgu baslatamaz.
- `Host` basligi localhost degilse istek reddedilir (DNS rebinding korumasi).
- CORS yalnizca eklenti ve localhost kaynaklarina verilir.
- Chrome eklentisi sadece `studio.youtube.com` ve `127.0.0.1` adreslerine
  erisir; video dosyalarina hic dokunmaz.

---

## Test durumu

```bash
cd core && npm test     # 195 test
```

Kapsam:

- **Kesim plani matematigi** - birlestirme, nefes payi, butce siniri, kelime
  hizalama, zaman tasima
- **YouTube kurallari** - bolum/baslik/etiket/aciklama/altyazi sinirlari
- **ffmpeg** - arguman kurma ve cikti ayristirma (silencedetect, loudnorm, probe)
- **Claude istekleri** - sahte istemciyle istek sekli, sema, budama, reddedilen
  istek ve beta geri dusme davranisi
- **Ajan dongusu** - arac semalarinin gecerliligi, onay kapisi (izin/ret),
  arac sonuclarinin tek mesajda birlesmesi, cagri butcesi, baglam sizmasi
  (keeps listesi ve dokum modele dokulmuyor), kimlik hatasi cevirisi
- **Premiere koprusu** - komut kuyrugu, uzun-yoklama, zaman asimi,
  panel kopmasi, kuyruk doluluk siniri
- **MCP sunucusu** - arac listesi ve annotations, gercek bir MCP istemcisiyle
  (bellek uzerinden) arac cagirma, hata sozlesmesi, HTTP istemcisi
- **Canli MCP** - gercek `gelistir-mcp` sureci baslatilip Claude Code gibi
  stdio uzerinden konusuluyor: arac listesi, panel yoksa kurulum uyarisi,
  taklit panelin komutu calistirip sonucun modele donmesi
- **Cekirdek <-> panel sozlesmesi** - cagrilan her ExtendScript
  fonksiyonunun var oldugu, arguman sayilarinin imzalarla uyustugu ve
  `gelistir.jsx`in ES3 uyumlu kaldigi
- **Yerel sunucu** - token, CORS, DNS rebinding korumasi, girdi dogrulama
- **Uctan uca** - sahte ffmpeg/ffprobe betikleriyle dort tam boru hatti kosusu;
  paketin diske yazildigi, raporun dogru sayilari tasidigi ve eksik araclarin
  sessizce gecilmedigi dogrulaniyor

**Bu ortamda dogrulanmayan kisimlar:** gercek ffmpeg kodlamasi (uctan uca
testler sahte ikili kullaniyor - arguman dizileri dogrulandi, kodlama ciktisi
dogrulanmadi), whisper cagrilari ve Premiere ExtendScript tarafi. Bu yollar
dikkatle yazildi ama gercek bir kurulumda calistirilmadi; ilk denemeyi kisa bir
test videosuyla yapmani oneririm.

---

## Dokumanlar

- [docs/claude-code.md](docs/claude-code.md) - **MCP kurulumu**: Claude Code'dan Premiere'e baglanmak
- [docs/ajan.md](docs/ajan.md) - araclar, onay modeli, baglam yonetimi
- [docs/kurulum.md](docs/kurulum.md) - panel ve eklenti kurulumu, adim adim
- [docs/mimari.md](docs/mimari.md) - parcalar nasil konusuyor, neden boyle
- [docs/youtube-teslim.md](docs/youtube-teslim.md) - "yayina hazir" ne demek,
  hangi teknik hedefler tutuluyor
