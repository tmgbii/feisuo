@echo off
chcp 65001 >nul
cd /d "%~dp0.."

rem 只留 release，给 build-windows 下次增量。debug / flycheck 全清。
if not exist "src-tauri\target" (
    echo 无 target
    goto :done
)

for /d %%D in ("src-tauri\target\*") do (
    if /i not "%%~nxD"=="release" (
        echo 删 %%D
        rd /s /q "%%D"
    )
)

:done
echo OK  保留 src-tauri\target\release
echo.
pause
