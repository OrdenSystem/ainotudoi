-- ============================================================
-- migrate_11_ケース記録_FK追加.sql
-- 既存「ケース記録」テーブルに入所系 3 サービス向けの親 FK 列を追加
--
-- 設計方針:
--   - ユーザー方針: 既存「ケース記録 + ケースマスタ」を入所系でも流用
--   - 案 A 採用: 親テーブル別の個別 FK 列を追加（多態的 polymorphic は不採用）
--   - 既存「相談記録ID」は温存（後方互換）
--   - 親が決まると 4 列のうち 1 列に値が入る形
--
-- 影響:
--   - ケース記録 既存行への影響なし（新 3 列は NULL で追加）
--   - 既存 GAS / AppSheet ロジックは「相談記録ID」のみ参照のため非破壊
--
-- 前提: 06〜08 が先に適用済
-- ============================================================

BEGIN;

ALTER TABLE public."ケース記録"
    ADD COLUMN IF NOT EXISTS "児童入所登録ID" VARCHAR(255),
    ADD COLUMN IF NOT EXISTS "短期入所登録ID" VARCHAR(255),
    ADD COLUMN IF NOT EXISTS "日中一時登録ID" VARCHAR(255);

-- 親検索用 INDEX（NULL を除いた部分 INDEX）
CREATE INDEX IF NOT EXISTS "idx_ケース_児童入所登録ID"
    ON public."ケース記録" ("児童入所登録ID")
    WHERE "児童入所登録ID" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "idx_ケース_短期入所登録ID"
    ON public."ケース記録" ("短期入所登録ID")
    WHERE "短期入所登録ID" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "idx_ケース_日中一時登録ID"
    ON public."ケース記録" ("日中一時登録ID")
    WHERE "日中一時登録ID" IS NOT NULL;

COMMENT ON COLUMN public."ケース記録"."児童入所登録ID" IS '児童入所登録テーブル(児童入所登録ID)への参照。多態性のためFK制約なし、4列のうち1列のみに値が入る';
COMMENT ON COLUMN public."ケース記録"."短期入所登録ID" IS '短期入所登録テーブル(短期入所登録ID)への参照';
COMMENT ON COLUMN public."ケース記録"."日中一時登録ID" IS '日中一時登録テーブル(日中一時登録ID)への参照';

COMMIT;
