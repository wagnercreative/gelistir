# Gelistir

Premiere Pro icinde **sohbet ederek** kurgu yapmani saglayan bir eklenti.
Ne istedigini yazarsin; ajan zaman cizgisine bakar, dokumu okur, kesimi yapar
ve videoyu YouTube'a yuklenmeye hazir hale getirir.

```
Sen:   Sessizlikleri ve dolgu sozcuklerini kes
Ajan:  ⚙ zaman cizgisini okuyor
Ajan:  ⚙ konusmayi yaziya ceviriyor
Ajan:  41 yerde kesim buldum: 2:14 sessizlik, 38 sn dolgu sozcugu, iki
       tekrar cekim. 12:03 -> 9:31 (%21 kisaliyor). Uygulayayim mi?
Sen:   uygula
Ajan:  "Gelistir - cekim" adiyla yeni bir sequence kurdum, 42 parca.
       Orijinal sequence'e dokunmadim.
```

Yikici bir sey yapmadan once izin ister. Kesim onerileri koddaki guvenlik
kurallarindan gecer. Yayinlama dugmesine basmaz.

**Ajan modunun tamami: [docs/ajan.md](docs/ajan.md)**

---

## Neden Premiere eklentisi, Chrome eklentisi degil

Claude'un Chrome eklentisi **tarayici sekmeleri** uzerinde calisir. Premiere
Pro masaustu uygulamasi ve tarayicinin kum havuzunun tamamen disinda; bir
Chrome eklentisi Premiere'in zaman cizgisini goremez, klip kesemez, export
baslatamaz. Bu bir izin ayari degil, mimari bir sinir.

Ama **ayni deneyim** Premiere'in kendi eklenti sistemiyle kurulabiliyor:

| Eklenti turu | Ne yapar | Bu projede |
|---|---|---|
| **CEP paneli** | Premiere icinde acilan web paneli (HTML/JS) + ExtendScript ile projeye tam erisim | `premiere-panel/` - kullandigimiz yol |
| UXP paneli | CEP'in yeni nesli; Premiere'de API yuzeyi henuz daha sinirli | ileride gecis |
| Chrome eklentisi | Sadece tarayici. Premiere'e erisemez | `chrome-extension/` - yalniz YouTube Studio tarafi |

Yani panel, Chrome eklentisinin tarayicida yaptigi seyi Premiere'de yapiyor:
sohbet + arac cagirma + onay isteme.

---

## Uc parca

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

- **`core/`** - isi yapan cekirdek. Ajan dongusunu (model <-> arac) surduren
  taraf da burada. Tek basina da calisir: `gelistir run video.mp4` Premiere
  olmadan yayina hazir paket uretir.
- **`premiere-panel/`** - Premiere icindeki panel. Sohbet arayuzu ve
  ExtendScript tarafi; ajanin Premiere araclarini bu panel calistirir.
- **`chrome-extension/`** - uretilen baslik/aciklama/bolum/etiketleri YouTube
  Studio formuna doldurur. **Yayinla dugmesine basmaz.**

Video, ses ve dokum senin makinende kalir. Claude'a giden tek sey **yazi
dokumu** (transkript) - goruntu veya ses dosyasi degil.

---

## Iki kullanim yolu

### 1. Sohbet (ana yol)

Panelde yazarsin, ajan yapar. Elinde 17 arac var: zaman cizgisini okuma,
dokum cikarma, sessizlik analizi, kesim plani kurma, kesimleri uygulama,
klip devre disi birakma/silme/kirpma, kazanc ayari, marker koyma, Media
Encoder'a gonderme, yayina hazir paketi yazma.

Arac listesi, onay modeli ve baglam yonetimi: [docs/ajan.md](docs/ajan.md)

### 2. Tek tusla (sohbetsiz)

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
# 1. Cekirdek
cd core
npm install
export ANTHROPIC_API_KEY=sk-ant-...

# 2. Gereksinimleri kontrol et
node bin/gelistir.js doctor

# 3. Premiere olmadan dene
node bin/gelistir.js run ~/Videolar/cekim.mp4

# 4. Sohbet icin sunucuyu baslat (panel buna baglanir)
node bin/gelistir.js serve
```

Cikti `~/Videolar/cekim-youtube/` klasorune yazilir.

Premiere paneli ve Chrome eklentisi icin: **[docs/kurulum.md](docs/kurulum.md)**

### Gereksinimler

| Ne | Neden | Yoksa |
|---|---|---|
| Node.js 18.17+ | cekirdek | zorunlu |
| ffmpeg + ffprobe | analiz, kesim, kodlama | zorunlu |
| `ANTHROPIC_API_KEY` | kurgu karari ve metinler | sadece sessizlik kesimi yapilir |
| whisper (herhangi biri) | dokum | dolgu sozcugu temizligi, altyazi, bolumler ve metinler uretilemez |
| Premiere Pro 2021+ | panel | cekirdek yine de tek basina calisir |

whisper icin `whisper` (OpenAI CLI), `whisper-cli` / `whisper-cpp`
(whisper.cpp) destekleniyor. Hazir bir dokum de verebilirsin: `--srt dokum.srt`

---

## Komutlar

```bash
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
cd core && npm test     # 148 test
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
- **Cekirdek <-> panel sozlesmesi** - ajanin cagirdigi her ExtendScript
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

- [docs/ajan.md](docs/ajan.md) - sohbet modu: ne diyebilirsin, araclar, onay modeli
- [docs/kurulum.md](docs/kurulum.md) - panel ve eklenti kurulumu, adim adim
- [docs/mimari.md](docs/mimari.md) - parcalar nasil konusuyor, neden boyle
- [docs/youtube-teslim.md](docs/youtube-teslim.md) - "yayina hazir" ne demek,
  hangi teknik hedefler tutuluyor
