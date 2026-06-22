-- ============================================================
-- migrate_09_市町村マスタ.sql
-- 市町村マスタ（軽量参照用）
--
-- 既存 CloudSQL には市町村マスタが存在しない。
-- SoT は Salesforce Account（自治体）。CloudSQL 側は参照用キャッシュ。
-- 日中一時支援の単価引きには市町村コードが必要なため設置。
-- ============================================================

BEGIN;

CREATE TABLE public."市町村マスタ" (
    "市町村ID"          VARCHAR(50) NOT NULL,    -- SF Account 18桁ID または独自コード
    "市町村番号"        VARCHAR(20),
    "市町村名"          VARCHAR(255) NOT NULL,
    "都道府県"          VARCHAR(50),
    "有効フラグ"        BOOLEAN DEFAULT TRUE,
    "登録日時"          TIMESTAMPTZ DEFAULT now(),
    "更新日時"          TIMESTAMPTZ,

    CONSTRAINT "市町村マスタ_pkey" PRIMARY KEY ("市町村ID")
);

CREATE UNIQUE INDEX "idx_市町村_番号"
    ON public."市町村マスタ" ("市町村番号")
    WHERE "市町村番号" IS NOT NULL;

CREATE INDEX "idx_市町村_有効"
    ON public."市町村マスタ" ("有効フラグ")
    WHERE "有効フラグ" = TRUE;

COMMENT ON TABLE  public."市町村マスタ"             IS '市町村マスタ。SoTはSFのAccount(自治体)、本テーブルは参照キャッシュ';
COMMENT ON COLUMN public."市町村マスタ"."市町村ID" IS 'SF Account 18桁ID または独自コード';
COMMENT ON COLUMN public."市町村マスタ"."市町村番号" IS 'リタリコExcel上の市町村番号';

COMMIT;
