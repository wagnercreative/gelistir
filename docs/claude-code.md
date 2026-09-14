# Claude Code'dan Premiere Pro'ya baglanmak

Chrome'a nasil bagliyorsan Premiere'e de ayni sekilde: bir MCP sunucusu
ekliyorsun, sohbet terminalde kaliyor, araclar Premiere'in icinde kosuyor.

```
Claude Code ──stdio──► gelistir-mcp ──HTTP──► gelistir cekirdegi
                                                    │
                                       uzun-yoklama │
                                                    ▼
                                          Premiere paneli (CEP)
                                          ExtendScript calistirir
```

Premiere disaridan baglanti kabul edemez, o yuzden yon tersine cevrildi:
Premiere icindeki panel cekirdege baglanip "bana is ver" diye bekliyor.
**Panel acik olmadan Premiere araclari calismaz** - baglantinin kendisi o.

---

## Kurulum

> **Windows kullanicisiysan:** bu bolumdeki komutlar bash icin. cmd.exe'de
> `$(pwd)` calismaz ve `#` ile baslayan satirlar komut sanilir. Windows icin
> hazir betik var, [asagidaki bolume](#windows-cmdexe) bak.

> **API anahtari gerekmez.** Bu yolda model Claude Code'un kendi oturumu;
> `ANTHROPIC_API_KEY` yalnizca panelin kendi sohbeti ve `gelistir run`
> komutu icin gerekiyor. `gelistir doctor` anahtari "istege bagli" olarak
> isaretler, eksik olmasi sorun degil.

### 1. ffmpeg (zorunlu)

```bash
brew install ffmpeg              # macOS
winget install Gyan.FFmpeg       # Windows
```

whisper onerilir (dokum olmadan sadece sessizlik kesimi yapilir) -
secenekler: [kurulum.md](kurulum.md#whisper-onerilir)

### 2. Depoyu al ve paketleri kur

```bash
git clone https://github.com/wagnercreative/gelistir.git
cd gelistir/core
npm install
node bin/gelistir.js doctor      # ffmpeg/whisper kontrolu
```

### 3. Paneli yerine koy

Bu adim iki sey yapar: panel klasorunu Adobe'un CEP uzanti dizinine baglar
ve imzasiz panellere izin veren `PlayerDebugMode` ayarini yazar. Once ne
yapacagini gosterir:

```bash
node bin/gelistir.js kurulum
```

Plani begenirsen uygula:

```bash
node bin/gelistir.js kurulum --uygula
```

Elle yapmak istersen adimlar: [kurulum.md](kurulum.md#2-premiere-paneli)

> Windows'ta sembolik baglanti yonetici hakki ister, o yuzden orada
> varsayilan kopyalamadir. `git pull` sonrasi `kurulum --uygula`'yi tekrar
> calistir. macOS'ta baglanti kurulur, guncelleme kendiliginden gecer.

### 4. MCP sunucusunu Claude Code'a ekle

Onceki adim sana tam komutu yazdirir; yol senin diskindeki yol olur:

```bash
claude mcp add premiere -s user -- node /tam/yol/gelistir/core/bin/gelistir-mcp.js
```

Kontrol:

```bash
claude mcp list
```

`premiere: ... - Connected` gormelisin.

**`-s user` neden onemli:** Claude Code'un varsayilan kapsami `local` -
sunucu yalnizca komutu calistirdigin klasorde gorunur. Video kurgularken
baska bir dizinde olacaksin ve orada `premiere` diye bir sey olmaz.
`-s user` her dizinden erisilir kilar (`claude mcp get premiere`, "available
in all your projects" yazmali).

**Yol tuzagi:** `$(pwd)` bash/zsh'te calisir ve `gelistir/core` icinde
olmani gerektirir. Windows'ta cmd/PowerShell'de bu ise yaramaz. En
guvenlisi `gelistir kurulum`'un yazdirdigi tam yolu kopyalamak.

Ayri bir `gelistir serve` calistirmak **sart degil**: MCP sunucusu
cekirdegi kendi surecinde baslatir. Zaten calisan bir cekirdek varsa ona
baglanir.

### 5. Cekirdegi baslat

Panel calismak icin bir cekirdege baglanmak zorunda. **Genelde bir sey
yapmana gerek yok:** panel cekirdegi kapali bulursa kendisi baslatir
(`gelistir kurulum --uygula` node yolunu ve depo kokunu ayarlara yazdigi
icin bunu yapabiliyor). Kayit bolumunde "Cekirdek baslatildi" satirini
gorursun.

Otomatik baslatma calismazsa (ayarlar eksik, node tasinmis, izin sorunu)
panel nedenini kayda yazar. O zaman elle:

**A) Kalici cekirdek.** Bir pencere ac ve acik tut:

```
sunucu.cmd          (Windows - dosyaya cift tikla)
sh sunucu.sh        (macOS / Linux)
```

Panel her zaman bagli kalir, Claude Code'u kapatip acmak bir sey bozmaz ve
cikardigin dokum/planlar oturumlar arasinda korunur.

**B) Sadece Claude Code.** MCP sunucusu cekirdegi kendi surecinde baslatir;
ayri bir sey calistirmak gerekmez. Ama cekirdek Claude Code oturumuyla
beraber yasar: oturum kapaninca panel baglantisini kaybeder (ve kendi
kendine yeniden baglanir, yeni oturum acildiginda).

Panel, cekirdek yoksa once bir kez kendisi baslatmayi dener, sonra 3
saniyede bir yeniden baglanmayi dener; once paneli acip sonra cekirdegi
baslatsan da kendi kendine toparlanir.

### 6. Premiere'i ac

Premiere Pro'yu **tamamen kapat ve tekrar ac** (uzanti listesi acilista
okunur), sonra:

**Pencere > Uzantilar > Gelistir - YouTube kurgu**

Panelde uc satir gormelisin; ucuncusu onemli:

```
Premiere 25.x - ProjeAdi / SequenceAdi
Cekirdek bagli - claude-opus-5
Kopru acik - Claude Code kullanabilir      <-- bu yaziyorsa hazir
```

Ucuncu satir yazmiyorsa panel cekirdege ulasamiyor; paneldeki yenile
dugmesine bas.

---

## Windows (cmd.exe)
<a id="windows-cmdexe"></a>

cmd.exe bash degil: `$(pwd)` yok, `#` yorum degil ve blok halinde
yapistirilan komutlar birbirine karisir. **Satirlari tek tek** calistir ya
da hazir betigi kullan.

### Hazir betik

```
git clone -b claude/premiere-pro-chrome-extension-sv7xzi https://github.com/wagnercreative/gelistir.git %USERPROFILE%\gelistir
```

Sonra `C:\Users\<kullanici>\gelistir\kur.cmd` dosyasina cift tikla.
Betik npm paketlerini kurar, gereksinimleri kontrol eder, paneli yerine
koyar ve sana `claude mcp add` komutunu **tam yoluyla** yazdirir. O komutu
kopyalayip cmd penceresine yapistir.

`git` komutu taninmiyorsa depoyu ZIP olarak indir:
<https://github.com/wagnercreative/gelistir/archive/refs/heads/claude/premiere-pro-chrome-extension-sv7xzi.zip>
Ac, icindeki klasoru `C:\Users\<kullanici>\gelistir` olarak yeniden
adlandir, sonra `kur.cmd`'ye cift tikla.

### Elle, satir satir

```
cd %USERPROFILE%\gelistir\core
npm install
node bin\gelistir.js doctor
node bin\gelistir.js kurulum --uygula
```

Son komut `claude mcp add premiere -s user -- node "C:\...\gelistir-mcp.js"`
seklinde bir satir yazdirir; onu kopyalayip calistir.

### Windows'a ozel notlar

- **Sembolik baglanti yok:** panel klasoru kopyalanir. `git pull` yaptiktan
  sonra `node bin\gelistir.js kurulum --uygula` komutunu tekrar calistir,
  yoksa panel eski kalir.
- **Ilk guncellemede `--zorla` gerekebilir.** Kurulum, hedefteki klasoru
  kendi kopyasi olarak taniyabilmek icin icine bir iz dosyasi
  (`.gelistir-kurulum.json`) birakir. Bu iz yoksa (eski surumle kurulmus)
  klasor "yabanci" sayilir ve korunur:
  ```
  node bin\gelistir.js kurulum --uygula --zorla
  ```
  Bir kez yeter; sonraki guncellemeler iz sayesinde bayrak istemez.
- **PlayerDebugMode** kayit defterine yazilir (`HKCU\Software\Adobe\CSXS.9`
  ile `.12` arasi). Yonetici hakki gerekmez.
- **ffmpeg** icin `winget install Gyan.FFmpeg` calistirdiktan sonra cmd
  penceresini **kapat ve yeniden ac** - PATH yeni pencerede gecerli olur.
- npm ya da pipx ile kurulan araclar (`whisper` gibi) `.cmd` sarmalayicisi
  olabilir; cekirdek bunlari `.cmd/.bat/.exe` uzantilarini deneyerek bulur.

### Yaptigin hatalari geri alma

Bozuk bir MCP kaydi olustuysa (ornegin komutta `$(pwd)` gorunuyorsa) once
temizle:

```
claude mcp remove premiere -s user
claude mcp remove premiere -s local
```

Ikisinden biri "not found" derse sorun degil, o kapsamda kayit yoktu.
`claude mcp get premiere` ile kontrol et.

---

## Kullanim

Claude Code'da normal sohbet:

```
> premiere'de acik sequence'te ne var?

  premiere_get_sequence
  Ana sequence, 10:12. Tek video kanalinda 1 klip
  (cekim-final.mp4), iki ses kanali.

> sessizlikleri ve dolgu sozcuklerini kes

  media_transcribe        (whisper, ~40 sn)
  transcript_read         0-300 sn
  transcript_read         300-612 sn
  media_detect_silence    18 sessizlik, 2:14
  build_cut_plan          plan-1: 10:12 -> 8:03 (%21)
  premiere_apply_keeps    "Gelistir kurgu" - 34 parca

  Yeni sequence kurdum, orijinale dokunmadim. Atilanlar: 2:14 sessizlik,
  31 sn dolgu sozcugu ("eee", "yani"), 4. dakikada iki tekrar cekim.
```

Ilk denemede once baglantiyi kontrol et:

```
> premiere baglantisini kontrol et
```

`premiere_connection_status` aracini cagirir ve panelin bagli olup
olmadigini soyler.

### Ne diyebilirsin

Bakma: "sequence'te ne var", "dokumu cikar ve ozetle", "3. dakikada ne
anlatiyorum", "en cok nerede takilmisim"

Kurgu: "sessizlikleri kes", "sadece 1 saniyeden uzun sessizlikleri at",
"girisin ilk 40 saniyesini kisalt", "ayni cumleyi iki kez soyledigim
yerleri bul", "kurulum kismini cikar"

Isaretleme: "bolum onerileri cikar ve marker koy", "en zayif anlatim
nerede, oraya git"

Yayina hazirlik: "bu kurguyu YouTube'a yayina hazirla", "baslik onerileri
ver"

---

## Araclar

18 arac var (17 + baglanti kontrolu). Tam liste ve aciklamalari:
[ajan.md](ajan.md#araclar)

Kisaca:

| Grup | Araclar |
|---|---|
| Premiere okuma | proje, zaman cizgisi, kaynak dosya |
| Premiere duzenleme | kesim planini uygula, klip devre disi/sil/kirp, kazanc, marker, playhead |
| Premiere cikti | Media Encoder'a gonder |
| Cekirdek | medya inceleme, dokum, sessizlik, dokum okuma, kesim plani, YouTube paketi |

---

## Guvenlik: izni kim soruyor

Bu onemli bir ayrim:

| Yol | Surucu | Izni kim sorar |
|---|---|---|
| **Claude Code (MCP)** | Claude Code | **Claude Code'un kendi izin sistemi** |
| Panel sohbeti | cekirdekteki ajan | cekirdek, panelde onay karti gosterir |

MCP yolunda cekirdek kendi onay kapisini uygulamaz - cifte sorulmasin diye.
Yikici araclar MCP `annotations` ile isaretlenir (`destructiveHint: true`),
boylece Claude Code dogru sekilde sorar:

- `premiere_delete_clip` - klip siler
- `premiere_trim_clip` - klibin in/out noktasini degistirir
- `premiere_export_sequence` - Media Encoder'i baslatir, dosya yazar
- `deliver_youtube_package` - paket klasorune dosya yazar

Salt-okunur araclar `readOnlyHint: true` tasir.

Izin sistemini kapattiysan (`--dangerously-skip-permissions` gibi) bu
araclar da sormadan kosar. Premiere projesi uzerinde calisirken bunu
yapmamak iyi fikir.

### Koddaki guvenlik, izinden bagimsiz

Izin sistemi ne olursa olsun sunlar her zaman gecerli:

- **Kesim onerileri budanir.** `build_cut_plan` kelime sinirina hizalar,
  nefes payi birakir, kisa parcalari temizler ve toplam atilan sureyi
  %35'te (yapilandirilabilir) sinirlar. Model "her seyi kes" dese bile
  cikti guvenli kalir.
- **Orijinal sequence'e dokunulmaz.** `premiere_apply_keeps` yeni bir
  sequence kurar. Sonucu begenmezsen eskisi yerinde.
- **Yayinlama yok.** Paket `private` olarak isaretlenir. Ne Claude Code ne
  panel YouTube'a yukleyebilir.

---

## Cekirdek nasil calisir

MCP sunucusu baslarken:

1. `127.0.0.1:8787`'de calisan bir cekirdek var mi diye bakar
2. Varsa ona baglanir (birden fazla Claude Code oturumu ayni cekirdegi
   paylasir - dokum ve planlar ortak olur)
3. Yoksa cekirdegi **kendi surecinde** baslatir

Yani iki kullanim da gecerli:

```bash
# A) Sadece MCP: cekirdek Claude Code oturumuyla yasar
claude mcp add premiere -s user -- node /yol/core/bin/gelistir-mcp.js

# B) Kalici cekirdek: oturumlar arasi dokum/plan korunur
gelistir serve        # ayri bir terminalde acik kalir
```

(B) yolunda Claude Code kapansa bile panel bagli kalir ve cikardigin dokum
bir sonraki oturumda hazir olur.

Port cakisirsa:

```bash
gelistir config port=8799
```

---

## Sorun giderme

**Panelde "API anahtari yok" ya da sohbet kutusu kapali**
Beklenen durum. Panelin kendi sohbeti kendi anahtarini ister; Claude
Code'dan kullanirken buna ihtiyac yok. Panelin ustundeki "Claude Code'dan
kullan" kutusu dogru yolu gosterir.

**Panelde "Kopru: kapali" yaziyor ama cekirdek bagli**
Eski surumde bir hata vardi: yoklama suresi bagliligi penceresinden uzun
oldugu icin panel tam beklerken "kapali" gorunuyordu. `git pull` yapip
`gelistir kurulum --uygula` komutunu tekrar calistir (Windows'ta panel
kopyalandigi icin pull tek basina yetmez).

**Panelde "Cekirdege ulasilamadi (http://127.0.0.1:8787)" yaziyor**
Panel cekirdegi kendi baslatmaya calisir; kayda ne yazdigina bak
(alttaki "Kayit" bolumunu ac):

- *"Cekirdek baslatildi: ..."* - birkac saniye icinde baglanmali.
- *"Cekirdek baslatilamadi: Ayarlarda node yolu ya da depo koku yok"* -
  bir kez `gelistir kurulum --uygula` calistir; node yolunu ve depo kokunu
  o yaziyor.
- Baska bir neden yaziyorsa elle baslat: `sunucu.cmd`'ye cift tikla
  (ya da `sh sunucu.sh`).

Cekirdek ayaga kalkinca satir kendiliginden yesile doner, yenile
dugmesine basmak gerekmez.

Hala olmuyorsa portu kontrol et: `gelistir config` cikisindaki `port`
degeri panelin baktigi portla ayni olmali. Degistirdiysen paneli kapat-ac.

**Claude Code'da premiere araclari gorunmuyor**
Muhtemelen kapsam sorunu: `claude mcp get premiere` "in this project"
diyorsa sunucu sadece o klasorde gorunur. Kaldir ve kullanici kapsamiyla
ekle:
```bash
claude mcp remove premiere -s local
claude mcp add premiere -s user -- node /tam/yol/core/bin/gelistir-mcp.js
```
Ekledikten sonra Claude Code'u yeniden baslat; arac listesi oturum
basinda okunur.

**`claude mcp list` sunucuyu "failed" gosteriyor**
Sunucuyu elle calistirip stderr'e bak:
```bash
node core/bin/gelistir-mcp.js
```
`[gelistir-mcp] MCP sunucusu hazir` gormelisin. Hata varsa oradadir.

**"Premiere paneli bagli degil"**
Uc sey: Premiere acik mi, panel acik mi (Pencere > Uzantilar), panelde
"Kopru acik" yaziyor mu. Panelde yazmiyorsa cekirdek ile panel ayni porta
bakmiyor olabilir - paneldeki yenile dugmesine bas.

**Araclar calisiyor ama Claude Code'da gorunmuyor**
Claude Code'u yeniden baslat; arac listesi oturum basinda okunur.

**"komut 120 saniyede tamamlanmadi"**
Premiere baska bir isle mesgul (render, kaydetme) ya da bir diyalog acik
ve ExtendScript bekliyor. Premiere'e bak.

**Panel kapandi, komutlar asili kaldi**
Panel kapanirken cekirdege haber verir ve bekleyenler hemen hatayla biter.
Haber gitmediyse en fazla 120 saniye sonra zaman asimina ugrarlar.

**Dokum her oturumda tekrar cikariliyor**
Cekirdek MCP sureciyle beraber kapandigi icin durum kayboluyor. Kalici
cekirdek icin ayri bir terminalde `gelistir serve` calistir.
