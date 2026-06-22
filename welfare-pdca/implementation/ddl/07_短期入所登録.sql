-- ============================================================
-- migrate_07_短期入所登録.sql
-- 短期入所の日次実績登録テーブル
--
-- 設計方針:
--   - 1 利用者 × 1 利用日 = 1 行（疎データ。利用日のみ INSERT）
--   - 既存「01相談記録」と同じ日次レコードパターン
--
-- 関連:
--   - ケース記録 が本テーブルへの FK 列を持つ（11_ケース記録_FK追加.sql で追加）
-- ============================================================

BEGIN;

CREATE TABLE public."短期入所登録" (
    -- 識別子
    "短期入所登録ID"            VARCHAR(255) NOT NULL,
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

    -- 利用類型（短期入所特有・日毎にも変わり得る）
    "利用類型"                  VARCHAR(20),       -- 単独型 / 併設型 / 空床利用型

    -- 利用区分
    "緊急利用フラグ"            BOOLEAN,           -- 緊急短期入所受入加算の根拠

    -- 加算（AppSheet マスタから選択値を文字列保持。送迎・食事も加算扱い）
    "基本報酬"                  VARCHAR(255),
    "加算"                      VARCHAR(255),      -- 例: "単独型加算,医療連携看護職員確保加算,送迎加算"
    "区分選択肢"                VARCHAR(255),      -- 例: "2"（単独型加算 Ⅱ型 等）

    -- 実費（6 月改定で実費 1〜5 まで拡張）
    "実費1"                     VARCHAR(255),
    "実費2"                     VARCHAR(255),
    "実費3"                     VARCHAR(255),
    "実費4"                     VARCHAR(255),
    "実費5"                     VARCHAR(255),

    -- フラグ
    "フラグ"                    BOOLEAN,
    "再請求フラグ"              BOOLEAN,
    "表示フラグ"                BOOLEAN,
    "自動化フラグ"              BOOLEAN,
    "フラグ日時"                TIMESTAMPTZ,

    -- その他
    "障害種別"                  TEXT,
    "本人状況"                  TEXT,
    "世帯状況"                  TEXT,

    CONSTRAINT "短期入所登録_pkey" PRIMARY KEY ("短期入所登録ID")
);

CREATE INDEX "idx_短期入所_登録日時"     ON public."短期入所登録" USING btree ("登録日時");
CREATE INDEX "idx_短期入所_更新日時"     ON public."短期入所登録" USING btree ("更新日時");
CREATE INDEX "idx_短期入所_年月"         ON public."短期入所登録" USING btree ("年月");
CREATE INDEX "idx_短期入所_記録日"       ON public."短期入所登録" USING btree ("記録日");
CREATE INDEX "idx_短期入所_利用者在籍ID" ON public."短期入所登録" USING btree ("利用者在籍ID");
CREATE INDEX "idx_短期入所_利用類型"     ON public."短期入所登録" USING btree ("利用類型");

CREATE UNIQUE INDEX "idx_短期入所_unique_day"
    ON public."短期入所登録" ("利用者在籍ID", "記録日")
    WHERE "フラグ" IS DISTINCT FROM TRUE;

COMMENT ON TABLE  public."短期入所登録"             IS '短期入所の日次実績。1利用者×1利用日=1行';
COMMENT ON COLUMN public."短期入所登録"."記録日"    IS '利用日。Excel暦日LEFT JOINキー';
COMMENT ON COLUMN public."短期入所登録"."利用類型" IS '単独型/併設型/空床利用型。請求単価の分岐キー';

COMMIT;
