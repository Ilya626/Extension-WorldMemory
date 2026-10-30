param(
    [Parameter(Position=0)][ValidateSet('install','start','stop','status')][string]$Action = 'status',
    [ValidateRange(1,256)][int]$Threads = 6
)
$ErrorActionPreference = 'Stop'
$modelDir = Join-Path $env:LOCALAPPDATA 'STAddonModels\embeddinggemma-2'
$runtimeDir = Join-Path $env:LOCALAPPDATA 'STAddonRuntime\llama-b11982-cpu'
$launcherDir = Join-Path $env:LOCALAPPDATA 'STAddonRuntime\embeddinggemma2-launcher'
$modelPath = Join-Path $modelDir 'embeddinggemma-2-Q8_0.gguf'
$runtimeExe = Join-Path $runtimeDir 'llama-server.exe'
$statePath = Join-Path $launcherDir 'state.json'
$modelSha = '2188ac1deca4b77dffefd603c2776a9d76d9d74ec01841392982ebb840b09135'
$archiveSha = '20cd898fafc269657df8de946b06ef37dcf6b783dfa43d28ac6d187bb6ebfe1e'
$endpoint = 'http://127.0.0.1:8081'

function Read-State {
    if (Test-Path -LiteralPath $statePath) { return Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json }
    return $null
}
function Owned-Process($saved) {
    if (-not $saved) { return $null }
    $proc = Get-Process -Id $saved.pid -ErrorAction SilentlyContinue
    if ($proc -and $proc.Path -eq $runtimeExe -and $proc.StartTime.ToUniversalTime().Ticks.ToString() -eq $saved.startTicks) { return $proc }
    return $null
}
function Health {
    try { return (Invoke-RestMethod -Uri ($endpoint + '/health') -TimeoutSec 2).status -eq 'ok' } catch { return $false }
}
function Listener {
    return Get-NetTCPConnection -LocalPort 8081 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
}
function Show-Status {
    $saved = Read-State
    $owned = Owned-Process $saved
    $listening = Listener
    $listenerPid = $null
    if ($listening) { $listenerPid = $listening.OwningProcess }
    [pscustomobject]@{ endpoint=$endpoint; healthy=(Health); managed=[bool]$owned; listenerPid=$listenerPid;
        statePath=$statePath; modelPresent=(Test-Path -LiteralPath $modelPath); runtimePresent=(Test-Path -LiteralPath $runtimeExe) } | ConvertTo-Json -Compress
}
function Download-Checked([string]$Url, [string]$Target, [string]$Sha) {
    if (Test-Path -LiteralPath $Target) {
        if ((Get-FileHash -LiteralPath $Target -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Sha) { throw "Existing file SHA256 mismatch: $Target" }
        return
    }
    $partial = $Target + '.part'
    & curl.exe --fail --location --silent --show-error --retry 3 --continue-at - --max-time 1800 --output $partial $Url
    if ($LASTEXITCODE -ne 0) { throw "Download interrupted; rerun install to resume: $partial (curl exit $LASTEXITCODE)" }
    if ((Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Sha) { throw "Downloaded SHA256 mismatch: $partial" }
    Move-Item -LiteralPath $partial -Destination $Target
}

switch ($Action) {
    'install' {
        $null = New-Item -ItemType Directory -Path $modelDir,$launcherDir -Force
        Download-Checked 'https://huggingface.co/ggml-org/embeddinggemma-2-GGUF/resolve/58faf90940886df2d62be555c8765d00dac362c5/embeddinggemma-2-Q8_0.gguf' $modelPath $modelSha
        if (-not (Test-Path -LiteralPath $runtimeExe)) {
            $zipPath = Join-Path $launcherDir 'llama-b11982-bin-win-cpu-x64.zip'
            Download-Checked 'https://github.com/ggml-org/llama.cpp/releases/download/b11982/llama-b11982-bin-win-cpu-x64.zip' $zipPath $archiveSha
            Expand-Archive -LiteralPath $zipPath -DestinationPath $runtimeDir -Force
        }
        # b11982 writes --version to stderr; PS5.1 redirection with Stop would misclassify it as an error.
        $versionOut = Join-Path $launcherDir 'version.stdout.log'
        $versionErr = Join-Path $launcherDir 'version.stderr.log'
        $versionProcess = Start-Process -FilePath $runtimeExe -ArgumentList '--version' -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput $versionOut -RedirectStandardError $versionErr
        $version = [IO.File]::ReadAllText($versionOut) + [IO.File]::ReadAllText($versionErr)
        if ($versionProcess.ExitCode -ne 0 -or $version -notmatch '11982' -or $version -notmatch '8a199ad31') { throw 'Expected llama.cpp b11982 / 8a199ad31 runtime.' }
        Show-Status
    }
    'start' {
        if (Owned-Process (Read-State)) { Show-Status; break }
        # A running server, including the research server, is never adopted or replaced.
        if (Listener) { Show-Status; break }
        if (-not (Test-Path -LiteralPath $runtimeExe) -or -not (Test-Path -LiteralPath $modelPath)) { throw 'Run install first.' }
        $null = New-Item -ItemType Directory -Path $launcherDir -Force
        $stdout = Join-Path $launcherDir 'server.stdout.log'
        $stderr = Join-Path $launcherDir 'server.stderr.log'
        $arguments = @('-m', ('"' + $modelPath + '"'), '--no-mmproj', '--embeddings', '--pooling', 'mean', '--embd-normalize', '2',
            '--host', '127.0.0.1', '--port', '8081', '-ngl', '0', '-c', '2048', '-b', '2048', '-ub', '2048', '-np', '1', '-t', $Threads, '-tb', $Threads)
        $child = Start-Process -FilePath $runtimeExe -ArgumentList $arguments -WorkingDirectory $runtimeDir -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
        $saved = [pscustomobject]@{ pid=$child.Id; startTicks=$child.StartTime.ToUniversalTime().Ticks.ToString(); executable=$runtimeExe;
            endpoint=$endpoint; model=$modelPath; modelSha256=$modelSha; runtime='b11982'; threads=$Threads; stdout=$stdout; stderr=$stderr }
        [IO.File]::WriteAllText($statePath, ($saved | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
        $deadline = [DateTime]::UtcNow.AddSeconds(60)
        while ([DateTime]::UtcNow -lt $deadline) {
            if (-not (Owned-Process $saved)) { throw "Owned server exited. Read $stderr" }
            if ((Health) -and (Listener).OwningProcess -eq $child.Id) { Show-Status; return }
            Start-Sleep -Milliseconds 500
        }
        throw "Owned server is not healthy yet. Read $stderr; use status or stop."
    }
    'stop' {
        $owned = Owned-Process (Read-State)
        if ($owned) { Stop-Process -Id $owned.Id; $owned.WaitForExit(10000) | Out-Null }
        if (Owned-Process (Read-State)) { throw 'Owned server did not exit.' }
        # Never stop by port, executable name, or a PID without its recorded start identity.
        if (Test-Path -LiteralPath $statePath) { Remove-Item -LiteralPath $statePath }
        Show-Status
    }
    'status' { Show-Status }
}
