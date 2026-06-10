# =============================================================================
# PreToolUse hook — CLI context ドリフト検出
# =============================================================================
# 入力（stdin JSON）:
#   { "tool_name": "Bash" | "PowerShell", "tool_input": { "command": "..." }, ... }
#
# 出力:
#   - exit 0  : 続行
#   - exit 2  : block + stderr に復旧コマンドを出力
# =============================================================================

$ErrorActionPreference = 'Stop'

# バイパスマーカー（commit 禁止: .gitignore 登録済み）
$skipMarker = Join-Path $PSScriptRoot '..\.skip-context-check'
if (Test-Path $skipMarker) { exit 0 }

# project-context.env を読み込む
$envFile = Join-Path $PSScriptRoot '..\project-context.env'
if (-not (Test-Path $envFile)) { exit 0 }

$expect = @{}
Get-Content $envFile | ForEach-Object {
    $line = $_.Trim()
    if ($line -eq '' -or $line.StartsWith('#')) { return }
    if ($line -match '^([A-Z_][A-Z0-9_]*)=(.*)$') {
        $expect[$matches[1]] = $matches[2].Trim('"').Trim("'")
    }
}

# stdin JSON 取得
$payload = [Console]::In.ReadToEnd()
try { $event = $payload | ConvertFrom-Json } catch { exit 0 }

$cmd = $null
if ($event.tool_input.command) { $cmd = [string]$event.tool_input.command }
if (-not $cmd) { exit 0 }

# === ドリフト検査ヘルパ ===
function Block($message, $recoveryCommands) {
    [Console]::Error.WriteLine("[context-guard] BLOCKED: $message")
    [Console]::Error.WriteLine("[context-guard] 復旧コマンド:")
    foreach ($r in $recoveryCommands) {
        [Console]::Error.WriteLine("  $r")
    }
    [Console]::Error.WriteLine("[context-guard] 一時バイパス: New-Item .claude\.skip-context-check")
    exit 2
}

# === 1. gcloud / gsutil / bq ===
if ($cmd -match '\b(gcloud|gsutil|bq)\b') {
    # --project=xxx の明示フラグが期待値と異なれば block
    if ($cmd -match '--project[= ]([^\s]+)' -and $expect.GCLOUD_PROJECT) {
        $given = $matches[1].Trim('"').Trim("'")
        if ($given -ne $expect.GCLOUD_PROJECT) {
            Block "gcloud --project=$given が期待値 $($expect.GCLOUD_PROJECT) と一致しません" `
                @("gcloud config configurations activate $($expect.GCLOUD_CONFIG)")
        }
    }
    # 現在の active config 検査（重いので skip-marker 推奨）。軽量チェックのみ。
    if ($expect.GCLOUD_PROJECT) {
        $cur = & gcloud config get-value project 2>$null
        if ($cur -and ($cur.Trim() -ne $expect.GCLOUD_PROJECT)) {
            Block "gcloud active project = $cur, 期待値 = $($expect.GCLOUD_PROJECT)" `
                @("gcloud config configurations activate $($expect.GCLOUD_CONFIG)")
        }
    }
}

# === 2. gh ===
if ($cmd -match '\bgh\b' -and $expect.GH_USER) {
    $cur = & gh api user --jq .login 2>$null
    if ($cur -and ($cur.Trim() -ne $expect.GH_USER)) {
        Block "gh active user = $cur, 期待値 = $($expect.GH_USER)" `
            @("gh auth switch --user $($expect.GH_USER)")
    }
}

# === 3. firebase ===
if ($cmd -match '\bfirebase\b' -and $expect.FIREBASE_PROJECT) {
    if ($cmd -match '--project[= ]([^\s]+)') {
        $given = $matches[1].Trim('"').Trim("'")
        if ($given -ne $expect.FIREBASE_PROJECT) {
            Block "firebase --project=$given が期待値と不一致" `
                @("firebase use $($expect.FIREBASE_PROJECT)")
        }
    }
}

# === 4. sf / sfdx ===
if ($cmd -match '\b(sf|sfdx)\b' -and $expect.SF_ORG_ALIAS) {
    if ($cmd -match '(--target-org|-o)[= ]([^\s]+)') {
        $given = $matches[2].Trim('"').Trim("'")
        if ($given -ne $expect.SF_ORG_ALIAS) {
            Block "sf --target-org=$given が期待値と不一致" `
                @("sf config set target-org $($expect.SF_ORG_ALIAS)")
        }
    }
}

exit 0
