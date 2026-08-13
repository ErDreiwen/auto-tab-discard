[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [AllowEmptyString()]
  [string]$ActionPath,

  [Parameter(Mandatory = $true)]
  [ValidateSet('stable', 'beta')]
  [string]$Channel,

  [Parameter(Mandatory = $true)]
  [string]$EnvironmentFile,

  [string[]]$KnownPath,

  [string]$PathCommand = 'msedge.exe'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Resolve-EdgeCandidate {
  param([string]$Candidate)

  if ([string]::IsNullOrWhiteSpace($Candidate)) {
    return $null
  }
  try {
    $item = Get-Item -LiteralPath $Candidate -ErrorAction Stop
  }
  catch {
    return $null
  }
  if ($item.PSIsContainer -or $item.Name -ine 'msedge.exe') {
    return $null
  }
  $expectedSuffix = if ($Channel -eq 'beta') {
    '\Microsoft\Edge Beta\Application\msedge.exe'
  }
  else {
    '\Microsoft\Edge\Application\msedge.exe'
  }
  if (-not $item.FullName.EndsWith(
      $expectedSuffix,
      [System.StringComparison]::OrdinalIgnoreCase
    )) {
    return $null
  }
  return $item
}

$candidates = [System.Collections.Generic.List[string]]::new()
$candidates.Add($ActionPath)
if ($PSBoundParameters.ContainsKey('KnownPath')) {
  foreach ($candidate in $KnownPath) {
    $candidates.Add($candidate)
  }
}
else {
  $application = if ($Channel -eq 'beta') { 'Microsoft\Edge Beta\Application\msedge.exe' } else {
    'Microsoft\Edge\Application\msedge.exe'
  }
  foreach ($root in @(${env:ProgramFiles(x86)}, $env:ProgramFiles)) {
    if (-not [string]::IsNullOrWhiteSpace($root)) {
      $candidates.Add((Join-Path $root $application))
    }
  }
}

$selected = $null
foreach ($candidate in $candidates) {
  $selected = Resolve-EdgeCandidate $candidate
  if ($null -ne $selected) {
    break
  }
}
if ($null -eq $selected -and -not [string]::IsNullOrWhiteSpace($PathCommand)) {
  $pathCandidates = @(Get-Command $PathCommand -All -CommandType Application -ErrorAction SilentlyContinue |
    ForEach-Object { Resolve-EdgeCandidate $_.Source } |
    Where-Object { $null -ne $_ } |
    Sort-Object FullName -Unique)
  if ($pathCandidates.Count -gt 1) {
    throw "PATH resolved more than one $Channel Edge executable"
  }
  if ($pathCandidates.Count -eq 1) {
    $selected = $pathCandidates[0]
  }
}
if ($null -eq $selected) {
  throw "Unable to resolve an existing msedge.exe for the requested $Channel channel"
}

$version = $selected.VersionInfo.ProductVersion
if ([string]::IsNullOrWhiteSpace($version)) {
  $version = $selected.VersionInfo.FileVersion
}
$version = ([string]$version).Trim()
if ($version -notmatch '^\d+\.\d+\.\d+\.\d+$') {
  throw "Selected Edge executable did not report an exact numeric product/file version"
}
if ($selected.FullName -match '[\r\n]') {
  throw 'Selected Edge executable path cannot be written safely to the environment file'
}

$environmentParent = Split-Path -Parent ([System.IO.Path]::GetFullPath($EnvironmentFile))
if (-not [string]::IsNullOrWhiteSpace($environmentParent) -and
    -not (Test-Path -LiteralPath $environmentParent -PathType Container)) {
  throw "Environment-file parent does not exist: $environmentParent"
}

@(
  "CANARY_EXECUTABLE=$($selected.FullName)"
  'CANARY_INSTALLER=browser-actions/setup-edge@v1+verified-file-version'
  "CANARY_INSTALLED_VERSION=$version"
) | Out-File -LiteralPath $EnvironmentFile -Encoding utf8 -Append

[pscustomobject]@{
  channel = $Channel
  executable = $selected.FullName
  version = $version
} | ConvertTo-Json -Compress
