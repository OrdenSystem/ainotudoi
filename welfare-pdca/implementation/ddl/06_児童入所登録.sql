-- ============================================================
-- migrate_06_児童入所登録.sql
-- 児童入所施設の日次実績登録テーブル
--
-- 設計方針:
--   - 1 利用者 × 1 日 = 1 行（疎データ。実績がある日のみ INSERT）
--   - 既存「01相談記録」と同じ日次レコードパターン
--   - GAS が Excel 出力時に「暦日マスタ（1〜月末日）と LEFT JOIN」して 28〜31 行を展開
--
-- 命名規約:
--   - テーブル名・列名は日本語（既存「01相談記録」と統一）
--   - UI 表示と一致するよう「登録」を採用（DB 名から統一）
--
-- 関連:
--   - ケース記録 が本テーブルへの FK 列を持つ（11_ケース記録_FK追加.sql で追加）
--
-- 参照: decisions-2026-06-22 §7 / 計画書 §2.8
-- ============================================================

BEGIN;

CREATE TABLE public."児童入所登録" (
    -- 識別子
    "児童入所登録ID"            VARCHAR(255) NOT NULL,
    "年月日_利用者在籍ID"       VARCHAR(255),

    -- 利用者・職員参照
    "利用者ID"                  VARCHAR(255),
    "利用者在籍ID"              VARCHAR(255),
    "利用者氏名"                VARCHAR(255),
    "職員在籍ID"                VARCHAR(255),
    "事業所"                    VARCHAR(255),

    -- 期間・記録（日次キー）
    "年月"                      VARCHAR(7),
    "記録日"                    DATE NOT NULL,
    "日"                        VARCHAR(2),
    "登録日時"                  TIMESTAMPTZ,
    "更新日時"                  TIMESTAMPTZ,
    "UserMail"                  VARCHAR(255),

    -- 日別状態（日次粒度の本質）
    "利用状態"                  VARCHAR(20),       -- 在籍 / 入院 / 外泊 / 退所中
    "利用状態備考"              TEXT,

    -- 契約・施設区分
    "契約区分"                  VARCHAR(20),       -- 契約 / 措置 / 措置→契約
    "公立フラグ"                BOOLEAN,

    -- 加算（既存「01相談記録」と同パターン: AppSheet マスタから選択値を文字列保持）
    -- 加算の正規データは AppSheet DB「001_事業所加算マスタ」「001_利用者加算マスタ」側
    "基本報酬"                  VARCHAR(255),      -- 例: "基本報酬Ⅰ"
    "加算"                      VARCHAR(255),      -- 例: "自活訓練加算,看護師配置加算"（複数は ,区切り）
    "区分選択肢"                VARCHAR(255),      -- 例: "2" や "1,2"（各加算の区分番号 Ⅰ=1 / Ⅱ=2 等）

    -- 実費（6 月改定で実費 1〜5 まで拡張）
    "実費1"                     VARCHAR(255),
    "実費2"                     VARCHAR(255),
    "実費3"                     VARCHAR(255),
    "実費4"                     VARCHAR(255),
    "実費5"                     VARCHAR(255),

    -- フラグ（既存「01相談記録」と同パターン）
    "フラグ"                    BOOLEAN,            -- 請求完了フラグ
    "再請求フラグ"              BOOLEAN,
    "表示フラグ"                BOOLEAN,
    "自動化フラグ"              BOOLEAN,
    "フラグ日時"                TIMESTAMPTZ,

    -- その他
    "障害種別"                  TEXT,
    "本人状況"                  TEXT,
    "世帯状況"                  TEXT,

    CONSTRAINT "児童入所登録_pkey" PRIMARY KEY ("児童入所登録ID")
);

CREATE INDEX "idx_児童入所_登録日時"     ON public."児童入所登録" USING btree ("登録日時");
CREATE INDEX "idx_児童入所_更新日時"     ON public."児童入所登録" USING btree ("更新日時");
CREATE INDEX "idx_児童入所_年月"         ON public."児童入所登録" USING btree ("年月");
CREATE INDEX "idx_児童入所_記録日"       ON public."児童入所登録" USING btree ("記録日");
CREATE INDEX "idx_児童入所_利用者在籍ID" ON public."児童入所登録" USING btree ("利用者在籍ID");

-- 日次一意制約（同一利用者×同一日の二重登録防止。再請求時は通す）
CREATE UNIQUE INDEX "idx_児童入所_unique_day"
    ON public."児童入所登録" ("利用者在籍ID", "記録日")
    WHERE "フラグ" IS DISTINCT FROM TRUE;

COMMENT ON TABLE  public."児童入所登録"             IS '児童入所施設の日次実績。1利用者×1日=1行';
COMMENT ON COLUMN public."児童入所登録"."記録日"    IS '記録日。Excel暦日LEFT JOINキー';
COMMENT ON COLUMN public."児童入所登録"."利用状態" IS '在籍/入院/外泊/退所中。請求日数は ''在籍'' 件数で算出';
COMMENT ON COLUMN public."児童入所登録"."フラグ"   IS '請求完了フラグ。TRUE=請求済';

COMMIT;
