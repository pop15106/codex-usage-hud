param(
  [Parameter(Mandatory = $true)]
  [string[]]$Paths
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($env:WINDOWS_CERTIFICATE_BASE64)) {
  Write-Host "No Windows code-signing certificate configured. Skipping signing."
  exit 0
}

$certDir = Join-Path $env:RUNNER_TEMP "codex-usage-hud-signing"
$pfxPath = Join-Path $certDir "codesign.pfx"
New-Item -ItemType Directory -Force -Path $certDir | Out-Null
[IO.File]::WriteAllBytes($pfxPath, [Convert]::FromBase64String($env:WINDOWS_CERTIFICATE_BASE64))

$passwordText = if ($null -eq $env:WINDOWS_CERTIFICATE_PASSWORD) { "" } else { $env:WINDOWS_CERTIFICATE_PASSWORD }
$password = ConvertTo-SecureString -String $passwordText -AsPlainText -Force
$imported = Import-PfxCertificate -FilePath $pfxPath -CertStoreLocation "Cert:\CurrentUser\My" -Password $password
if (-not $imported) {
  throw "Failed to import Windows code-signing certificate."
}

$signtool = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin" -Recurse -Filter signtool.exe |
  Where-Object { $_.FullName -match "\\x64\\signtool\.exe$" } |
  Sort-Object FullName -Descending |
  Select-Object -First 1

if (-not $signtool) {
  throw "signtool.exe was not found."
}

try {
  foreach ($path in $Paths) {
    if (-not (Test-Path $path)) {
      throw "Signing target does not exist: $path"
    }

    & $signtool.FullName sign /sha1 $imported.Thumbprint /fd SHA256 /td SHA256 /tr "http://timestamp.digicert.com" $path
    if ($LASTEXITCODE -ne 0) {
      throw "Signing failed: $path"
    }

    & $signtool.FullName verify /pa /v $path
    if ($LASTEXITCODE -ne 0) {
      throw "Signature verification failed: $path"
    }
  }
}
finally {
  Remove-Item "Cert:\CurrentUser\My\$($imported.Thumbprint)" -Force -ErrorAction SilentlyContinue
  Remove-Item $certDir -Recurse -Force -ErrorAction SilentlyContinue
}
