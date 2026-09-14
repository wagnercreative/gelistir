@echo off
rem Gelistir cekirdegi - Windows
rem Premiere paneli buna baglanir. Pencereyi acik tut.
setlocal

cd /d "%~dp0core"
if errorlevel 1 goto :yolyok

echo ==============================================
echo  Gelistir cekirdegi baslatiliyor
echo ==============================================
echo.
echo  BU PENCEREYI KAPATMA.
echo  Kapatirsan Premiere paneli baglantisini kaybeder.
echo.

node bin\gelistir.js serve

echo.
echo Cekirdek durdu.
pause
exit /b 0

:yolyok
echo HATA: core klasoru bulunamadi. Bu betik depo kokunde durmali.
pause
exit /b 1
