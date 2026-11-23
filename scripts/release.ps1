#Requires -Version 7
<#
.SYNOPSIS
  Builds a signed release of Unity Project Sync and stages it for the update server.

.DESCRIPTION
  1. Checks (and with -Version bumps) the app version in src-tauri/tauri.conf.json,
     package.json and src-tauri/Cargo.toml.
  2. Builds the NSIS installer with updater artifacts, signed with the minisign key:
       pnpm tauri build --config src-tauri/tauri.release.conf.json --ci
  3. Writes release/<version>/ with exactly two files:
       Unity-Project-Sync_<version>_x64-setup.exe
       release.json   (version, pub_date, notes, file, size, sha256, signature)
  4. Prints how to upload that folder into the update server's releases directory
     (or uploads it with scp when -Upload is given and UPS_UPLOAD_TARGET is set).

.PARAMETER Version
  New version (semver, e.g. 0.2.0). Bumps all three version files when it differs.
  Without it, the version already in the files is released (they must agree).

.PARAMETER Notes
  Release notes (markdown). Mutually exclusive with -NotesFile.

.PARAMETER NotesFile
  Path to a markdown file with the release notes. Mutually exclusive with -Notes.

.PARAMETER KeyPath
  The minisign private key. Default: $HOME\.tauri\unity-project-sync.key

.PARAMETER SkipBuild
  Do not build; reuse the existing bundle output for the current version.

.PARAMETER Upload
  After staging, run "scp -r release\<version> $env:UPS_UPLOAD_TARGET"
  (e.g. UPS_UPLOAD_TARGET = "root@host:/srv/ups/releases").

.PARAMETER Force
  Rebuild even though release\<version> already exists. Only for a version that was never
  uploaded: a published exe is cached as immutable and must never change.

.EXAMPLE
  scripts\release.ps1 -Version 0.2.0 -NotesFile notes.md
#>
[CmdletBinding()]
param(
    [string] $Version,
    [string] $Notes,
    [string] $NotesFile,
    [string] $KeyPath = (Join-Path $HOME '.tauri\unity-project-sync.key'),
    [switch] $SkipBuild,
    [switch] $Upload,
    [switch] $Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false   # native exit codes are checked by hand

$UpdateServerUrl = 'https://ups.umami-creative.app'
$Utf8NoBom = [System.Text.UTF8Encoding]::new($false)
$Invariant = [System.Globalization.CultureInfo]::InvariantCulture

# semver 2.0.0 (https://semver.org), no leading "v"
$SemverPattern = '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)' +
    '(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?' +
    '(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$'

$RepoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$TauriConfPath = Join-Path $RepoRoot 'src-tauri\tauri.conf.json'
$ReleaseConfPath = Join-Path $RepoRoot 'src-tauri\tauri.release.conf.json'
$PackageJsonPath = Join-Path $RepoRoot 'package.json'
$CargoTomlPath = Join-Path $RepoRoot 'src-tauri\Cargo.toml'
$BundleDir = Join-Path $RepoRoot 'src-tauri\target\release\bundle\nsis'
$ReleaseRoot = Join-Path $RepoRoot 'release'

function Write-Step([string] $Text) { Write-Host "==> $Text" -ForegroundColor Cyan }

# ---------------------------------------------------------------- file helpers

# Reads a text file and remembers whether it had a UTF-8 BOM, so it can be written back unchanged.
function Read-TextFile([string] $Path) {
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    $hasBom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
    $offset = $hasBom ? 3 : 0
    [pscustomobject]@{
        Path   = $Path
        Text   = [System.Text.Encoding]::UTF8.GetString($bytes, $offset, $bytes.Length - $offset)
        HasBom = $hasBom
    }
}

function Write-TextFile($File, [string] $Text) {
    [System.IO.File]::WriteAllText($File.Path, $Text, [System.Text.UTF8Encoding]::new($File.HasBom))
}

# Matches the first top-level `"version": "..."` of a JSON file (tauri.conf.json, package.json).
# Group 2 is the value; groups 1 and 3 are kept as they are, so the formatting is preserved.
$JsonVersionRegex = [regex] '("version"\s*:\s*")([^"]*)(")'

# Finds the `version = "..."` line inside the [package] section of Cargo.toml.
# Returns $null or a Match whose group 2 is the value.
function Find-CargoPackageVersion([string] $Text) {
    $header = [regex]::Match($Text, '(?m)^[ \t]*\[package\][ \t]*\r?$')
    if (-not $header.Success) { return $null }
    $start = $header.Index + $header.Length
    $next = [regex]::new('(?m)^[ \t]*\[').Match($Text, $start)
    $end = $next.Success ? $next.Index : $Text.Length
    $m = [regex]::new('(?m)^([ \t]*version[ \t]*=[ \t]*")([^"]*)(")').Match($Text, $start, $end - $start)
    $m.Success ? $m : $null
}

function Get-JsonVersion([string] $Path) {
    $file = Read-TextFile $Path
    $parsed = $file.Text | ConvertFrom-Json
    if (-not $parsed.PSObject.Properties['version']) { throw "No top-level ""version"" in $Path" }
    $m = $JsonVersionRegex.Match($file.Text)
    # the first "version" key in the text must be the top-level one we parsed
    if (-not $m.Success -or $m.Groups[2].Value -cne $parsed.version) {
        throw "Could not locate the top-level ""version"" line in $Path"
    }
    $parsed.version
}

function Set-JsonVersion([string] $Path, [string] $NewVersion) {
    $file = Read-TextFile $Path
    $text = $JsonVersionRegex.Replace($file.Text, { param($m) $m.Groups[1].Value + $NewVersion + $m.Groups[3].Value }, 1)
    Write-TextFile $file $text
}

function Get-CargoVersion([string] $Path) {
    $m = Find-CargoPackageVersion (Read-TextFile $Path).Text
    if (-not $m) { throw "No version line in the [package] section of $Path" }
    $m.Groups[2].Value
}

function Set-CargoVersion([string] $Path, [string] $NewVersion) {
    $file = Read-TextFile $Path
    $m = Find-CargoPackageVersion $file.Text
    if (-not $m) { throw "No version line in the [package] section of $Path" }
    $valueGroup = $m.Groups[2]
    $text = $file.Text.Substring(0, $valueGroup.Index) + $NewVersion + $file.Text.Substring($valueGroup.Index + $valueGroup.Length)
    Write-TextFile $file $text
}

# ---------------------------------------------------------------- minisign helpers

function ConvertFrom-Base64Text([string] $Value, [string] $What) {
    try { [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Value.Trim())) }
    catch { throw "$What is not valid base64: $($_.Exception.Message)" }
}

# The 8-byte key id inside a minisign public key or signature line (after the 2-byte algorithm).
function Get-MinisignKeyId([string] $Base64Line) {
    $bytes = [Convert]::FromBase64String($Base64Line.Trim())
    if ($bytes.Length -lt 10) { throw 'minisign data too short' }
    [System.BitConverter]::ToString($bytes, 2, 8)
}

# Decodes the content of a tauri .sig file (base64 of a minisign signature box).
function Read-TauriSignature([string] $SigText) {
    $lines = (ConvertFrom-Base64Text $SigText 'The .sig file') -split "`r?`n"
    if ($lines.Count -lt 4 -or -not $lines[0].StartsWith('untrusted comment:') -or -not $lines[2].StartsWith('trusted comment: ')) {
        throw 'The .sig file does not contain a minisign signature box.'
    }
    $fields = @{}
    foreach ($part in $lines[2].Substring('trusted comment: '.Length) -split "`t") {
        $i = $part.IndexOf(':')
        if ($i -gt 0) { $fields[$part.Substring(0, $i)] = $part.Substring($i + 1) }
    }
    [pscustomobject]@{
        KeyId   = Get-MinisignKeyId $lines[1]
        File    = $fields['file']
        Version = $fields['version']
    }
}

# Key id of the base64 public key from tauri.conf.json / the .pub file.
function Get-PubkeyKeyId([string] $Pubkey) {
    $lines = (ConvertFrom-Base64Text $Pubkey 'The public key') -split "`r?`n"
    if ($lines.Count -lt 2) { throw 'The public key is not a minisign public key box.' }
    Get-MinisignKeyId $lines[1]
}

# ---------------------------------------------------------------- 1. checks

if ($PSBoundParameters.ContainsKey('Notes') -and $PSBoundParameters.ContainsKey('NotesFile')) {
    throw 'Use either -Notes or -NotesFile, not both.'
}
$releaseNotes = ''
if ($PSBoundParameters.ContainsKey('Notes')) { $releaseNotes = $Notes }
if ($PSBoundParameters.ContainsKey('NotesFile')) {
    $notesPath = $PSCmdlet.GetUnresolvedProviderPathFromPSPath($NotesFile)
    if (-not (Test-Path -LiteralPath $notesPath -PathType Leaf)) { throw "Notes file not found: $notesPath" }
    $releaseNotes = (Read-TextFile $notesPath).Text
}
$releaseNotes = ($releaseNotes -replace "`r`n", "`n").Trim()

if ($Upload -and -not $env:UPS_UPLOAD_TARGET) {
    throw '-Upload needs the environment variable UPS_UPLOAD_TARGET, e.g. $env:UPS_UPLOAD_TARGET = "root@your-coolify-host:/srv/ups/releases"'
}
if ($Upload -and -not (Get-Command scp -ErrorAction SilentlyContinue)) {
    throw '-Upload needs scp (Windows: Settings > System > Optional features > OpenSSH Client).'
}

Write-Step 'Checking versions'
$versions = [ordered]@{
    'src-tauri/tauri.conf.json' = Get-JsonVersion $TauriConfPath
    'package.json'              = Get-JsonVersion $PackageJsonPath
    'src-tauri/Cargo.toml'      = Get-CargoVersion $CargoTomlPath
}
foreach ($entry in $versions.GetEnumerator()) { Write-Host ("    {0,-26} {1}" -f $entry.Key, $entry.Value) }
$distinct = @($versions.Values | Select-Object -Unique)

$bumped = $false
if ($Version) {
    if ($Version -notmatch $SemverPattern) {
        throw "-Version '$Version' is not a valid semver version (e.g. 0.2.0 or 0.2.0-beta.1, no leading 'v')."
    }
    $bumped = $distinct.Count -ne 1 -or $distinct[0] -cne $Version
    if ($bumped -and $SkipBuild) {
        throw "-SkipBuild cannot be combined with a version bump to ${Version}: there is no bundle for that version yet."
    }
    $releaseVersion = $Version
} else {
    if ($distinct.Count -ne 1) {
        throw "The version files disagree (see above). Pass -Version <x.y.z> to set all three."
    }
    $releaseVersion = $distinct[0]
    if ($releaseVersion -notmatch $SemverPattern) {
        throw "The current version '$releaseVersion' is not valid semver. Pass -Version <x.y.z>."
    }
}

# A rebuild produces a different exe (new timestamps, new signature). If this version was
# already uploaded, its URL is cached as immutable, so it must not change.
$existingReleaseDir = Join-Path $ReleaseRoot $releaseVersion
if (-not $SkipBuild -and -not $Force -and (Test-Path -LiteralPath $existingReleaseDir)) {
    throw @"
$existingReleaseDir already exists. A rebuild would produce a different exe for the same version,
and a published version must never change its exe (it is cached as immutable).
  - To change only the notes: rerun with -SkipBuild (restages the same build), or edit
    "notes" in release.json on the server.
  - To ship a fix: release a new version (-Version <x.y.z>).
  - If $releaseVersion was never uploaded: pass -Force to rebuild it.
"@
}

$tauriConf = (Read-TextFile $TauriConfPath).Text | ConvertFrom-Json
$productName = $tauriConf.productName
$confPubkey = $null
$pluginsProp = $tauriConf.PSObject.Properties['plugins']
if ($pluginsProp -and $pluginsProp.Value.PSObject.Properties['updater'] -and $pluginsProp.Value.updater.PSObject.Properties['pubkey']) {
    $confPubkey = [string] $pluginsProp.Value.updater.pubkey
}
if (-not $confPubkey) { throw 'src-tauri/tauri.conf.json has no plugins.updater.pubkey; the updater is not configured.' }
$confKeyId = Get-PubkeyKeyId $confPubkey

$keyFullPath = $PSCmdlet.GetUnresolvedProviderPathFromPSPath($KeyPath)
if (-not $SkipBuild) {
    if (-not (Test-Path -LiteralPath $ReleaseConfPath -PathType Leaf)) {
        throw "Missing $ReleaseConfPath (expected content: {""bundle"":{""createUpdaterArtifacts"":true}})."
    }
    if (-not (Test-Path -LiteralPath $keyFullPath -PathType Leaf)) {
        throw @"
Signing key not found: $keyFullPath

The update signing key lives outside the repo. Restore it from your backup, or pass -KeyPath.
Only if it is truly lost, generate a new key pair:

    pnpm tauri signer generate -w "$keyFullPath"

and put the content of "$keyFullPath.pub" into src-tauri/tauri.conf.json -> plugins.updater.pubkey.
Note: apps already installed with the old public key will NOT accept updates signed by a new key;
those users have to install the new version manually once.
"@
    }
    $pubPath = "$keyFullPath.pub"
    if (Test-Path -LiteralPath $pubPath -PathType Leaf) {
        if ((Read-TextFile $pubPath).Text.Trim() -cne $confPubkey.Trim()) {
            throw "$pubPath does not match plugins.updater.pubkey in src-tauri/tauri.conf.json. Installed apps would reject this release."
        }
    }
    if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) { throw 'pnpm is not on PATH.' }
}

# ---------------------------------------------------------------- 2. bump + build

if ($bumped) {
    Write-Step "Bumping version to $releaseVersion"
    Set-JsonVersion $TauriConfPath $releaseVersion
    Set-JsonVersion $PackageJsonPath $releaseVersion
    Set-CargoVersion $CargoTomlPath $releaseVersion
    # read back, so a regex that hit the wrong line fails here and not in the build
    foreach ($check in @((Get-JsonVersion $TauriConfPath), (Get-JsonVersion $PackageJsonPath), (Get-CargoVersion $CargoTomlPath))) {
        if ($check -cne $releaseVersion) { throw "Version bump failed: found '$check' after writing '$releaseVersion'." }
    }
}

$bundleExeName = "${productName}_${releaseVersion}_x64-setup.exe"
$bundleExe = Join-Path $BundleDir $bundleExeName
$bundleSig = "$bundleExe.sig"

$buildStart = Get-Date
if (-not $SkipBuild) {
    Write-Step 'Building signed installer (pnpm tauri build --config src-tauri/tauri.release.conf.json --ci)'
    $hadKey = Test-Path env:TAURI_SIGNING_PRIVATE_KEY
    $oldKey = $env:TAURI_SIGNING_PRIVATE_KEY
    $hadPassword = Test-Path env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD
    Push-Location -LiteralPath $RepoRoot
    try {
        # absolute path: the tauri CLI changes into src-tauri before it signs
        $env:TAURI_SIGNING_PRIVATE_KEY = $keyFullPath
        if (-not $hadPassword) { $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = '' }
        & pnpm tauri build --config src-tauri/tauri.release.conf.json --ci
        if ($LASTEXITCODE -ne 0) {
            $hint = $bumped ? " The version files are already bumped to $releaseVersion; fix the problem and rerun." : ''
            throw "pnpm tauri build failed with exit code $LASTEXITCODE.$hint"
        }
    } finally {
        Pop-Location
        if ($hadKey) { $env:TAURI_SIGNING_PRIVATE_KEY = $oldKey } else { Remove-Item env:TAURI_SIGNING_PRIVATE_KEY -ErrorAction SilentlyContinue }
        if (-not $hadPassword) { Remove-Item env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue }
    }
}

# ---------------------------------------------------------------- 3. stage release/<version>/

Write-Step 'Checking bundle output'
if (-not (Test-Path -LiteralPath $bundleExe -PathType Leaf)) { throw "Installer not found: $bundleExe" }
if (-not (Test-Path -LiteralPath $bundleSig -PathType Leaf)) {
    throw "Signature not found: $bundleSig`nIt is only created by a build with src-tauri/tauri.release.conf.json (run this script without -SkipBuild)."
}
$exeItem = Get-Item -LiteralPath $bundleExe
$sigItem = Get-Item -LiteralPath $bundleSig
if (-not $SkipBuild -and $exeItem.LastWriteTime -lt $buildStart.AddSeconds(-2)) {
    throw "The installer is older than this build ($($exeItem.LastWriteTime)); the build did not produce it."
}
if ($sigItem.LastWriteTime -lt $exeItem.LastWriteTime) {
    throw "The .sig is older than the installer, so it belongs to an earlier build (a plain 'pnpm tauri build' does not re-sign). Run this script without -SkipBuild."
}

$signature = (Read-TextFile $bundleSig).Text.Trim()
if (-not $signature) { throw "Signature file is empty: $bundleSig" }
$sigInfo = Read-TauriSignature $signature
if ($sigInfo.KeyId -cne $confKeyId) {
    throw 'The installer was signed with a different key than plugins.updater.pubkey in tauri.conf.json. Installed apps would reject it.'
}
if ($sigInfo.File -cne $bundleExeName) {
    throw "The signature is for '$($sigInfo.File)', not '$bundleExeName'."
}
if ($sigInfo.Version -and $sigInfo.Version -cne $releaseVersion) {
    throw "The signature carries version '$($sigInfo.Version)', but this release is $releaseVersion. Installed apps would reject it."
}

$releaseFile = "$($productName -replace '\s+', '-')_${releaseVersion}_x64-setup.exe"
$releaseDir = Join-Path $ReleaseRoot $releaseVersion

Write-Step "Staging $releaseDir"
if (Test-Path -LiteralPath $releaseDir) { Remove-Item -LiteralPath $releaseDir -Recurse -Force }
New-Item -ItemType Directory -Path $releaseDir -Force | Out-Null
$releaseExe = Join-Path $releaseDir $releaseFile
Copy-Item -LiteralPath $bundleExe -Destination $releaseExe

$size = (Get-Item -LiteralPath $releaseExe).Length
$sha256 = (Get-FileHash -LiteralPath $releaseExe -Algorithm SHA256).Hash.ToLowerInvariant()
$pubDate = (Get-Date).ToUniversalTime().ToString("yyyy'-'MM'-'dd'T'HH':'mm':'ss'Z'", $Invariant)

$release = [ordered]@{
    version   = $releaseVersion
    pub_date  = $pubDate
    notes     = $releaseNotes
    file      = $releaseFile
    size      = [long] $size
    sha256    = $sha256
    signature = $signature
}
# ConvertTo-Json indents with CRLF on Windows; newlines inside strings are escaped, so this only touches layout
$json = ($release | ConvertTo-Json -Depth 3) -replace "`r`n", "`n"
[System.IO.File]::WriteAllText((Join-Path $releaseDir 'release.json'), $json + "`n", $Utf8NoBom)

# ---------------------------------------------------------------- 4. upload + summary

$uploadTarget = $env:UPS_UPLOAD_TARGET ? $env:UPS_UPLOAD_TARGET : '<user>@<coolify-host>:/srv/ups/releases'
$uploaded = $false
if ($Upload) {
    Write-Step "Uploading to $env:UPS_UPLOAD_TARGET"
    & scp -r $releaseDir $env:UPS_UPLOAD_TARGET
    if ($LASTEXITCODE -ne 0) { throw "scp failed with exit code $LASTEXITCODE. The release folder is still at $releaseDir." }
    $uploaded = $true
}

Write-Host ''
Write-Host "Release $releaseVersion is ready" -ForegroundColor Green
Write-Host "  Folder   $releaseDir"
Write-Host "  File     $releaseFile"
Write-Host ("  Size     {0:N0} bytes ({1:N1} MB)" -f $size, ($size / 1MB))
Write-Host "  SHA-256  $sha256"
Write-Host "  Date     $pubDate"
Write-Host ("  Notes    {0}" -f ($releaseNotes ? "$($releaseNotes.Length) characters" : '(none)'))
Write-Host ''

if ($uploaded) {
    Write-Host 'Uploaded. Checking the update server...' -ForegroundColor Cyan
    try {
        $latest = Invoke-RestMethod -Uri "$UpdateServerUrl/api/releases/latest" -TimeoutSec 15
        if ($latest.version -ceq $releaseVersion) {
            Write-Host "  The server reports $releaseVersion as the latest release." -ForegroundColor Green
        } else {
            Write-Warning "The server reports '$($latest.version)' as the latest release. Check the server log (invalid or incomplete release?)."
        }
    } catch {
        Write-Warning "Could not check $UpdateServerUrl/api/releases/latest: $($_.Exception.Message)"
    }
} else {
    Write-Host 'Upload' -ForegroundColor Cyan
    Write-Host "  Upload the folder '$releaseVersion' (both files) into the update server's releases directory"
    Write-Host '  (the Coolify Directory Mount, e.g. /srv/ups/releases on the host = /data/releases in the container):'
    Write-Host ''
    Write-Host "    scp -r `"$releaseDir`" $uploadTarget"
    Write-Host ''
    Write-Host '  or drag the folder into WinSCP (SFTP). A half-uploaded release is ignored by the server until'
    Write-Host "  the file size matches release.json. Next time: set `$env:UPS_UPLOAD_TARGET and pass -Upload."
    Write-Host ''
    Write-Host 'Verify' -ForegroundColor Cyan
    Write-Host "  $UpdateServerUrl/api/releases/latest   should report version $releaseVersion"
}
Write-Host ''
Write-Host 'Commit' -ForegroundColor Cyan
if ($bumped) {
    Write-Host "  The version was bumped to $releaseVersion. Commit it (Cargo.lock was updated by the build):"
    Write-Host "    git add src-tauri/tauri.conf.json package.json src-tauri/Cargo.toml src-tauri/Cargo.lock"
    Write-Host "    git commit -m `"Release $releaseVersion`"; git tag v$releaseVersion"
} else {
    Write-Host "  Make sure the version bump to $releaseVersion is committed (and tag it: git tag v$releaseVersion)."
}
