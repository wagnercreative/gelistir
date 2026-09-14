# "Yayina hazir" ne demek

Bu dosya, paketteki dosyalarin hangi teknik hedefleri tuttugunu ve bunlarin
nereden geldigini anlatiyor.

---

## Paketin icerigi

`gelistir run cekim.mp4` sonunda `cekim-youtube/` klasoru:

```
cekim-youtube/
├── cekim-youtube.mp4      yuklenecek dosya
├── cekim.tr.srt           altyazi (sidecar - Studio'ya ayri yuklenir)
├── kapak-1.jpg            kapak adayi (Claude'un sectigi anlardan)
├── kapak-2.jpg
├── kapak-3.jpg
├── metadata.json          eklentinin okudugu yapisal veri
├── aciklama.txt           baslik + aciklama, kopyala-yapistir icin
├── bolumler.txt           bolum listesi
├── rapor.md               ne kesildi, neden, yuklemeden once kontrol listesi
└── job.json               dokum + kesim plani (yeniden paketleme icin)
```

`.work/` klasoru ara dosyalari tutar (wav, dokum json); silmek guvenli.

---

## Goruntu

| Ayar | Deger | Neden |
|---|---|---|
| Codec | H.264 (`libx264`), profile high | YouTube'un onerdigi yukleme codec'i |
| Piksel bicimi | `yuv420p` | en genis uyumluluk; 4:2:2/4:4:4 gereksiz buyur |
| Bit hizi | cozunurluge gore (asagida) | YouTube'un yayinladigi yukleme onerileri |
| GOP | fps x 2 | onerilen keyframe araligi |
| Renk | bt709 primaries/trc/matrix | SDR icin dogru etiketleme; renk kaymasini onler |
| `movflags` | `+faststart` | moov atomu basa gider, yukleme daha hizli isler |

Bit hizi tablosu (30 fps; 40 fps ustunde 1.5 kat):

| Cozunurluk | Hedef |
|---|---|
| 2160p | 35 Mbps |
| 1440p | 16 Mbps |
| 1080p | 8 Mbps |
| 720p | 5 Mbps |
| 480p | 2.5 Mbps |

`maxrate` hedefin 1.5 kati, `bufsize` 2 kati olarak ayarlanir - hareketli
sahnelerde kaliteyi korur, ortalama boyutu sisirmez.

> Kaynak 4K ise cikti da 4K olur; olceklendirme yapilmaz. YouTube 1080p'de bile
> 4K yuklemeye daha iyi bir codec (VP9/AV1) atadigi icin kaynagi dusurmemek
> genelde daha iyi sonuc verir.

---

## Ses

| Ayar | Deger |
|---|---|
| Gurluk | **-14 LUFS** (entegre) |
| Gercek tepe | **-1 dBTP** |
| Codec | AAC-LC, 384 kbps |
| Ornekleme | 48 kHz, stereo |

YouTube gelen sesi kendi normalizasyonundan geciriyor ve referans noktasi
-14 LUFS civari. Bunun altinda teslim edersen platform sesi yukseltmez (kisik
kalir); ustunde teslim edersen kisar - ve kisma sirasinda dinamikler bozulur.
-1 dBTP tepe payi da kodlama sonrasi kirpilmayi (clipping) onler.

Normalizasyon **iki gecisli** yapiliyor:

1. Kesilmis ses olculur (`loudnorm ... print_format=json`)
2. Olculen degerler `measured_I` / `measured_TP` / `measured_LRA` olarak geri
   verilip `linear=true` ile tek seferde uygulanir

Tek gecisli normalizasyon sesi ilerledikce ayarlar ve duyulur pompalama
yapabilir; iki gecisli yontem tum dosyaya sabit bir kazanc uygular.

Olcumun **kesimden sonra** yapilmasi onemli: atilan sessizlikler entegre
gurlugu asagi ceker, once olcup sonra kesmek sesi oldugundan daha yuksek cikarir.

---

## Altyazi

`.srt` dosyasi sidecar olarak veriliyor - goruntuye yakilmiyor (istersen
`gelistir config burnSubtitles=true`).

Neden sidecar: YouTube'un kendi altyazi oynaticisi acilip kapatilabilir, arama
motorlari okuyabilir, izleyici dilini secebilir. Yakili altyazi bunlarin
hicbirini vermez ve mobilde cogu zaman kucuk kalir.

Uygulanan kurallar:

- Satir basina en fazla 42 karakter, en fazla 2 satir
- Bir kuyruk en az 1.0, en fazla 6.0 saniye
- Uzun segmentler kelime zaman damgalarindan bolunur (kelime ortasindan degil)
- Kuyruklar cakismaz; cakisma varsa sonraki kuyrugun basina kirpilir
- Zamanlar kesilmis zaman cizgisine tasinir (`projectRange`)

Dosya adi `<isim>.<dil>.srt` bicimindedir; dil kodu dokumden gelir.

---

## Bolumler (chapters)

YouTube'un bolum listesi olusturma kurallari kati ve hepsi saglanmazsa liste
**hic** gorunmez:

1. Ilk bolum `0:00` olmali
2. En az 3 bolum olmali
3. Her bolum en az 10 saniye surmeli

`youtube.normalizeChapters` bunlari sirayla uygular: ilk bolum 0 degilse basa
bir tane eklenir, 10 saniyeden yakin olanlar atilir, videonun sonuna 10
saniyeden yakin olanlar atilir. Sonucta 3'ten az bolum kalirsa liste tamamen
bosaltilir - yarim bir liste YouTube'da hicbir sey gostermez, sadece aciklamayi
kirletir.

Bolum zamanlari Claude'dan kaynak zaman cizgisinde gelir ve `remapTime` ile
kesilmis cizgiye tasinir.

---

## Metinler

| Alan | Sinir | Uygulanisi |
|---|---|---|
| Baslik | 100 karakter | kelime sinirindan kirpilir, ortasindan degil |
| Aciklama | 5000 karakter | bolum listesi korunur, gerekirse ozet kisaltilir |
| Etiketler | 15 adet / toplam 500 karakter | tekrarlar atilir, butceye sigdirilir |
| Hashtag | en fazla 3 | aciklamanin sonuna eklenir |

Claude 3-5 baslik adayi uretir; ilki `metadata.json`'daki `title` olur,
kalanlari `titleAlternatives` altinda durur ve `rapor.md`'de listelenir.

Aciklamanin ilk iki satiri arama sonuclarinda ve onizlemede gorunen kisim
oldugu icin istem bunu acikca soyluyor. Bolum listesi **model tarafindan
yazilmiyor** - sistem dogrulanmis bolumleri sonradan ekliyor.

---

## Kapak gorseli

Kapak **tasarlanmiyor**. Claude dokumden yuz/ifade/ekran gosteriminin guclu
oldugu anlari sectikten sonra o karelerden 1280 genislikte JPEG cikarilir.
Uc aday gelir; birini kullanabilir ya da kendi tasarimina referans yapabilirsin.

YouTube kapak icin 1280x720, 2 MB alti ve 16:9 ister - cikarilan kareler
kaynak en-boy oranini korur, gerekirse kendin kirp.

---

## Gorunurluk ve yayinlama

`metadata.json` icindeki `privacyStatus` her zaman `"private"`. Ne panel ne
eklenti bunu degistirir, ne de "Yayinla" dugmesine basar.

Sebep basit: yayinlama geri alinamayan, dis dunyaya donuk bir islem. Kesimi
yanlis yapan bir arac en kotu durumda zamanini alir; yanlis videoyu yayinlayan
bir arac itibarini alir. Karar insanin.

`rapor.md` sonunda yuklemeden once bakilacak kisa bir liste var:

- Videoyu bastan sona bir kez izle; kesim noktalarinda tik sesi var mi?
- Altyaziyi kontrol et (ozel isimler ve terimler)
- Kapak gorselini sec veya kendin tasarla
- Baslik ve aciklamayi gozden gecir
- Telif: muzik ve goruntu haklarini dogrula
