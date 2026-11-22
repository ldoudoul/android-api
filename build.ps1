param(
  [switch]$DebugBuild,
  [string]$Sdk = $env:ANDROID_SDK_ROOT,
  [string]$KeyStorePath = $env:ANDROID_KEYSTORE_PATH,
  [string]$KeyAlias = $env:ANDROID_KEY_ALIAS
)
$ErrorActionPreference = "Stop"

if (-not $Sdk) { throw "Set ANDROID_SDK_ROOT or pass -Sdk <path>." }
if (-not $KeyStorePath) { throw "Set ANDROID_KEYSTORE_PATH to a keystore outside this repository." }
if (-not $KeyAlias) { throw "Set ANDROID_KEY_ALIAS." }
if (-not $env:ANDROID_KEYSTORE_PASSWORD) { throw "Set ANDROID_KEYSTORE_PASSWORD for this PowerShell session." }
if (-not (Test-Path -LiteralPath $KeyStorePath -PathType Leaf)) { throw "Keystore not found: $KeyStorePath" }

$bt = Join-Path $Sdk "build-tools\35.0.0"
$platform = Join-Path $Sdk "platforms\android-35\android.jar"
$work = Join-Path $env:TEMP "android-api-build"
$dist = Join-Path $PSScriptRoot "dist"
$ks = (Resolve-Path -LiteralPath $KeyStorePath).Path
$keyPassSource = if ($env:ANDROID_KEY_PASSWORD) { "env:ANDROID_KEY_PASSWORD" } else { "env:ANDROID_KEYSTORE_PASSWORD" }

if (-not (Test-Path -LiteralPath $bt)) { throw "Build Tools not found: $bt" }
if (-not (Test-Path -LiteralPath $platform)) { throw "Android platform not found: $platform" }
if (-not (Get-Command javac -ErrorAction SilentlyContinue)) { throw "JDK 17 javac is not on PATH." }

function Step($name) { Write-Host "== $name ==" -ForegroundColor Cyan }

Step "stage"
if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force }
New-Item -ItemType Directory -Force -Path $work | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "app") -Destination (Join-Path $work "app") -Recurse
New-Item -ItemType Directory -Force -Path "$work\dex","$work\classes",$dist | Out-Null

Step "aapt2 compile"
& "$bt\aapt2.exe" compile --dir "$work\app\res" -o "$work\res.zip"
if ($LASTEXITCODE -ne 0) { throw "aapt2 compile failed" }

Step "aapt2 link"
$linkArgs = @("link", "-o", "$work\app-unsigned.apk", "-I", $platform,
  "--manifest", "$work\app\AndroidManifest.xml", "-A", "$work\app\assets",
  "--min-sdk-version", "26", "--target-sdk-version", "34")
if ($DebugBuild) { $linkArgs += "--debug-mode" }
$linkArgs += "$work\res.zip"
& "$bt\aapt2.exe" @linkArgs
if ($LASTEXITCODE -ne 0) { throw "aapt2 link failed" }

Step "javac"
$srcs = Get-ChildItem -LiteralPath "$work\app\src" -Recurse -Filter *.java | ForEach-Object { $_.FullName }
& javac --release 8 -encoding UTF-8 -classpath $platform -d "$work\classes" @srcs
if ($LASTEXITCODE -ne 0) { throw "javac failed" }

Step "d8"
$classes = Get-ChildItem -LiteralPath "$work\classes" -Recurse -Filter *.class | ForEach-Object { $_.FullName }
& "$bt\d8.bat" --lib $platform --min-api 26 --output "$work\dex" @classes
if ($LASTEXITCODE -ne 0) { throw "d8 failed" }
if (-not (Test-Path -LiteralPath "$work\dex\classes.dex")) { throw "classes.dex missing" }

Step "package"
Copy-Item -LiteralPath "$work\app-unsigned.apk" -Destination "$work\app-dex.apk" -Force
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open("$work\app-dex.apk", "Update")
try {
  $entry = $zip.CreateEntry("classes.dex", [System.IO.Compression.CompressionLevel]::NoCompression)
  $es = $entry.Open()
  try {
    $dexBytes = [System.IO.File]::ReadAllBytes("$work\dex\classes.dex")
    $es.Write($dexBytes, 0, $dexBytes.Length)
  } finally { $es.Dispose() }
} finally { $zip.Dispose() }

Step "zipalign"
& "$bt\zipalign.exe" -f -p 4 "$work\app-dex.apk" "$work\app-aligned.apk"
if ($LASTEXITCODE -ne 0) { throw "zipalign failed" }

Step "sign"
$name = if ($DebugBuild) { "android-api-1.1.0-debug.apk" } else { "android-api-1.1.0.apk" }
$out = Join-Path $work $name
& "$bt\apksigner.bat" sign --ks $ks --ks-key-alias $KeyAlias --ks-pass "env:ANDROID_KEYSTORE_PASSWORD" --key-pass $keyPassSource --out $out "$work\app-aligned.apk"
if ($LASTEXITCODE -ne 0) { throw "apksigner failed" }

Step "verify"
& "$bt\apksigner.bat" verify --print-certs $out
if ($LASTEXITCODE -ne 0) { throw "APK signature verification failed" }
$item = Get-Item -LiteralPath $out
Write-Host ("APK: " + $item.FullName + "  " + [math]::Round($item.Length / 1KB, 1) + " KB") -ForegroundColor Green

[System.IO.File]::Copy($out, (Join-Path $dist $name), $true)
Write-Host ("Copied to " + (Join-Path $dist $name))
