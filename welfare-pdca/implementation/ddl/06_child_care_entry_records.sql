-- ============================================================
-- migrate_06_child_care_entry.sql
-- 児童入所施設の月次実績テーブル（日次レコード設計）
--
-- 設計方針:
--   - 1 利用者 × 1 日 = 1 行（疎データ。実績がある日のみ INSERT）
--   - 既存「01相談記録」と同等の日次レコードパターン
--   - GAS が Excel 出力時に「暦日マスタ（1〜月末日）と LEFT JOIN」して 28〜31 行を展開
--   - 月次合計は SELECT/SUM で算出（DB に持たない）
--
-- 対応 SF オブジェクト: ChildCareEntryRecord__c（新設予定）
-- 対応 AppSheet テーブル: 児童入所施設記録（新設予定）
-- 参照: decisions-2026-06-22 §7 / 計画書 §2.8
-- ============================================================

BEGIN;

CREATE TABLE public.child_care_entry_records (
    -- ---- 識別子 ----
    record_id               VARCHAR(255) NOT NULL,
    nengetsu_bi_riyousha_id VARCHAR(255),           -- 年月日_利用者在籍ID（GAS 集計キー）

    -- ---- 利用者・職員参照（SF オブジェクト ID） ----
    riyousha_id             VARCHAR(255),           -- SF Customer__c ID
    riyousha_zaiseki_id     VARCHAR(255),           -- SF CustomerStatus__c ID
    riyousha_shimei         VARCHAR(255),
    shokuin_zaiseki_id      VARCHAR(255),           -- SF StaffStatus__c ID
    jigyousho               VARCHAR(255),

    -- ---- 期間・記録（日次キー） ----
    nengetsu                VARCHAR(7),             -- 'YYYY-MM' 月次集計キー
    kiroku_bi               DATE NOT NULL,          -- 記録日（この行が示す具体的な日付）
    nichi                   VARCHAR(2),             -- 日 '01'〜'31'（Excel 行マッピング用）
    toroku_nichiji          TIMESTAMPTZ,
    koushin_nichiji         TIMESTAMPTZ,
    user_mail               VARCHAR(255),

    -- ---- 日別状態（最重要・日次粒度の意味を担う） ----
    riyo_jotai              VARCHAR(20),            -- '在籍' / '入院' / '外泊' / '退所中'
                                                    -- ※ '退所中' は契約継続中の不在日。'在籍' = 請求対象日
    riyo_jotai_biko         TEXT,                   -- 状態の補足（入院先・外泊先など）

    -- ---- 措置/契約区分（月初〜月末で変わる可能性があるため日次保持） ----
    keiyaku_kubun           VARCHAR(20),            -- '契約' / '措置' / '措置→契約'

    -- ---- 公立フラグ（公立施設の場合に加算計算が変わる） ----
    kouritsu_flag           BOOLEAN,

    -- ---- 加算（日次フラグ。リタリコ Excel ヘッダー確定後に列名を固定） ----
    kihon_hoshu             VARCHAR(255),           -- 基本報酬区分（その日適用された区分）
    kasan                   VARCHAR(255),           -- 主加算（複数はカンマ区切り）
    jikatsu_kunren_kasan    BOOLEAN,                -- 自活訓練加算
    kango_shi_haichi_kasan  BOOLEAN,                -- 看護師配置加算
    eiyoushi_haichi_kasan   BOOLEAN,                -- 栄養士配置加算
    iryo_renkei_kasan       BOOLEAN,                -- 医療連携体制加算（日次・看護師訪問日に True）
    fukushi_kaigo_shoguu_kasan VARCHAR(255),        -- 福祉・介護職員等処遇改善加算（その日適用区分）

    -- ---- 実費（リタリコ 6月改定で実費 1〜5 まで拡張） ----
    jippi_1                 VARCHAR(255),
    jippi_2                 VARCHAR(255),
    jippi_3                 VARCHAR(255),
    jippi_4                 VARCHAR(255),
    jippi_5                 VARCHAR(255),

    -- ---- フラグ（既存「01相談記録」と同パターン） ----
    flag                    BOOLEAN,                -- 請求完了フラグ（TRUE=請求済）
    saisei_flag             BOOLEAN,                -- 再請求フラグ
    hyoji_flag              BOOLEAN,                -- 表示フラグ
    jidoka_flag             BOOLEAN,                -- 自動化フラグ
    flag_nichiji            TIMESTAMPTZ,

    -- ---- その他 ----
    shogai_shubetsu         TEXT,
    honnin_jokyo            TEXT,
    setai_jokyo             TEXT,

    CONSTRAINT child_care_entry_records_pkey PRIMARY KEY (record_id)
);

-- インデックス（既存「01相談記録」パターン踏襲）
CREATE INDEX idx_ccer_toroku    ON public.child_care_entry_records USING btree (toroku_nichiji);
CREATE INDEX idx_ccer_koushin   ON public.child_care_entry_records USING btree (koushin_nichiji);
CREATE INDEX idx_ccer_nengetsu  ON public.child_care_entry_records USING btree (nengetsu);
CREATE INDEX idx_ccer_kiroku_bi ON public.child_care_entry_records USING btree (kiroku_bi);
CREATE INDEX idx_ccer_riyousha  ON public.child_care_entry_records USING btree (riyousha_zaiseki_id);

-- 日次一意制約（同一利用者×同一日付の二重登録防止。再請求時は通す）
CREATE UNIQUE INDEX idx_ccer_unique_day
    ON public.child_care_entry_records (riyousha_zaiseki_id, kiroku_bi)
    WHERE flag IS DISTINCT FROM TRUE;

COMMENT ON TABLE  public.child_care_entry_records IS '児童入所施設の日次実績。1利用者×1日=1行';
COMMENT ON COLUMN public.child_care_entry_records.kiroku_bi IS '記録日。この行が示す具体的な日付。Excel暦日LEFT JOINキー';
COMMENT ON COLUMN public.child_care_entry_records.riyo_jotai IS '在籍/入院/外泊/退所中。請求日数は riyo_jotai = ''在籍'' の件数で算出';
COMMENT ON COLUMN public.child_care_entry_records.flag IS '請求完了フラグ。TRUE=請求済。再請求時は saisei_flag=TRUE で別レコード追加';

COMMIT;
