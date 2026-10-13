# Emlak Takip Paneli

İzmir Menemen'deki (veya panelden seçtiğiniz başka bir il-ilçedeki) satılık/kiralık daire, arsa, tarla ve
iş yeri ilanlarını takip eden web paneli.

- **Her 30 dakikada bir** (ayarlanabilir) ilanları tarar, **yeni ilanları** Telegram'a fotoğraf, fiyat,
  m², oda, mahalle ve **ilan linkiyle** gönderir.
- **Her gün** belirlediğiniz saatte, yayında **30. gününe giren** (ayarlanabilir) ilanların tamamını tek
  bir rapor halinde (gerekirse birkaç mesaja bölünerek) gönderir.
- Bütün ayarlar ve filtreler panelden yapılır: aramalar, kategori, konum, fiyat, m², m² fiyatı, oda sayısı,
  dahil/hariç mahalleler, başlıkta geçmesi/geçmemesi gereken kelimeler, etiketler (SIFIR BİNA, EŞYALI…),
  hariç katlar, Telegram, tarama aralığı, rapor saati, hatırlatma günü.

İlan kaynağı **Emlakjet**'tir. (Sahibinden ve Hepsiemlak otomatik erişimi Cloudflare ile engelliyor; bu
yüzden kararlı çalışan kaynak olarak Emlakjet kullanıldı.)

## Kurulum

### 1) Telegram botu

1. Telegram'da **@BotFather**'a `/newbot` yazın, bota bir ad verin ve size verilen **token**'ı kopyalayın.
2. Kendi bota `/start` yazın. (Grup kullanacaksanız botu gruba ekleyip grupta bir mesaj yazın.)
3. Panelde **Telegram & Zamanlama** sekmesinde token'ı yapıştırın, **Sohbetleri bul**'a basıp çıkan
   sohbeti ekleyin, **Test mesajı gönder** ile deneyin ve **Ayarları kaydet**'e basın.

### 2a) Docker ile çalıştırma (önerilen)

```bash
cp .env.example .env        # PANEL_PASSWORD'ü değiştirin
docker compose up -d --build
```

Panel: <http://sunucu-adresi:8000> (kullanıcı adı/parola `.env` dosyasındaki). Veritabanı `./data`
klasöründe tutulur.

### 2b) Docker olmadan

Python 3.11+ gerekir.

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
PANEL_PASSWORD=gizli-parola .venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000
```

> Panel 7/24 açık kalan bir makinede (VPS, ev sunucusu, Raspberry Pi vb.) çalışmalı; kapalıyken tarama
> yapılmaz. Sunucu kapalıyken kaçırılan günlerin 30. gün ilanları, hatırlatma gününü en fazla 2 gün geçmişse
> bir sonraki raporda yine gönderilir.

## Nasıl çalışır

**Yeni ilan taraması.** Her etkin arama için Emlakjet sonuç sayfaları (en yeni ilan en üstte) gezilir.
Bir sayfadaki ilanların hepsi zaten biliniyorsa tarama durur, böylece her 30 dakikada çoğunlukla tek sayfa
istenir. Daha önce görülmemiş ve aramanın filtrelerine uyan ilanlar Telegram'a gönderilir. Bir aramanın
**ilk taramasında** mevcut ilanlar sessizce kaydedilir (istenirse ayarlardan kapatılabilir), böylece kurulumda
yüzlerce mesaj gelmez.

**30. gün raporu.** İlanın yayın günü 1. gün sayılır (ilan tarihi 29 gün önce olan ilan bugün 30. gününde).
Rapor saatinden hemen önce bir **derin tarama** yapılarak ilanların hâlâ yayında olduğu doğrulanır; yayından
kalkmış ilanlar rapora girmez. Her ilan bu raporda yalnızca bir kez gönderilir. "Arama filtrelerini rapora da
uygula" kapatılırsa takip edilen aramalardaki 30. gün ilanlarının tamamı gönderilir.

**Filtre ipuçları**

- Liste alanları virgülle ayrılır; büyük/küçük harf ve Türkçe karakter fark etmez (`ulukent` = `Ulukent`).
- Oda filtresi oda bilgisi olmayan ilanları (arsa, tarla) elemez.
- "Yeni ilan en fazla kaç günlük olabilir": eski bir ilan ilk kez görüldüğünde "yeni" diye gönderilmesini önler.
- **Filtreyi dene** düğmesi, kaydetmeden önce filtrelerinizi daha önce kaydedilmiş ilanlar üzerinde dener.
- Gelişmiş: Emlakjet sitesinde kendi filtrelerinizle arama yapıp adresini "özel Emlakjet arama adresi"
  alanına yapıştırabilirsiniz.

## Geliştirme

```bash
.venv/bin/pip install -r requirements-dev.txt
.venv/bin/python -m pytest -q
```

| Dosya | Görev |
|---|---|
| `app/main.py` | FastAPI paneli, API uçları, zamanlayıcı |
| `app/jobs.py` | Tarama ve günlük rapor mantığı |
| `app/emlakjet.py` | Emlakjet sayfalarını çekme ve ayrıştırma |
| `app/filters.py` | Filtre eşleştirme, ilan günü hesabı |
| `app/telegram.py` | Telegram gönderimi ve mesaj biçimleri |
| `app/config.py` | Varsayılan ayarlar ve doğrulama |
| `app/db.py` | SQLite veritabanı |
| `app/static/index.html` | Panel arayüzü |

Ortam değişkenleri: `PANEL_USER`, `PANEL_PASSWORD`, `APP_TZ` (varsayılan `Europe/Istanbul`), `DB_PATH`,
`FIRST_SCAN_DELAY` (açılıştan sonra ilk taramaya kadar saniye, varsayılan 15).
