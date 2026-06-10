# =============================================================================
# SessionStart hook — 軽量・ノンブロッキング
# =============================================================================
# 目的:
#   - プロジェクト専用 CLI context を冪等に activate
#   - 外部 CLI 呼び出しは最小限に抑え、起動を遅延させない
#   - 実ガード（ドリフト検出）は PreToolUse 側で行うため、ここでは止めない
# =============================================================================

$ErrorActionPreference = 'SilentlyContinue'

$envFile = Join-Path $PSScriptRoot '..\project-context.env'
if (-not (Test-Path $envFile)) {
    # 期待値ファイルが無い場合は何もしない（CLAUDE.md が指示する）
    exit 0
}

# .env を読み込んで $env:* に展開（簡易パーサ）
Get-Content $envFile | ForEach-Object {
    $line = $_.Trim()
    if ($line -eq '' -or $line.StartsWith('#')) { return }
    if ($line -match '^([A-Z_][A-Z0-9_]*)=(.*)$') {
        $name  = $matches[1]
        $value = $matches[2].Trim('"').Trim("'")
        if ($value -ne '') {
            Set-Item -Path "env:$name" -Value $value
        }
    }
}

# gcloud config の activate のみ冪等に実行（軽量）。失敗しても止めない。
if ($env:GCLOUD_CONFIG) {
    Start-Job -ScriptBlock {
        param($cfg) & gcloud config configurations activate $cfg 2>$null | Out-Null
    } -ArgumentList $env:GCLOUD_CONFIG | Out-Null
}

exit 0
