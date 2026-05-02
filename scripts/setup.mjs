#!/usr/bin/env node
// AppsheetMCP セットアップスクリプト
// - everything-claude-code (ECG) を ~/.claude/everything-claude-code/ に同期する
// - 既存なら最新化 (git pull --rebase --autostash)、無ければ git clone
// - ECG が同期されると Claude Code がそのプラグイン群を認識可能になる
//
// 使い方:
//   npm run setup
// または直接:
//   node scripts/setup.mjs

import { execSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ECG_REPO = "https://github.com/affaan-m/everything-claude-code.git";
const ECG_DIR = join(homedir(), ".claude", "everything-claude-code");

const c = {
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  ng: (s) => `\x1b[31m${s}\x1b[0m`,
  dim: (s) => `\x1b[90m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", shell: false, ...opts });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} が失敗 (exit ${r.status})`);
  }
}

function hasGit() {
  try {
    execSync("git --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function isGitRepo(dir) {
  return existsSync(join(dir, ".git"));
}

async function main() {
  console.log(c.bold("AppsheetMCP セットアップ"));
  console.log(c.dim(`ECG リポジトリ: ${ECG_REPO}`));
  console.log(c.dim(`配置先: ${ECG_DIR}`));
  console.log();

  if (!hasGit()) {
    console.error(c.ng("✗ git コマンドが見つかりません。先に git をインストールしてください。"));
    process.exit(1);
  }

  if (existsSync(ECG_DIR)) {
    if (!isGitRepo(ECG_DIR)) {
      console.error(
        c.ng(`✗ ${ECG_DIR} は git リポジトリではありません。手動で削除するか別パスに退避してください。`),
      );
      process.exit(1);
    }
    console.log(c.bold("既存の ECG を最新化します..."));
    try {
      run("git", ["-C", ECG_DIR, "pull", "--rebase", "--autostash"]);
      console.log(c.ok("✅ ECG を最新化しました"));
    } catch (e) {
      console.error(c.ng(`✗ ECG の更新に失敗: ${e.message}`));
      console.error(c.dim("→ ECG ディレクトリでローカル変更が衝突している可能性。手動で解決してください。"));
      process.exit(1);
    }
  } else {
    console.log(c.bold("ECG を clone します..."));
    try {
      run("git", ["clone", "--depth=1", ECG_REPO, ECG_DIR]);
      console.log(c.ok("✅ ECG を clone しました"));
    } catch (e) {
      console.error(c.ng(`✗ ECG の clone に失敗: ${e.message}`));
      process.exit(1);
    }
  }

  console.log();
  console.log(c.bold("=== 完了 ==="));
  console.log(c.dim("AppsheetMCP のサブエージェントは .claude/agents/ から自動認識されます。"));
  console.log(c.dim("ECG のサブエージェント・スキル・コマンドは ~/.claude/everything-claude-code/ から認識されます。"));
  console.log(c.dim("Claude Code を再起動すると両方が利用可能になります。"));
}

main().catch((e) => {
  console.error(c.ng(`✗ セットアップ失敗: ${e.message}`));
  process.exit(1);
});
