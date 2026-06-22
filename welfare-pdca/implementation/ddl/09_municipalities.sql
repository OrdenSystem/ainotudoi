-- ============================================================
-- migrate_09_municipalities.sql
-- 市町村マスタ（軽量参照用）
--
-- 既存 CloudSQL には市町村マスタが存在しない。
-- SoT は Salesforce Account（自治体）。CloudSQL 側は参照用キャッシュ。
-- 日中一時支援の単価引きには市町村コードが必要なため設置。
--
-- 参照: 03-cloudsql-and-docs.md §8-1
-- ============================================================

BEGIN;

CREATE TABLE public.municipalities (
    shichoson_id        VARCHAR(50) NOT NULL,   -- SF Account ID（18 桁）または独自コード
    shichoson_number    VARCHAR(20),            -- 市町村番号（リタリコ Excel に現れる番号）
    shichoson_name      VARCHAR(255) NOT NULL,
    prefecture          VARCHAR(50),            -- 都道府県
    is_active           BOOLEAN DEFAULT TRUE,
    toroku_nichiji      TIMESTAMPTZ DEFAULT now(),
    koushin_nichiji     TIMESTAMPTZ,

    CONSTRAINT municipalities_pkey PRIMARY KEY (shichoson_id)
);

CREATE UNIQUE INDEX idx_muni_number
    ON public.municipalities (shichoson_number)
    WHERE shichoson_number IS NOT NULL;

CREATE INDEX idx_muni_active
    ON public.municipalities (is_active)
    WHERE is_active = TRUE;

COMMENT ON TABLE  public.municipalities IS '市町村マスタ。SoTはSFのAccount(自治体)、本テーブルは参照キャッシュ';
COMMENT ON COLUMN public.municipalities.shichoson_id IS 'SF Account 18桁ID または独自コード（自治体未登録時のフォールバック）';
COMMENT ON COLUMN public.municipalities.shichoson_number IS 'リタリコExcel上の市町村番号';

COMMIT;
