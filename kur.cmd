@echo off
rem Gelistir - Windows kurulum betigi
rem Kullanim: bu dosyaya cift tikla, ya da cmd'de tam yolunu yaz.
setlocal

cd /d "%~dp0core"
if errorlevel 1 goto :yolyok

echo ==============================================
echo  1/3  Node paketleri kuruluyor
echo ==============================================
call npm install
if errorlevel 1 goto :hata

echo.
echo ==============================================
echo  2/3  Gereksinimler kontrol ediliyor
echo ==============================================
call node bin\gelistir.js doctor

echo.
echo ==============================================
echo  3/3  Premiere paneli yerine konuyor
echo ==============================================
call node bin\gelistir.js kurulum --uygula
if errorlevel 1 goto :hata

echo.
echo Kurulum bitti. Yukaridaki "claude mcp add" komutunu kopyalayip
echo cmd penceresine yapistir, sonra Premiere Pro'yu kapat ve tekrar ac.
echo.
pause
exit /b 0

:yolyok
echo HATA: core klasoru bulunamadi. Bu betik depo kokunde durmali.
pause
exit /b 1

:hata
echo.
echo Kurulum yarida kaldi. Yukaridaki hata mesajina bak.
pause
exit /b 1
