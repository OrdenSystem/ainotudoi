-- ============================================================
-- migrate_08_日中一時登録.sql
-- 日中一時支援の日次実績登録テーブル
--
-- 設計方針:
--   - 1 利用者 × 1 利用日 × 1 市町村 = 1 行
--   - 市町村事業（国保連経由なし）のため単価は日中一時単価マスタから取得
--   - 同日に複数市町村を利用するケースは制度上稀だが UNIQUE は 3 キー
--
-- 関連:
--   - 市町村マスタ への FK は持たない（運用簡素化、市町村ID は VARCHAR 参照）
--   - ケース記録 が本テーブルへの FK 列を持つ（11_ケース記録_FK追加.sql で追加）
-- ============================================================

BEGIN;

CREATE TABLE public."日中一時登録" (
    -- 識別子
    "日中一時登録ID"            VARCHAR(255) NOT NULL,
    "年月日_利用者在籍ID"       VARCHAR(255),

    -- 利用者・職員参照
    "利用者ID"                  VARCHAR(255),
    "利用者在籍ID"              VARCHAR(255),
    "利用者氏名"                VARCHAR(255),
    "職員在籍ID"                VARCHAR(255),
    "事業所"                    VARCHAR(255),

    -- 市町村参照（単価マスタの分岐キー）
    "市町村ID"                  VARCHAR(50),
    "市町村名"                  VARCHAR(255),
    "市町村番号"                VARCHAR(20),

    -- 期間・記録（日次キー）
    "年月"                      VARCHAR(7),
    "記録日"                    DATE NOT NULL,
    "日"                        VARCHAR(2),
    "登録日時"                  TIMESTAMPTZ,
    "更新日時"                  TIMESTAMPTZ,
    "UserMail"                  VARCHAR(255),

    -- 利用時間・区分
    "開始時刻"                  TIME,
    "終了時刻"                  TIME,
    "利用時間分"                INTEGER,
    "時間区分"                  VARCHAR(20),       -- 例: 2h未満 / 2h〜4h / 4h以上

    -- 単価（GAS が単価マスタから引いて書込・非正規化保持）
    "適用単価"                  NUMERIC(10,2),
    "単価バージョン"            VARCHAR(50),

    -- 加算（AppSheet マスタから選択値を文字列保持）
    "基本報酬"                  VARCHAR(255),
    "加算"                      VARCHAR(255),      -- 例: "強度行動障害支援加算,送迎加算"
    "区分選択肢"                VARCHAR(255),      -- 例: "基礎"（強度行動障害支援加算 基礎/実践 等）

    -- 実費
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

    CONSTRAINT "日中一時登録_pkey" PRIMARY KEY ("日中一時登録ID")
);

CREATE INDEX "idx_日中一時_登録日時"     ON public."日中一時登録" USING btree ("登録日時");
CREATE INDEX "idx_日中一時_更新日時"     ON public."日中一時登録" USING btree ("更新日時");
CREATE INDEX "idx_日中一時_年月"         ON public."日中一時登録" USING btree ("年月");
CREATE INDEX "idx_日中一時_記録日"       ON public."日中一時登録" USING btree ("記録日");
CREATE INDEX "idx_日中一時_利用者在籍ID" ON public."日中一時登録" USING btree ("利用者在籍ID");
CREATE INDEX "idx_日中一時_市町村ID"     ON public."日中一時登録" USING btree ("市町村ID");
CREATE INDEX "idx_日中一時_時間区分"     ON public."日中一時登録" USING btree ("時間区分");

CREATE UNIQUE INDEX "idx_日中一時_unique_day"
    ON public."日中一時登録" ("利用者在籍ID", "記録日", "市町村ID")
    WHERE "フラグ" IS DISTINCT FROM TRUE;

COMMENT ON TABLE  public."日中一時登録"             IS '日中一時支援の日次実績。1利用者×1利用日×1市町村=1行';
COMMENT ON COLUMN public."日中一時登録"."市町村ID" IS '市町村マスタ参照キー（FK 制約は付けない）';
COMMENT ON COLUMN public."日中一時登録"."適用単価" IS 'GAS が日中一時単価マスタから引いて書込（非正規化）';

COMMIT;
