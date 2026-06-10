--
-- PostgreSQL database dump
--

\restrict cqG844CvuXfXnppuFjo0MCnr8e9gZFYuFeB2TAwMenJgH6PMCgfGfvXZCq31Slc

-- Dumped from database version 15.17
-- Dumped by pg_dump version 15.18 (Debian 15.18-1.pgdg13+1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: 01相談記録; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."01相談記録" (
    "相談記録ID" character varying(255) NOT NULL,
    "表示フラグ" boolean,
    "自動化フラグ" boolean,
    "フラグ日時" timestamp with time zone,
    "年月日_利用者在籍ID" character varying(255),
    "PDF" text,
    "年齢_登録時点" integer,
    "相談No" integer,
    "タイトル" character varying(255),
    "事業区分" character varying(255),
    "利用者ID" character varying(255),
    "利用者在籍ID" character varying(255),
    "利用者氏名" character varying(255),
    "職員在籍ID" character varying(255),
    "相談事業所" character varying(255),
    "相談種別" character varying(255),
    "相談者_本人との関係" character varying(255),
    "連携先の機関" text,
    "相談者_親族等" text,
    "相談者_支援機関等" text,
    "登録日時" timestamp with time zone,
    "更新日時" timestamp with time zone,
    "記録日" date,
    "年月" character varying(255),
    "日" character varying(10),
    "フラグ" boolean,
    "UserMail" character varying(255),
    "相談方法" character varying(255),
    "基幹​相談​支援事業_種別" character varying(255),
    "基幹​相談​支援_基礎的事業_取組項目" character varying(255),
    "基幹​相談​支援_機能強化事業_取組項目" character varying(255),
    "委託相談_支援種別" character varying(255),
    "地域活動支援センターⅠ型_種別" character varying(255),
    "地域活動支援Ⅰ型_基礎的事業_取組項目" character varying(255),
    "地域活動支援Ⅰ型_機能強化事業_取組項目" character varying(255),
    "地域移行_請求対象" character varying(255),
    "認証ケアマネ_業務区別" character varying(255),
    "認証ケアマネ_支援種別" character varying(255),
    "基本報酬" character varying(255),
    "加算" character varying(255),
    "区分選択肢" character varying(255),
    "市町村" character varying(255),
    "市町村番号" character varying(20),
    "再請求フラグ" boolean,
    "実費1" character varying(255),
    "実費2" character varying(255),
    "ピアカウンセラー" boolean,
    "障害種別" text,
    "外国ルーツ" character varying(255),
    "関係" character varying(255),
    "担当者" character varying(255),
    "区分" character varying(255),
    "集" character varying(255),
    "項目" character varying(255),
    "本人状況" text,
    "世帯状況" text
);


--
-- Name: AIジョブキュー; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."AIジョブキュー" (
    "ジョブID" text NOT NULL,
    "登録日時" timestamp with time zone DEFAULT now() NOT NULL,
    "ジョブタイプ" text NOT NULL,
    "ペイロード" text NOT NULL,
    "状態" text DEFAULT 'Pending'::text NOT NULL,
    "更新日時" timestamp with time zone,
    "ログ" text
);


--
-- Name: ケース記録; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."ケース記録" (
    "Row ID" character varying(255) NOT NULL,
    "ケース記録ID" character varying(255),
    "フェーズ" character varying(255),
    "利用者在籍ID" character varying(255),
    "利用者氏名" character varying(255),
    "相談記録ID" character varying(255),
    "年月日_利用者在籍ID" character varying(255),
    "記録全容" text,
    "入力内容" text,
    "AI適用" text,
    "支援記録種別" character varying(255),
    "単一選択リスト01" character varying(255),
    "単一選択リスト02" character varying(255),
    "単一選択リスト03" character varying(255),
    "単一選択リスト04" character varying(255),
    "単一選択リスト05" character varying(255),
    "単一選択リスト06" character varying(255),
    "単一選択リスト07" character varying(255),
    "単一選択リスト08" character varying(255),
    "単一選択リスト09" character varying(255),
    "単一選択リスト10" character varying(255),
    "単一選択リスト11" character varying(255),
    "単一選択リスト12" character varying(255),
    "単一選択リスト13" character varying(255),
    "単一選択リスト14" character varying(255),
    "単一選択リスト15" character varying(255),
    "単一選択リスト16" character varying(255),
    "単一選択リスト17" character varying(255),
    "単一選択リスト18" character varying(255),
    "単一選択リスト19" character varying(255),
    "単一選択リスト20" character varying(255),
    "複数選択リスト01" text,
    "複数選択リスト02" text,
    "複数選択リスト03" text,
    "カスタムテキスト01" text,
    "カスタムテキスト02" text,
    "カスタムテキスト03" text,
    "カスタムテキスト04" text,
    "カスタムテキスト05" text,
    "カスタムテキスト06" text,
    "カスタムテキスト07" text,
    "カスタムテキスト08" text,
    "カスタムテキスト09" text,
    "カスタムテキスト10" text,
    "カスタムテキスト11" text,
    "カスタムテキスト12" text,
    "カスタムテキスト13" text,
    "カスタムテキスト14" text,
    "カスタムテキスト15" text,
    "カスタムテキスト16" text,
    "カスタムテキスト17" text,
    "カスタムテキスト18" text,
    "カスタムテキスト19" text,
    "カスタムテキスト20" text,
    "カスタムナンバー01" integer,
    "カスタムナンバー02" integer,
    "カスタムナンバー03" integer,
    "カスタムナンバー04" integer,
    "カスタムナンバー05" integer,
    "カスタムデシマル01" numeric(10,2),
    "カスタムデシマル02" numeric(10,2),
    "カスタムデシマル03" numeric(10,2),
    "支援開始日時" timestamp with time zone,
    "支援終了日時" timestamp with time zone,
    "支援時間" interval,
    "記録者" character varying(255),
    "日付" date,
    "登録日時" timestamp with time zone,
    "フラグ" boolean,
    "SF処理フラグ" boolean,
    "SF処理日時" timestamp with time zone,
    "UserMail" character varying(255),
    "更新日時" timestamp with time zone,
    "利用者記録者" character varying(255),
    "AI処理ナンバーカスタム" text,
    "AI処理テキストカスタム" text,
    "AI処理フリーテキスト" text,
    "年月" character varying(255)
);


--
-- Name: 出力先ファイル; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."出力先ファイル" (
    "出力先ファイルID" text NOT NULL,
    "生成帳票種別" text,
    "学習ファイル追加" text,
    "帳票項目s" text,
    "利用者ID" text,
    "職員ID" text,
    "出力フラグ" boolean,
    "フラグ" boolean,
    "記録対象期間：始" date,
    "記録対象期間：終" date,
    "支援記録種別" text,
    "登録日時" timestamp with time zone,
    "更新日時" timestamp with time zone,
    temperature numeric,
    "topP" numeric,
    "AI帳票出力日時" timestamp with time zone,
    "AI帳票出力結果" text,
    "File" text
);


--
-- Name: 帳票マスタ複製登録; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."帳票マスタ複製登録" (
    "帳票マスタ複製登録ID" character varying(255) NOT NULL,
    "利用者在籍ID" character varying(255),
    "利用者氏名" character varying(255),
    "職員在籍ID" character varying(255),
    "職員氏名" character varying(255),
    "事業所名" character varying(255),
    "事業所名称" character varying(255),
    "ひな型帳票マスタID" character varying(255),
    "帳票名" character varying(255),
    "&&項目名&&_カンマリスト" text,
    "スプシURL" text,
    "登録日時" timestamp with time zone,
    "更新日時" timestamp with time zone,
    "UserMail" character varying(255),
    "展開フラグ" boolean,
    "展開日時" timestamp with time zone,
    "展開UserMail" character varying(255),
    "展開処理結果" text,
    "サイン" text,
    "サイン日時" timestamp with time zone,
    "帳票完了フラグ" boolean,
    "帳票作成日時" timestamp with time zone,
    "帳票作成UserMail" character varying(255),
    "帳票作成処理結果" text,
    "自動フラグ" boolean,
    "File" text,
    "表示非表示" boolean,
    "登録年月" character varying(255),
    "提供年月_事業所_利用者在籍" character varying(255),
    "引用項目_帳票ID" character varying(255),
    "引用項目_子リストID" text,
    "引用フラグ" character varying(255),
    "引用日時" character varying(255)
);


--
-- Name: 帳票子レコード複製登録; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."帳票子レコード複製登録" (
    "帳票子レコード複製登録ID" character varying(255) NOT NULL,
    "帳票マスタ複製登録ID" character varying(255) NOT NULL,
    "帳票名" character varying(255),
    "&&項目名&&" character varying(255),
    "シート名セル位置" character varying(255),
    "項目データ型選択" character varying(255),
    "表示用順位付け" integer,
    "日付" date,
    "日時" timestamp with time zone,
    "テキスト" character varying(255),
    "ロングテキスト" text,
    "単一選択肢" character varying(255),
    "複数選択肢" text,
    "数値" integer,
    "数値_小数点" numeric(10,2),
    "パーセント" numeric(5,2),
    "電話番号" character varying(20),
    "メールアドレス" character varying(255),
    "URL" text,
    "住所" text,
    "画像" text,
    "ファイル" text,
    "登録日時" timestamp with time zone,
    "更新日時" timestamp with time zone,
    "UserMail" character varying(255)
);


--
-- Name: 音声記録対応; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."音声記録対応" (
    "Row ID" text NOT NULL,
    "音声記録対応ID" text,
    "音声URL" text,
    "音声ファイル名" text,
    "職員在籍ID" text,
    "オブジェクト名" text,
    "開始時間" time without time zone,
    "作成日" date,
    "文字起こしテキスト" text,
    "利用者在籍ID" text,
    "利用者ID" text,
    "ケース記録種別" text,
    "AI整理_要約" text,
    "音声入力" text,
    "登録日時" timestamp with time zone,
    "更新日時" timestamp with time zone,
    "フラグ" boolean,
    "処理フラグ" boolean
);


--
-- Name: 01相談記録 01相談記録_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."01相談記録"
    ADD CONSTRAINT "01相談記録_pkey" PRIMARY KEY ("相談記録ID");


--
-- Name: AIジョブキュー AIジョブキュー_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."AIジョブキュー"
    ADD CONSTRAINT "AIジョブキュー_pkey" PRIMARY KEY ("ジョブID");


--
-- Name: ケース記録 ケース記録_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."ケース記録"
    ADD CONSTRAINT "ケース記録_pkey" PRIMARY KEY ("Row ID");


--
-- Name: 出力先ファイル 出力先ファイル_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."出力先ファイル"
    ADD CONSTRAINT "出力先ファイル_pkey" PRIMARY KEY ("出力先ファイルID");


--
-- Name: 帳票マスタ複製登録 帳票マスタ複製登録_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."帳票マスタ複製登録"
    ADD CONSTRAINT "帳票マスタ複製登録_pkey" PRIMARY KEY ("帳票マスタ複製登録ID");


--
-- Name: 帳票子レコード複製登録 帳票子レコード複製登録_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."帳票子レコード複製登録"
    ADD CONSTRAINT "帳票子レコード複製登録_pkey" PRIMARY KEY ("帳票子レコード複製登録ID");


--
-- Name: 音声記録対応 音声記録対応_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."音声記録対応"
    ADD CONSTRAINT "音声記録対応_pkey" PRIMARY KEY ("Row ID");


--
-- Name: idx_ajq_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ajq_status ON public."AIジョブキュー" USING btree ("状態");


--
-- Name: idx_ajq_touroku; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ajq_touroku ON public."AIジョブキュー" USING btree ("登録日時");


--
-- Name: idx_case_koushin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_case_koushin ON public."ケース記録" USING btree ("更新日時");


--
-- Name: idx_case_touroku; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_case_touroku ON public."ケース記録" USING btree ("登録日時");


--
-- Name: idx_ck_fk; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ck_fk ON public."ケース記録" USING btree ("相談記録ID");


--
-- Name: idx_ck_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ck_id ON public."ケース記録" USING btree ("ケース記録ID");


--
-- Name: idx_hk_fk; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hk_fk ON public."帳票子レコード複製登録" USING btree ("帳票マスタ複製登録ID");


--
-- Name: idx_hk_koushin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hk_koushin ON public."帳票子レコード複製登録" USING btree ("更新日時");


--
-- Name: idx_hk_touroku; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hk_touroku ON public."帳票子レコード複製登録" USING btree ("登録日時");


--
-- Name: idx_hm_koushin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hm_koushin ON public."帳票マスタ複製登録" USING btree ("更新日時");


--
-- Name: idx_hm_touroku; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hm_touroku ON public."帳票マスタ複製登録" USING btree ("登録日時");


--
-- Name: idx_onsei_kiroku_taio_koshin_nichiji; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_onsei_kiroku_taio_koshin_nichiji ON public."音声記録対応" USING btree ("更新日時");


--
-- Name: idx_onsei_kiroku_taio_riyousha; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_onsei_kiroku_taio_riyousha ON public."音声記録対応" USING btree ("利用者在籍ID");


--
-- Name: idx_onsei_kiroku_taio_sakusei_bi; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_onsei_kiroku_taio_sakusei_bi ON public."音声記録対応" USING btree ("作成日");


--
-- Name: idx_onsei_kiroku_taio_shokuin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_onsei_kiroku_taio_shokuin ON public."音声記録対応" USING btree ("職員在籍ID");


--
-- Name: idx_sf_riyousha; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sf_riyousha ON public."出力先ファイル" USING btree ("利用者ID");


--
-- Name: idx_sf_shubetsu; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sf_shubetsu ON public."出力先ファイル" USING btree ("生成帳票種別");


--
-- Name: idx_soudan_koushin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_soudan_koushin ON public."01相談記録" USING btree ("更新日時");


--
-- Name: idx_soudan_touroku; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_soudan_touroku ON public."01相談記録" USING btree ("登録日時");


--
-- Name: 出力先ファイル fk_sf_master; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."出力先ファイル"
    ADD CONSTRAINT fk_sf_master FOREIGN KEY ("生成帳票種別") REFERENCES public."帳票マスタ複製登録"("帳票マスタ複製登録ID") ON DELETE RESTRICT NOT VALID;


--
-- PostgreSQL database dump complete
--

\unrestrict cqG844CvuXfXnppuFjo0MCnr8e9gZFYuFeB2TAwMenJgH6PMCgfGfvXZCq31Slc

