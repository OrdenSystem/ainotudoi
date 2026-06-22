-- ============================================================
-- migrate_10_日中一時単価マスタ.sql
-- 日中一時支援の単価マスタ（市町村別 × 時間区分別）
--
-- 設計方針:
--   - 単価改定（報酬改定）対応のため有効期間を持つ
--   - 同一市町村×時間区分では現在有効なレコードは 1 件のみ
--   - 過去の単価は履歴として残す（過去レコード再請求対応）
--
-- 前提: 09_市町村マスタ.sql が先に適用済
-- ============================================================

BEGIN;

CREATE TABLE public."日中一時単価マスタ" (
    "単価ID"            VARCHAR(255) NOT NULL,
    "市町村ID"          VARCHAR(50) NOT NULL,
    "時間区分"          VARCHAR(20) NOT NULL,
    "単価"              NUMERIC(10,2) NOT NULL,
    "有効開始日"        DATE NOT NULL,
    "有効終了日"        DATE,
    "備考"              TEXT,
    "登録日時"          TIMESTAMPTZ DEFAULT now(),
    "更新日時"          TIMESTAMPTZ,

    CONSTRAINT "日中一時単価マスタ_pkey" PRIMARY KEY ("単価ID"),
    CONSTRAINT "fk_単価_市町村" FOREIGN KEY ("市町村ID")
        REFERENCES public."市町村マスタ" ("市町村ID") ON DELETE RESTRICT
);

CREATE INDEX "idx_単価_市町村_時間区分"
    ON public."日中一時単価マスタ" ("市町村ID", "時間区分");
CREATE INDEX "idx_単価_有効期間"
    ON public."日中一時単価マスタ" ("有効開始日", "有効終了日");

-- 現在有効な単価は市町村×時間区分で 1 件のみ
CREATE UNIQUE INDEX "idx_単価_unique_active"
    ON public."日中一時単価マスタ" ("市町村ID", "時間区分")
    WHERE "有効終了日" IS NULL;

COMMENT ON TABLE  public."日中一時単価マスタ"             IS '日中一時支援の単価マスタ。市町村×時間区分×有効期間';
COMMENT ON COLUMN public."日中一時単価マスタ"."有効終了日" IS 'NULL=現在有効、日付あり=過去履歴';

COMMIT;
