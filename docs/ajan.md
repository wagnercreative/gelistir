# Ajan modu: Premiere icinde sohbet

Panelin ana arayuzu bir sohbet kutusu. Ne istedigini yazarsin; model once
bakar, sonra arac cagirarak is yapar, sonucu okur ve devam eder. Claude'un
Chrome eklentisinin tarayicida yaptigi seyin Premiere'deki karsiligi.

```
Sen:     Sessizlikleri ve dolgu sozcuklerini kes
Ajan:    ⚙ zaman cizgisini okuyor
Ajan:    ⚙ konusmayi yaziya ceviriyor
Ajan:    12 dakikalik tek cekim, 148 segment. Dokumu okuyorum.
Ajan:    ⚙ dokumu okuyor, sessizlikleri ariyor
Ajan:    ⚙ kesim planini kuruyor
Ajan:    41 yerde kesim buldum: 2:14 sessizlik, 38 sn dolgu sozcugu,
         iki tekrar cekim. 12:03 -> 9:31 (%21 kisaliyor). Uygulayayim mi?
Sen:     uygula
Ajan:    ⚙ kesimleri yeni sequence'e diziyor
Ajan:    "Gelistir - cekim" adiyla yeni bir sequence kurdum, 42 parca.
         Orijinal sequence'e dokunmadim.
```

---

## Ne diyebilirsin

Bakma:
- "Sequence'te ne var, bir bak"
- "Dokumu cikar ve videoyu bana ozetle"
- "En cok nerede takilmisim?"
- "3. dakikada ne anlatiyorum?"

Kurgu:
- "Sessizlikleri ve dolgu sozcuklerini kes"
- "Sadece 1 saniyeden uzun sessizlikleri at, dolgulara dokunma"
- "Girisin ilk 40 saniyesi cok uzun, kisalt"
- "Ayni cumleyi iki kez soyledigim yerleri bul, ilkini at"
- "Kurulum kismini tamamen cikar"

Gezinme ve isaretleme:
- "Bolum onerileri cikar ve zaman cizgisine marker koy"
- "En zayif anlatim nerede, oraya git"

Yayina hazirlik:
- "Bu kurguyu YouTube'a yayina hazirla"
- "Baslik onerileri ver"
- "Aciklamayi yaz ama bolum listesini kendim ekleyecegim"

Ajan emin olmadiginda sorar. Sen de ortasinda mudahale edebilirsin
("dur, 5. dakikadakini atma").

---

## Araclar

Model bunlari cagirarak is yapiyor. Araclar iki yerde kosuyor: **Premiere**
(panel ExtendScript ile calistirir) ve **cekirdek** (Node tarafi: ffmpeg,
whisper, paketleme).

### Premiere araclari

| Arac | Ne yapar | Onay |
|---|---|---|
| `premiere_get_project` | proje ve sequence listesi | - |
| `premiere_get_sequence` | zaman cizgisi: klipler, in/out, kaynak, markerlar | - |
| `premiere_get_primary_source` | analiz edilecek kaynak dosyanin yolu | - |
| `premiere_apply_keeps` | kesim planini **yeni** sequence olarak kurar | - |
| `premiere_set_clip_enabled` | klibi devre disi birakir (geri alinabilir) | - |
| `premiere_set_clip_gain` | ses klibinin kazancini dB olarak ayarlar | - |
| `premiere_add_markers` | zaman cizgisine isaret koyar | - |
| `premiere_set_playhead` | oynatma kafasini tasir | - |
| `premiere_delete_clip` | klibi siler | **evet** |
| `premiere_trim_clip` | klibin in/out noktasini degistirir | **evet** |
| `premiere_export_sequence` | Media Encoder'a gonderir | **evet** |

### Cekirdek araclari

| Arac | Ne yapar | Onay |
|---|---|---|
| `media_probe` | sure, cozunurluk, fps, ses akisi | - |
| `media_transcribe` | whisper ile dokum (veya hazir .srt) | - |
| `media_detect_silence` | ffmpeg ile sessizlik araliklari | - |
| `transcript_read` | dokumun bir zaman penceresi | - |
| `build_cut_plan` | onerileri guvenlik kurallarindan gecirip plan uretir | - |
| `deliver_youtube_package` | yayina hazir paketi yazar | **evet** |

---

## Guvenlik: uc katman

### 1. Onay kapisi

Yikici araclar (klip silme, kirpma, export, paketleme) once panelde bir onay
karti gosterir. Kartta aracin adi ve modelin gonderdigi tum parametreler
gorunur. **Izin ver** demezsen arac hic kosmaz; **Reddet** dersen modele
"kullanici onaylamadi" bilgisi gider ve baska bir yol onerir.

Okuma araclari ve geri alinabilir islemler onay istemez - yoksa her adimda
tiklamak zorunda kalirdin.

### 2. Kesim kurallari koddan geliyor

Model "sunlari at" diyemez, sadece **onerebilir**. Oneriler
`build_cut_plan`'dan geciyor ve orada:

- kesim noktalari kelime sinirina hizalanir (kelime ortasindan kesilmez)
- her kesimin basina 0.08, sonuna 0.12 sn nefes payi birakilir
- 0.35 sn'den kisa parcalar temizlenir
- toplam atilan sure **surenin %35'ini gecemez** (yapilandirilabilir)
- butceyi asan oneriler reddedilir ve sana bildirilir

Yani model "her seyi kes" dese bile cikti guvenli kalir.

### 3. Orijinale dokunulmaz

`premiere_apply_keeps` mevcut sequence'i degistirmez; tutulacak parcalari
**yeni** bir sequence'e dizer. Sonucu begenmezsen eski sequence yerinde.
Bu yuzden bu arac onay istemiyor.

---

## Baglam yonetimi

Bir saatlik videonun dokumu 60-80 bin karakter. Hepsini modele vermek hem
pahali hem gereksiz. Bu yuzden:

- `media_transcribe` dokumu **dondurmez**; oturumda saklar ve sadece ozet
  (segment sayisi, dil, ilk satirlar) verir
- `transcript_read` istenen zaman penceresini, en fazla 12 bin karakter
  dondurur ve "devami icin startSeconds=..." der
- `build_cut_plan` uzun keeps listesini modele dokmez: plani oturumda tutar,
  modele `planId` verir. `premiere_apply_keeps` o planId ile cagrildiginda
  cekirdek keeps listesini kendisi ekler
- sessizlik listesi 120 satirla, keeps onizlemesi 40 satirla sinirlanir
- uzun oturumlarda sunucu tarafli sikistirma (compaction) acik

Sistem istemi ve arac tanimlari onbellege alindigi icin uzun oturumlarda
tekrar eden kisim ucuza geliyor.

---

## Sinirlar

- **Bir istek en fazla 64 model cagrisi surer.** Bu butce kullanicinin mesaji
  basina; Premiere araclarinin gidip gelmesi sayaci sifirlamaz. Sinira
  gelinirse ajan durur ve isi bolmeni ister.
- **Bir oturumda tek tur.** Onceki tur bitmeden yeni mesaj gonderemezsin.
- **Kazanc esleme yaklasiktir.** `premiere_set_clip_gain` Premiere'in
  normalize Level parametresini kullanir ve esleme surumler arasi birebir
  belgelenmis degil. Yayin gurlugu bu degerle degil, paketleme sirasindaki
  iki gecisli loudnorm ile (-14 LUFS) belirlenir.
- **Yayinlama yok.** Ajan YouTube'a yukleyemez ve yayinlayamaz. Paket
  "private" olarak isaretlenir.
- **Coklu kaynak.** Dokum ve sessizlik analizi tek bir kaynak dosya
  uzerinde yapilir. Coklu kamera kurgusunda zaman cizgisini sen kurup
  master'i export ettikten sonra paketleme adimina gecmek daha dogru.

---

## Sorun giderme

**"Ajan modu icin ANTHROPIC_API_KEY gerekli"**
Anahtari ayarla (`export ANTHROPIC_API_KEY=...`) ya da `ant auth login` ile
giris yap, sonra `gelistir serve`i yeniden baslat.

**"Oturum mesgul"**
Onceki tur hala suruyor. Panelde "dusunuyor" yazisi kaybolana kadar bekle.

**Ajan ayni araci tekrar tekrar cagiriyor**
Genelde arac hata donduruyordur. Kayit bolumunu (alttaki "Kayit") ac ve
Premiere'in ne dondurdugune bak.

**"whisper bulunamadi"**
`gelistir doctor` ile kontrol et. Ya whisper kur ya da ajana hazir bir .srt
dosyasi ver: "dokum olarak /yol/dosya.srt kullan".

**Panel takildi gibi gorunuyor**
Uzun isler (whisper, kodlama) dakikalar surebilir. Cekirdek isi arka planda
kosturuyor ve panel durumu yokluyor; "dusunuyor" gorunuyorsa calisiyor
demektir. Kayit bolumu ilerlemeyi gosterir.
