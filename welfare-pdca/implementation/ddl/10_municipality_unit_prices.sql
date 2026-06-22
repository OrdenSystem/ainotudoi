-- ============================================================
-- migrate_10_municipality_unit_prices.sql
-- 日中一時支援の単価マスタ（市町村別 × 時間区分別）
--
-- 設計方針:
--   - 単価改定（報酬改定）対応のため有効期間を持つ
--   - 同一市町村×時間区分では現在有効なレコードは 1 件のみ
--   - 過去の単価は履歴として残す（過去レコード再請求対応）
--
-- 参照: 03-cloudsql-and-docs.md §8-2
-- 前提: 09_municipalities.sql が先に適用済
-- ============================================================

BEGIN;

CREATE TABLE public.municipality_unit_prices (
    price_id            VARCHAR(255) NOT NULL,
    shichoson_id        VARCHAR(50) NOT NULL,   -- FK → municipalities
    jikan_kubun         VARCHAR(20) NOT NULL,   -- 時間区分（'2h未満' / '2h〜4h' / '4h以上' 等）
    tanka               NUMERIC(10,2) NOT NULL, -- 単価（円）
    yuko_kaishi         DATE NOT NULL,          -- 有効開始日
    yuko_shuryo         DATE,                   -- 有効終了日（NULL = 現在有効）
    biko                TEXT,
    toroku_nichiji      TIMESTAMPTZ DEFAULT now(),
    koushin_nichiji     TIMESTAMPTZ,

    CONSTRAINT municipality_unit_prices_pkey PRIMARY KEY (price_id),
    CONSTRAINT fk_mup_shichoson FOREIGN KEY (shichoson_id)
        REFERENCES public.municipalities (shichoson_id) ON DELETE RESTRICT
);

CREATE INDEX idx_mup_shichoson_jikan
    ON public.municipality_unit_prices (shichoson_id, jikan_kubun);
CREATE INDEX idx_mup_yuko
    ON public.municipality_unit_prices (yuko_kaishi, yuko_shuryo);

-- 現在有効な単価は市町村×時間区分で 1 件のみ
CREATE UNIQUE INDEX idx_mup_unique_active
    ON public.municipality_unit_prices (shichoson_id, jikan_kubun)
    WHERE yuko_shuryo IS NULL;

COMMENT ON TABLE  public.municipality_unit_prices IS '日中一時支援の単価マスタ。市町村×時間区分×有効期間';
COMMENT ON COLUMN public.municipality_unit_prices.yuko_shuryo IS 'NULL=現在有効、日付あり=過去履歴';

COMMIT;
