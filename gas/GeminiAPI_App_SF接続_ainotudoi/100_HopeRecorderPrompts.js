/**
 * HopeRecorder プロンプト・モデル設定レジストリ
 *
 * 設計方針:
 *   - プロンプト本文・モデル・温度・トークン上限・話者ダイアライゼーション設定をすべて
 *     ここに集約し、101_HopeRecorder.js は HOPE_RECORDER_ACTIVE 経由で参照する。
 *   - V1（旧版・ロールバック用）と V2（新版）を併存させ、最終行の HOPE_RECORDER_ACTIVE を
 *     差し替える 1 行変更で版を切り替えられる。プロンプト変更ごとに V3, V4… と接尾子を増やす。
 *
 * 参照元:
 *   - processTranscriptionWorker  (Batch 投入)
 *   - callGeminiProToCleanText_   (Cleaning)
 *
 * バージョン履歴:
 *   V1 (2026-04 まで): gemini-2.5-flash, 「重要度低い雑談はカット」方針。
 *   V2 (2026-04-27～): gemini-2.5-pro, 原文最大保持 + ハルシネーション抑制 + 自己検証セクション。
 *
 * コスト注意:
 *   V2 は gemini-2.5-pro に切り替わるため、Vertex Batch 課金が flash 比 3〜4 倍になる見込み。
 *   月次の Vertex 課金を継続モニタすること。
 *
 * セキュリティ TODO（次スプリント）:
 *   V2 は原文最大保持方針のため、利用者の氏名・住所・症状等が Vertex AI / Gemini API に
 *   平文で渡される量が V1 比で増える。次スプリントでマスキング層導入が必須。
 *   関連: 計画書 7-reactive-wombat.md「リスクと留意」「次スプリント候補 2 番」。
 */

// =====================================================================
// V1: 旧プロンプト・旧パラメータ（ロールバック専用、本番非選択）
// =====================================================================

const BATCH_PROMPT_V1 = `
# 命令
あなたは医療・介護・福祉分野の相談員で、高度な専門分析AIです。
提供された長い音声データ（面談記録）を最初から最後まで聞き取り、詳細な記録を「事実のみ」に基づき作成してください。

# 制約
1. 【詳細会話ログ】の作成方針：
  - 全文（ベタ打ち）の書き起こしではなく、意味のある発言単位で「逐語録（セリフ）」を作成してください。
  - 要約文に変換せず、本人の口調（「～です」「～だよね」等）を維持したまま、重要な発言を「抜き出し」てください。
2. 【面談サマリー】および【分析】：
  - 音声内に「直接現れた言葉」と「そこから読み取れる事実」のみを記述してください。
3. 文字数制限への対応：
  - 重要度の低い雑談などは適宜カットし、核心的な相談内容に集中して記述してください。

# 出力形式
【面談サマリー】
【詳細会話ログ】
【話者別分析】
【リスク管理と決定事項】
`;

// 末尾の「# 入力テキスト:」の直後に rawText が文字列結合される（callGeminiProToCleanText_ 参照）。
const CLEANING_PROMPT_V1_SYSTEM = `
# 命令
あなたは医療・介護・福祉分野の高度な専門分析AIです。情報の重複を整理し、専門的な最終報告書として整形してください。
# 最重要制約
1. 挨拶や前置きは一切禁止。
2. 出力は必ず【面談サマリー】から開始してください。
# 入力テキスト:
`;

const HOPE_RECORDER_V1 = {
  version: 'v1',
  batch: {
    model: 'gemini-2.5-flash',
    temperature: 0.2,
    maxOutputTokens: 8192,
    speechConfig: {
      enableSpeakerDiarization: true,
      minSpeakerCount: 2,
      maxSpeakerCount: 3
    },
    prompt: BATCH_PROMPT_V1
  },
  cleaning: {
    model: 'gemini-2.5-pro',
    temperature: 0.1,
    promptSystem: CLEANING_PROMPT_V1_SYSTEM
  }
};

// =====================================================================
// V2: 新プロンプト・新パラメータ（2026-04-27 〜）
//   方針:
//     1. 原文を最大限保持（カット指示を撤回）
//     2. ハルシネーション抑制（音声に無い情報の創作を禁止、繰り返し検出時は省略）
//     3. 長尺対応（maxOutputTokens を 8192 → 65536）
//     4. 話者数上限を 3 → 6（介護面談で家族・関係者複数同席ケースに対応）
//     5. 自己検証セクションで Chain-of-Verification 的な効果を検証（実験）
//     6. Batch temperature は 0.0 ではなく 0.1（degenerate output 回避マージン、
//        逐語録の口調表現の保持、局所最適への固着防止）
//     7. 整形 temperature は 0.0（純粋な編集タスク、再現性最優先）
// =====================================================================

const BATCH_PROMPT_V2 = `
# 最強制約（絶対遵守）
1. 音声に存在しない情報は一切創作しない。推測・想像・補完は禁止。
2. 不明瞭な区間は「（聞き取れず）」または「（不明瞭）」と明記する。
   全体の 5% を超えると判断した場合は、出力冒頭に「※全体の約 N% に不明瞭区間あり」と注意書きを置く。
3. 同一発話・同一句が繰り返し検出された場合、初出のみ記録し以降は「（既出のため省略）」とのみ記す。
   逐次再列挙してはならない（degenerate output 防止）。

# 命令
あなたは医療・介護・福祉分野の相談員で、高度な専門分析AIです。
提供された音声データ（面談記録）を最初から最後まで聞き取り、原文を最大限保持した詳細記録を作成してください。

# 詳細会話ログの作成方針（重要）
- 全発言を「逐語録（セリフ）」として抜き出すこと。
- 雑談・前置き・余談・沈黙の説明であっても、音声に現れた発言は原則として残すこと。
  「重要度が低い」という理由でのカット、要約、短縮は禁止。
- 本人の口調（「～です」「～だよね」「～ですわ」等）を維持し、書き換えない。
- 言い淀み（「えーと」「あの」等）も、意味の理解に関与する場合は残す。
- 話者ラベル（speaker_1, speaker_2, ...）は連続発話で固定し、声質変化が無い限り入れ替えない。

# サマリー・分析セクションの方針
- 「音声内に直接現れた言葉」と「そこから読み取れる事実」のみを記述。
- 推論・解釈・憶測は禁止。

# 出力形式
【面談サマリー】
【詳細会話ログ】
【話者別分析】
【リスク管理と決定事項】
【自己検証】
- 上記内容は音声に基づくか: YES / NO
- NO の場合、どの記述が音声に存在しないか具体的に列挙
- 全体に対する不明瞭区間の概算割合: N%
`;

// 末尾の「# 入力テキスト:」の直後に rawText が文字列結合される（callGeminiProToCleanText_ 参照）。
const CLEANING_PROMPT_V2_SYSTEM = `
# 最強制約（絶対遵守）
1. 入力テキストの情報は一切削除・短縮・要約しない。
2. 新情報・推論・解釈・補完は一切追加しない。入力に無い人名・症状・固有名詞を出してはならない。
3. 入力テキストに無い章を勝手に作らない。

# 命令
あなたは医療・介護・福祉分野の専門編集AIです。入力テキストに対し、以下のみを実行してください:
- 重複表現の整理（同じ発言が連続列挙されている場合は1回にまとめ「（既出のため省略）」と記す）
- 章立ての整形（【面談サマリー】【詳細会話ログ】【話者別分析】【リスク管理と決定事項】の見出しが揃っていなければ揃える。【自己検証】が含まれる場合はそのまま保持）
- フォーマットの統一（インデント・改行・記号の統一）

挨拶・前置き・所感は一切禁止。出力は必ず【面談サマリー】から開始すること。

# 入力テキスト:
`;

const HOPE_RECORDER_V2 = {
  version: 'v2',
  batch: {
    model: 'gemini-2.5-pro',
    temperature: 0.1,
    maxOutputTokens: 65536,
    speechConfig: {
      enableSpeakerDiarization: true,
      minSpeakerCount: 2,
      maxSpeakerCount: 6
    },
    prompt: BATCH_PROMPT_V2
  },
  cleaning: {
    model: 'gemini-2.5-pro',
    temperature: 0.0,
    promptSystem: CLEANING_PROMPT_V2_SYSTEM
  }
};

// =====================================================================
// アクティブ版の選択（ロールバック時はここを HOPE_RECORDER_V1 に戻す）
// =====================================================================
const HOPE_RECORDER_ACTIVE = HOPE_RECORDER_V2;

/**
 * 検証用：現在アクティブな版の中身をログに出す。
 */
function dump_HopeRecorderConfig() {
  Logger.log('===== HopeRecorder Active Config =====');
  Logger.log('version: ' + HOPE_RECORDER_ACTIVE.version);
  Logger.log('batch.model: ' + HOPE_RECORDER_ACTIVE.batch.model);
  Logger.log('batch.temperature: ' + HOPE_RECORDER_ACTIVE.batch.temperature);
  Logger.log('batch.maxOutputTokens: ' + HOPE_RECORDER_ACTIVE.batch.maxOutputTokens);
  Logger.log('batch.speechConfig: ' + JSON.stringify(HOPE_RECORDER_ACTIVE.batch.speechConfig));
  Logger.log('cleaning.model: ' + HOPE_RECORDER_ACTIVE.cleaning.model);
  Logger.log('cleaning.temperature: ' + HOPE_RECORDER_ACTIVE.cleaning.temperature);
  Logger.log('batch.prompt length: ' + HOPE_RECORDER_ACTIVE.batch.prompt.length);
  Logger.log('cleaning.promptSystem length: ' + HOPE_RECORDER_ACTIVE.cleaning.promptSystem.length);
}
