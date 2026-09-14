# Mimari

## Neden Chrome eklentisi degil

Claude'un Chrome eklentisi tarayici sekmesinde calisir: DOM'u okur, tiklar,
yazar. Premiere Pro ise tarayicidan tamamen bagimsiz bir masaustu uygulamasi.
Arada ne bir DOM ne bir sekme var - yani eklentinin tutunacagi hicbir yer yok.

Premiere'e iceriden erisimin uc yolu var:

1. **CEP paneli** (bu proje) - Premiere icinde bir Chromium ornegi acar.
   Panelin JS'i `evalScript` ile ExtendScript calistirir; ExtendScript de
   projeye, sequence'lere, kliplere ve Media Encoder'a erisir. Node.js de
   acilabildigi icin panel yerel dosyalari okuyup HTTP istegi atabilir.
2. **UXP paneli** - CEP'in yeni nesli. Premiere'deki API yuzeyi henuz CEP
   kadar genis degil, ozellikle sequence duzenleme tarafinda.
3. **Harici otomasyon** - AppleScript / COM ile sinirli kontrol; zaman cizgisi
   duzenlemeye yetmez.

CEP paneli tercih edildi cunku tek yol boyunca hem zaman cizgisini kurabiliyor
hem de yerel Node sureciyle konusabiliyor.

---

## Parcalar ve sorumluluklar

```
┌───────────────────────┐        ┌──────────────────────────────────────┐
│ premiere-panel (CEP)  │        │ core (Node.js)                        │
│                       │        │                                       │
│ client/js/main.js ────┼─HTTP──►│ src/server.js   token + CORS + isler  │
│   akis mantigi        │        │       │                               │
│                       │        │       ▼                               │
│ host/gelistir.jsx     │        │ src/pipeline.js  10 adimli boru hatti │
│   evalScript ile      │        │       │                               │
│   zaman cizgisi       │        │  ┌────┴──────┬──────────┬───────────┐ │
└───────────────────────┘        │  ▼           ▼          ▼           ▼ │
                                 │ transcribe  ffmpeg   claude     youtube│
┌───────────────────────┐        │ (whisper)  (kesim,   (karar,   (kural, │
│ chrome-extension      │        │            gurluk,   metin)     srt,   │
│                       │─HTTP──►│            kodlama)             bolum) │
│ popup.js  metadata    │        │                  │                     │
│ content.js  Studio    │        │                  ▼                     │
└───────────────────────┘        │            src/cutplan.js              │
                                 │       modelin onerilerini budayan      │
                                 │            saf matematik               │
                                 └──────────────────────────────────────┘
```

### `core/src/` dosyalari

| Dosya | Sorumluluk | Saf mi |
|---|---|---|
| `config.js` | varsayilanlar, `~/.gelistir/config.json`, ortam degiskenleri | evet |
| `cutplan.js` | kesim plani matematigi: birlestirme, nefes payi, butce, kelime hizalama, zaman tasima | **evet** |
| `youtube.js` | YouTube kurallari: bolum, baslik, etiket, aciklama, SRT | **evet** |
| `ffmpeg.js` | arguman kurma + cikti ayristirma (saf), surec baslatma (degil) | kismen |
| `transcribe.js` | whisper bulma ve cikti bicimlerini normalize etme | kismen |
| `claude.js` | iki istem: kurgu karari ve YouTube metinleri (tek tusla akis) | hayir |
| `agent.js` | arac tanimlari, ajan dongusu, onay kapisi, cekirdek araclari | hayir |
| `pipeline.js` | 10 adimi sirala, paketi yaz | hayir |
| `server.js` | yerel HTTP, token, is kuyrugu, ajan oturumlari | hayir |

Saf olan dosyalar testlerin agirligini tasiyor. Mantik oraya toplandi ki
ffmpeg ve Premiere olmadan da dogrulanabilsin.

---

## Ajan dongusu

Sohbet modunda model surucu koltugunda. Ama araclar iki ayri yerde kosuyor:
cekirdek kendi araclarini hemen kosturur, Premiere araclarini panele dondurur.

```
kullanici mesaji
      │
      ▼
┌─────────────────────────────────────────────────────────────────┐
│ core/src/agent.js  drive()                                      │
│                                                                 │
│  1. modeli cagir (araclar + sistem istemi, onbellekli)          │
│  2. stop_reason "tool_use" degilse -> dur, yaniti gosterme       │
│  3. arac cagrilarini ayir:                                      │
│       onay gerekiyor ve karar yok -> awaiting_approval, DUR      │
│       onay reddedildi            -> is_error sonucu uret        │
│       executor "core"            -> BURADA kostur               │
│       executor "host"            -> panele dondur, DUR          │
│  4. tum sonuclar hazir -> TEK user mesajinda gonder, 1'e don     │
└─────────────────────────────────────────────────────────────────┘
      │                            ▲
      │ awaiting_tools             │ POST /agent/sessions/:id/tool-results
      ▼                            │
┌─────────────────────────────────────────────────────────────────┐
│ premiere-panel  client/js/agent.js                              │
│   pendingHost[] -> her biri icin evalScript(fn, args)           │
│   ham JSON metnini toplayip cekirdege geri gonder               │
└─────────────────────────────────────────────────────────────────┘
```

Onemli ayrintilar:

- **Bir asistan mesajinin tum `tool_result` bloklari tek bir user mesajinda
  gider.** Bolerek gondermek modeli paralel arac cagirmaktan vazgecirir.
- **Panel turu cagri butcesini sifirlamaz.** Butce (`maxModelCalls`, 64)
  kullanicinin mesaji basina. Yoksa "host araci -> sonuc -> host araci"
  dongusu hic bitmez.
- **HTTP istegi beklenmez.** Bir tur dakikalar surebilir (whisper, kodlama,
  model dusunme suresi), bu yuzden `POST .../message` hemen doner ve panel
  `GET /agent/sessions/:id` ile durumu yoklar.
- **Plan modele dokulmez.** `build_cut_plan` keeps listesini oturumda tutar,
  modele sadece `planId` verir. `premiere_apply_keeps` o planId ile
  cagrildiginda `hostArgs` keeps metnini oturumdan alir.

### Panel ile ExtendScript arasindaki sozlesme

`host/gelistir.jsx` her fonksiyondan JSON metni donduruyor:
`{"ok":true,...}` veya `{"ok":false,"error":"..."}`.

ExtendScript'te `JSON` nesnesi her Premiere surumunde yok, bu yuzden jsx'in
kendi stringifier'i var (`gsJson`). **Ayristirma tarafi bilerek yok:** girdiler
duz konumsal arguman olarak geciyor. Model uretimi bir metni jsx icinde
`eval` etmek, Premiere'in icinde kod calistirmak demek olurdu.

Ayni sebeple jsx ES3 uyumlu kalmak zorunda (let/const/arrow/sablon literal
yok). `core/test/bridge.test.js` bunu ve fonksiyon adlari/arguman sayilarinin
uyustugunu dogruluyor - Premiere olmadan kurabilecegimiz en yakin guvence bu.

---

## Veri akisi: bir isin hayati

### Hizli akis (`mode: "full"`)

```
video.mp4
  │
  ├─► ffprobe ──────────────► sure, cozunurluk, fps
  ├─► ffmpeg ───────────────► 16 kHz mono wav
  │      └─► whisper ───────► dokum (kelime zaman damgalari)
  ├─► ffmpeg silencedetect ─► sessizlik araliklari
  │
  ├─► Claude (planEdit) ────► atilacak araliklar + bolumler + uyarilar
  │                            ▲ dokum + sessizlik listesi gider
  │                            ▲ video/ses GITMEZ
  │
  ├─► cutplan.buildCutPlan ─► keeps[]  ◄── burada budama yapilir
  │
  ├─► youtube.buildSrtCues ─► .srt (keeps'e tasinmis zamanlarla)
  ├─► ffmpeg loudnorm olcum ► measured_I, measured_TP
  ├─► ffmpeg tek gecis ─────► kes + normalize + kodla = final .mp4
  ├─► Claude (writeMetadata)► baslik, aciklama, etiket, kapak anlari
  └─► paket klasoru
```

Dikkat: gurluk olcumu **kesimden sonraki** ses uzerinde yapiliyor. Atilan
sessizlikler ortalamayi asagi ceker; once kesip sonra olcmek dogru sonucu verir.
Olcum ve kodlama ayni filtre zincirini paylasir, bu yuzden iki ffmpeg gecisi
yeterli - ara master dosyasi yazilmiyor.

### Premiere akisi

```
1) plan     : panel ──► core (mode: plan)
              core dokum + kesim planini uretir, job.json yazar
              panel keeps listesini alir

2) uygula   : panel ──► ExtendScript (gelistirApplyCutPlan)
              yeni sequence olusturulur, tutulacak parcalar sirayla yerlestirilir
              ORIJINAL SEQUENCE'E DOKUNULMAZ
              (burada elle duzeltme yapabilirsin)

3) master   : panel ──► ExtendScript (gelistirExportSequence)
              Media Encoder master.mp4 uretir
              panel dosya boyutu sabitlenene kadar bekler

4) paketle  : panel ──► core (mode: deliver, stateFile: job.json)
              altyazi + gurluk + kodlama + metinler + paket
```

`deliver` adimi `job.json` icindeki dokumu ve `keeps` listesini kullanarak
altyaziyi dogru zamanlara oturtuyor. Master'in suresi plandaki cikti suresinden
1 saniyeden fazla saparsa rapora uyari yazilir - bu genelde zaman cizgisini elle
degistirdigin anlamina gelir.

---

## Modelin onerileri nasil budaniyor

`claude.js` modelden `{start, end, kind, reason, confidence}` listesi alir.
Bu liste dogrudan kullanilmaz. `cutplan.buildCutPlan` sirayla sunlari yapar:

1. **Normalize** - kaynak suresine kirp, ust uste binenleri birlestir
2. **Nefes payi** - her araligi basindan `padHead`, sonundan `padTail` kadar
   dar tut (varsayilan 0.08 / 0.12 sn). Kesim noktalari boylece soluk almaya
   yer birakir
3. **Kelime hizalama** - dokumda kelime zamani varsa araligi kelime sinirina
   cek; kelime ortasindan kesilmez
4. **Butce** - toplam atilan sure `maxRemovedRatio`yu (varsayilan %35) gecemez.
   Guveni yuksek oneriler once alinir, butce dolunca kalani reddedilir ve
   rapora yazilir
5. **Birlestirme** - iki parca arasindaki bosluk `mergeGap`ten (0.12 sn)
   kucukse o kesim hic yapilmaz
6. **Kisa parca temizligi** - `minKeepSegment`ten (0.35 sn) kisa parcalar
   atilir; aksi halde duyulur bir tik olusur
7. **Guvenlik agi** - her sey atilmissa kaynak oldugu gibi tutulur

Model ayrica pencere disi, negatif veya sureyi asan zaman uretirse `claude.js`
bunlari daha en basta duser. `removeOffTopic` kapaliysa konu disi onerileri
hic kabul edilmez.

Sonuc: modelin karari kurguyu **secer**, ama sinirlari kod koyar.

---

## Uzun dokumler

Bir saatlik konusma yaklasik 60-80 bin karakterlik dokum demek. `chunkSegments`
dokumu 120 bin karakterlik pencerelere boler ve her pencere icin ayri bir plan
istegi atar. Kirpma yapilmaz - pencereler bolunur ve sonuclar birlestirilir.
Zaman damgalari mutlak oldugu icin birlestirme sorunsuz.

Her istek `output_config.format` ile JSON semasina baglidir ve sistem istemi
`cache_control` ile onbellege alinir; cok pencereli isler icin bu onemli bir
tasarruf.

---

## Neden `keeps` listesi, `removals` degil

Hem Premiere hem ffmpeg tarafi "tutulacak parcalar" listesiyle calisir:

- ffmpeg: her parca icin `trim`/`atrim` + tek `concat`
- Premiere: her parca icin `setInPoint`/`setOutPoint` + `overwriteClip`

Ayni liste, ayni sonuc. Zaman tasima (`remapTime`, `projectRange`) da bu listenin
uzerinde tanimli - altyazi ve bolum zamanlarini cikti cizgisine tasimak icin
kullaniliyor. Tek bir dogruluk kaynagi olmasi iki tarafin uyusmasini garanti
ediyor.
