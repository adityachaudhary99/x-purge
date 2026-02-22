# build.ps1 — packages X-Purge for Chrome Web Store submission
# Usage: .\build.ps1
# Output: x-purge-<version>.zip in the current directory

$ErrorActionPreference = "Stop"

$manifest = Get-Content -Raw "manifest.json" | ConvertFrom-Json
$version  = $manifest.version
$out      = "x-purge-$version.zip"
$dist     = ".dist-tmp"

Write-Host "Building X-Purge v$version..."

# Clean up previous build artifacts
if (Test-Path $dist)  { Remove-Item -Recurse -Force $dist }
if (Test-Path $out)   { Remove-Item -Force $out }

New-Item -ItemType Directory -Path "$dist\icons" | Out-Null

# Copy extension source files (exclude dev/repo artifacts)
$files = @(
    "manifest.json",
    "content-script.js",
    "page-bridge.js",
    "overlay.css",
    "service-worker.js",
    "popup.html",
    "popup.js",
    "LICENSE",
    "README.md"
)
foreach ($f in $files) {
    Copy-Item $f "$dist\$f"
}
Copy-Item "icons\icon16.png"  "$dist\icons\icon16.png"
Copy-Item "icons\icon48.png"  "$dist\icons\icon48.png"
Copy-Item "icons\icon128.png" "$dist\icons\icon128.png"

# Create zip
Compress-Archive -Path "$dist\*" -DestinationPath $out

# Clean up temp directory
Remove-Item -Recurse -Force $dist

$size = (Get-Item $out).Length / 1KB
Write-Host "✓  Created $out ($([math]::Round($size, 1)) KB)"
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Go to https://chrome.google.com/webstore/devconsole"
Write-Host "  2. Click 'New item' and upload $out"
Write-Host "  3. Fill in the store listing (see README.md § Chrome Web Store)"
