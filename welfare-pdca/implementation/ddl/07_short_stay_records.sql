-- ============================================================
-- migrate_07_short_stay.sql
-- 短期入所の月次実績テーブル（日次レコード設計）
--
-- 設計方針:
--   - 1 利用者 × 1 利用日 = 1 行（疎データ。利用日のみ INSERT）
--   - 利用がない日はレコードなし。Excel 出力時に GAS が暦日 LEFT JOIN で空行展開
--   - 利用日数集計は SELECT COUNT/SUM で算出
--
-- 対応 SF オブジェクト: ShortStayRecord__c（新設予定）
-- 対応 AppSheet テーブル: 短期入所記録（新設予定）
-- 参照: decisions-2026-06-22 §7 / 計画書 §2.8
-- ============================================================

BEGIN;

CREATE TABLE public.short_stay_records (
    -- ---- 識別子 ----
    record_id               VARCHAR(255) NOT NULL,
    nengetsu_bi_riyousha_id VARCHAR(255),

    -- ---- 利用者・職員参照 ----
    riyousha_id             VARCHAR(255),
    riyousha_zaiseki_id     VARCHAR(255),
    riyousha_shimei         VARCHAR(255),
    shokuin_zaiseki_id      VARCHAR(255),
    jigyousho               VARCHAR(255),

    -- ---- 期間・記録（日次キー） ----
    nengetsu                VARCHAR(7),             -- 'YYYY-MM'
    kiroku_bi               DATE NOT NULL,          -- 利用日
    nichi                   VARCHAR(2),             -- 日 '01'〜'31'
    toroku_nichiji          TIMESTAMPTZ,
    koushin_nichiji         TIMESTAMPTZ,
    user_mail               VARCHAR(255),

    -- ---- 利用類型（短期入所特有・日毎にも変わり得るので保持） ----
    riyo_ruikei             VARCHAR(20),            -- '単独型' / '併設型' / '空床利用型'

    -- ---- 利用区分（その日の利用状態） ----
    is_kinkyu               BOOLEAN,                -- 緊急利用日（緊急短期入所受入加算の根拠）

    -- ---- 加算（日次フラグ。リタリコ Excel ヘッダー確定後に列名を固定） ----
    kihon_hoshu             VARCHAR(255),
    kasan                   VARCHAR(255),
    tandoku_kasan           BOOLEAN,                -- 単独型加算
    iryo_renkei_kango       BOOLEAN,                -- 医療連携看護職員確保加算
    shintai_kousoku_haishi_misshi_genzan BOOLEAN,   -- 身体拘束廃止未実施減算
    kinyu_tansho_kasan      BOOLEAN,                -- 緊急短期入所受入加算
    iryo_taisho_kasan       BOOLEAN,                -- 医療的ケア対象者支援加算（短期入所）
    fukushi_kaigo_shoguu_kasan VARCHAR(255),        -- 福祉・介護職員等処遇改善加算

    -- ---- 付随サービス（その日に提供されたか） ----
    soyo_flag               BOOLEAN,                -- 送迎加算
    shokuji_flag            BOOLEAN,                -- 食事提供加算

    -- ---- 実費（リタリコ 6月改定で実費 1〜5 まで拡張） ----
    jippi_1                 VARCHAR(255),
    jippi_2                 VARCHAR(255),
    jippi_3                 VARCHAR(255),
    jippi_4                 VARCHAR(255),
    jippi_5                 VARCHAR(255),

    -- ---- フラグ ----
    flag                    BOOLEAN,
    saisei_flag             BOOLEAN,
    hyoji_flag              BOOLEAN,
    jidoka_flag             BOOLEAN,
    flag_nichiji            TIMESTAMPTZ,

    -- ---- その他 ----
    shogai_shubetsu         TEXT,
    honnin_jokyo            TEXT,
    setai_jokyo             TEXT,

    CONSTRAINT short_stay_records_pkey PRIMARY KEY (record_id)
);

CREATE INDEX idx_ssr_toroku    ON public.short_stay_records USING btree (toroku_nichiji);
CREATE INDEX idx_ssr_koushin   ON public.short_stay_records USING btree (koushin_nichiji);
CREATE INDEX idx_ssr_nengetsu  ON public.short_stay_records USING btree (nengetsu);
CREATE INDEX idx_ssr_kiroku_bi ON public.short_stay_records USING btree (kiroku_bi);
CREATE INDEX idx_ssr_riyousha  ON public.short_stay_records USING btree (riyousha_zaiseki_id);
CREATE INDEX idx_ssr_ruikei    ON public.short_stay_records USING btree (riyo_ruikei);

-- 日次一意制約（同一利用者×同一日付）
CREATE UNIQUE INDEX idx_ssr_unique_day
    ON public.short_stay_records (riyousha_zaiseki_id, kiroku_bi)
    WHERE flag IS DISTINCT FROM TRUE;

COMMENT ON TABLE  public.short_stay_records IS '短期入所の日次実績。1利用者×1利用日=1行';
COMMENT ON COLUMN public.short_stay_records.kiroku_bi IS '利用日。Excel暦日LEFT JOINキー';
COMMENT ON COLUMN public.short_stay_records.riyo_ruikei IS '単独型/併設型/空床利用型。請求単価の分岐キー';

COMMIT;
