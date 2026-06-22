-- ============================================================
-- migrate_08_daytime_temp_support.sql
-- 日中一時支援の月次実績テーブル（日次レコード設計）
--
-- 設計方針:
--   - 1 利用者 × 1 利用日 = 1 行（疎データ）
--   - 市町村事業（国保連経由なし）のため単価は municipality_unit_prices から取得
--   - 利用時間と時間区分はその日の実利用時間で決定
--   - 同一日に複数市町村を利用するケースは制度上稀だが想定し UNIQUE は (利用者, 日, 市町村) で
--
-- 対応 SF オブジェクト: DaytimeTempSupportRecord__c（新設予定）
-- 対応 AppSheet テーブル: 日中一時支援記録（新設予定）
-- 参照: decisions-2026-06-22 §7 / 計画書 §2.8
-- ============================================================

BEGIN;

CREATE TABLE public.daytime_temp_support_records (
    -- ---- 識別子 ----
    record_id               VARCHAR(255) NOT NULL,
    nengetsu_bi_riyousha_id VARCHAR(255),

    -- ---- 利用者・職員参照 ----
    riyousha_id             VARCHAR(255),
    riyousha_zaiseki_id     VARCHAR(255),
    riyousha_shimei         VARCHAR(255),
    shokuin_zaiseki_id      VARCHAR(255),
    jigyousho               VARCHAR(255),

    -- ---- 市町村参照（最重要・単価マスタの分岐キー） ----
    shichoson_id            VARCHAR(50),            -- 市町村マスタ FK（自治体 Account ID または独自コード）
    shichoson_name          VARCHAR(255),           -- 市町村名（非正規化・表示用）
    shichoson_number        VARCHAR(20),            -- 市町村番号

    -- ---- 期間・記録（日次キー） ----
    nengetsu                VARCHAR(7),             -- 'YYYY-MM'
    kiroku_bi               DATE NOT NULL,          -- 利用日
    nichi                   VARCHAR(2),             -- 日 '01'〜'31'
    toroku_nichiji          TIMESTAMPTZ,
    koushin_nichiji         TIMESTAMPTZ,
    user_mail               VARCHAR(255),

    -- ---- 利用時間・区分（その日の実利用に基づき算出） ----
    kaishi_jikoku           TIME,                   -- 開始時刻
    shuryo_jikoku           TIME,                   -- 終了時刻
    riyo_jikan_fun          INTEGER,                -- 実利用時間（分）
    jikan_kubun             VARCHAR(20),            -- 時間区分（例: '2h未満' / '2h〜4h' / '4h以上'）

    -- ---- 単価（municipality_unit_prices から GAS が解決・非正規化で保持） ----
    tanka_applied           NUMERIC(10,2),          -- 適用単価
    unit_price_version      VARCHAR(50),            -- 単価バージョン（改定追跡用）

    -- ---- 加算（日中一時支援固有・日次フラグ） ----
    kihon_hoshu             VARCHAR(255),
    kasan                   VARCHAR(255),
    iryo_taisho_kasan       BOOLEAN,                -- 医療的ケア対象者支援加算（日中一時）
    kodo_kodo_kasan         BOOLEAN,                -- 強度行動障害支援加算
    soyo_flag               BOOLEAN,                -- 送迎加算
    shokuji_flag            BOOLEAN,                -- 食事提供加算
    fukushi_kaigo_shoguu_kasan VARCHAR(255),

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

    CONSTRAINT daytime_temp_support_records_pkey PRIMARY KEY (record_id)
);

CREATE INDEX idx_dtsr_toroku       ON public.daytime_temp_support_records USING btree (toroku_nichiji);
CREATE INDEX idx_dtsr_koushin      ON public.daytime_temp_support_records USING btree (koushin_nichiji);
CREATE INDEX idx_dtsr_nengetsu     ON public.daytime_temp_support_records USING btree (nengetsu);
CREATE INDEX idx_dtsr_kiroku_bi    ON public.daytime_temp_support_records USING btree (kiroku_bi);
CREATE INDEX idx_dtsr_riyousha     ON public.daytime_temp_support_records USING btree (riyousha_zaiseki_id);
CREATE INDEX idx_dtsr_shichoson    ON public.daytime_temp_support_records USING btree (shichoson_id);
CREATE INDEX idx_dtsr_jikan_kubun  ON public.daytime_temp_support_records USING btree (jikan_kubun);

-- 日次一意制約（同一利用者×同一日付×同一市町村）
CREATE UNIQUE INDEX idx_dtsr_unique_day
    ON public.daytime_temp_support_records (riyousha_zaiseki_id, kiroku_bi, shichoson_id)
    WHERE flag IS DISTINCT FROM TRUE;

COMMENT ON TABLE  public.daytime_temp_support_records IS '日中一時支援の日次実績。1利用者×1利用日×1市町村=1行';
COMMENT ON COLUMN public.daytime_temp_support_records.shichoson_id IS '市町村マスタ FK。単価マスタの引きキー';
COMMENT ON COLUMN public.daytime_temp_support_records.tanka_applied IS '適用単価（円）。GASがmunicipality_unit_pricesから引いて書込（非正規化）';

COMMIT;
