# Windows：飞梭 → ../out/Feisuo.exe
# 不打 MSI/NSIS，不删 target（第二次起增量）。
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

if (-not (Test-Path "node_modules")) {
    npm install
}

npx tauri build --no-bundle
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

New-Item -ItemType Directory -Force -Path "out" | Out-Null
Copy-Item -Force "src-tauri\target\release\commbox.exe" "out\Feisuo.exe"
$p = Get-Item "out\Feisuo.exe"
Write-Host ("OK  {0}  {1:N2} MB" -f $p.FullName, ($p.Length / 1MB))
