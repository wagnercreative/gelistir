# Gelistir

Premiere Pro icinde Claude ile kurgu yapip videoyu **YouTube'a yuklenmeye hazir**
halde cikaran uc parcali bir sistem.

---

## Kisa cevap: Chrome eklentisi Premiere'i kontrol edemez

Claude'un Chrome eklentisi **tarayici sekmeleri** uzerinde calisir: sayfayi okur,
tiklar, form doldurur. Premiere Pro ise masaustu uygulamasi ve tarayicinin
kum havuzunun tamamen disinda. Yani bir Chrome eklentisi Premiere'in zaman
cizgisini goremez, klip kesemez, export baslatamaz. Bu bir izin ayari degil,
mimari bir sinir.

Premiere'in **kendi** eklenti sistemi var ve istedigin sey oradan yapilir:

| Eklenti turu | Ne yapar | Bu projede |
|---|---|---|
| **CEP paneli** | Premiere icinde acilan bir web paneli (HTML/JS) + ExtendScript ile projeye tam erisim | `premiere-panel/` - kullandigimiz yol |
| UXP paneli | CEP'in yeni nesli; Premiere'de API yuzeyi henuz daha sinirli | ileride gecis |
| Chrome eklentisi | Sadece tarayici. Premiere'e erisemez | `chrome-extension/` - yalniz YouTube Studio tarafi |

Dolayisiyla "Claude Chrome eklentisi gibi bir sey" sorusunun cevabi: **evet,
mumkun - ama Chrome eklentisi olarak degil, Premiere paneli olarak.** Bu repo
onu kuruyor.

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

- **`core/`** - isi yapan cekirdek. Tek basina da calisir: `gelistir run video.mp4`
  Premiere olmadan yayina hazir paket uretir.
- **`premiere-panel/`** - Premiere icindeki panel. Kesimleri gercek zaman
  cizgisine uygular; boylece kurguyu elle duzeltebilirsin.
- **`chrome-extension/`** - uretilen baslik/aciklama/bolum/etiketleri YouTube
  Studio formuna doldurur. **Yayinla dugmesine basmaz.**

Video, ses ve dokum senin makinende kalir. Claude'a giden tek sey **yazi
dokumu** (transkript) - goruntu veya ses dosyasi degil.

---

## Ne yapiyor

Kaynak cekimden yayina hazir pakete kadar:

1. **Dokum** - whisper ile kelime kelime zaman damgali transkript
2. **Sessizlik analizi** - `ffmpeg silencedetect` ile olu hava tespiti
3. **Kurgu karari** - Claude dokumu okuyup atilacak yerleri isaretler:
   sessizlik, dolgu sozcukleri ("eee", "yani"), tekrar cekimler, kendi
   duzelttigi hatali bilgiler
4. **Guvenlik budamasi** - modelin onerileri sabit kurallardan gecer:
   kelime ortasindan kesilmez, 0.35 sn'den kisa parca birakilmaz, toplam surenin
   en fazla %35'i atilir, kesim noktalarina nefes payi birakilir
5. **Kesim** - ya Premiere zaman cizgisinde (yeni sequence olarak) ya da ffmpeg ile
6. **Altyazi** - kesilmis zaman cizgisine tasinmis `.srt` (satir uzunlugu,
   sure ve cakisma kurallariyla)
7. **Ses** - iki gecisli `loudnorm` ile **-14 LUFS / -1 dBTP** (YouTube hedefi)
8. **Kodlama** - H.264 high / yuv420p / faststart, cozunurluge gore YouTube'un
   onerdigi bit hizi, AAC 384k 48kHz
9. **Metinler** - Claude baslik adaylari, aciklama, etiketler, sabit yorum ve
   kapak icin uygun anlari yazar
10. **Paket** - klasore mp4, srt, kapak adaylari, `metadata.json`,
    `aciklama.txt`, `bolumler.txt` ve bir `rapor.md` yazilir

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
cd core && npm test     # 107 test
```

Kapsam:

- **Kesim plani matematigi** - birlestirme, nefes payi, butce siniri, kelime
  hizalama, zaman tasima
- **YouTube kurallari** - bolum/baslik/etiket/aciklama/altyazi sinirlari
- **ffmpeg** - arguman kurma ve cikti ayristirma (silencedetect, loudnorm, probe)
- **Claude istekleri** - sahte istemciyle istek sekli, sema, budama, reddedilen
  istek ve beta geri dusme davranisi
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

- [docs/kurulum.md](docs/kurulum.md) - panel ve eklenti kurulumu, adim adim
- [docs/mimari.md](docs/mimari.md) - parcalar nasil konusuyor, neden boyle
- [docs/youtube-teslim.md](docs/youtube-teslim.md) - "yayina hazir" ne demek,
  hangi teknik hedefler tutuluyor
