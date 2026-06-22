"""入所系 3 サービス AppSheet DB 投入用 CSV 生成 v2.

設計準拠:
- welfare-pdca/context/2026-06-23-加算マスタ_データフロー完全解析.md §3
- 加算は 3 マスタに正しく振り分け
- 利用者加算マスタには「反映条件 / 反映箇所」をセット
- 日数加算は 反映条件 = 同月全件反映_カウント

出力:
  scripts/master-rows-v2/
    児童入所施設_事業所加算.csv  (約 29 行)
    児童入所施設_利用者加算.csv  (約 22 行)
    児童入所施設_利用者基本.csv  (約 7 行)
    短期入所_事業所加算.csv      (約 28 行)
    短期入所_利用者加算.csv      (約 22 行)
    短期入所_利用者基本.csv      (約 5 行)
    日中一時支援_事業所加算.csv  (約 5 行)
    日中一時支援_利用者加算.csv  (約 3 行)
    日中一時支援_利用者基本.csv  (約 5 行)
"""
from __future__ import annotations

import csv
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

OUT_DIR = Path("scripts/master-rows-v2")
OUT_DIR.mkdir(parents=True, exist_ok=True)

APPLIED_FROM = "06/01/2026"
USED_FACILITIES = "愛の集い"

# 加算種別 Enum 値（既存マスタの分類踏襲）
K_TAITEI = "1. 事業所の体制・評価に関する加算"
K_OPER = "2. 運営義務（未実施による減算）"
K_KAIGO = "4. 介護人材確保・処遇改善"
K_SYSTEM = ""

# 利用者加算マスタ用 加算種別（既存マスタの値踏襲）
UK_BASIC = "1. 基本・初期導入に関する加算"
UK_RENKEI = "2. 医療・施設等との連携に関する加算"
UK_PLAN = "4. 計画作成・モニタリングの強化加算"
UK_TAITEI = "5. 事業所の体制に対する加算（加算届けが必要なもの）"
UK_SHUCHU = "6. 集中支援・その他の加算"
UK_HOSHU = "基本報酬"

# 反映条件 Enum 値
R_LATEST = "同月最新日のみ反映"
R_COUNT = "同月全件反映_カウント"  # ★ 入所系の日数加算で初使用

# 反映箇所
P_RIGHT = "1つ右のセル"
P_HERE = "該当箇所"

# ============================================================
# 共通ヘルパー
# ============================================================

JIGYO_HEADER = [
    "事業所加算一覧", "区分_選択肢", "フラグ", "事業所REF",
    "適用開始_年月日", "適用終了_年月日",
    "加算適用示唆_プロンプト", "加算種別",
    "加算内容・適用条件", "必要書類(エビデンス)", "使用事業所",
]
RIYOSHA_HEADER = [
    "利用者加算一覧", "区分_選択肢", "フラグ", "事業所REF",
    "適用開始_年月日", "適用終了_年月日",
    "加算適用示唆_プロンプト", "加算種別",
    "加算内容・適用条件", "必要書類(エビデンス)",
    "反映箇所", "反映条件", "使用事業所",
]
KIHON_HEADER = ["利用者基本マスタ", "フラグ", "事業所REF"]


def j(name, *, service, choices="○", kind=K_TAITEI,
      condition="請求する　→　○", evidence="", prompt=""):
    """事業所加算マスタ行."""
    return {
        "事業所加算一覧": name, "区分_選択肢": choices, "フラグ": "Y",
        "事業所REF": service, "適用開始_年月日": APPLIED_FROM,
        "適用終了_年月日": "", "加算適用示唆_プロンプト": prompt,
        "加算種別": kind, "加算内容・適用条件": condition,
        "必要書類(エビデンス)": evidence, "使用事業所": USED_FACILITIES,
    }


def u(name, *, service, choices="○", kind=UK_TAITEI,
      condition="請求する　→　○", evidence="", prompt="",
      reflect_where=P_RIGHT, reflect_cond=R_LATEST):
    """利用者加算マスタ行."""
    return {
        "利用者加算一覧": name, "区分_選択肢": choices, "フラグ": "Y",
        "事業所REF": service, "適用開始_年月日": APPLIED_FROM,
        "適用終了_年月日": "", "加算適用示唆_プロンプト": prompt,
        "加算種別": kind, "加算内容・適用条件": condition,
        "必要書類(エビデンス)": evidence,
        "反映箇所": reflect_where, "反映条件": reflect_cond,
        "使用事業所": USED_FACILITIES,
    }


def k(name, service):
    """利用者基本マスタ行."""
    return {"利用者基本マスタ": name, "フラグ": "Y", "事業所REF": service}


# ============================================================
# §A. 児童入所施設
# ============================================================
def build_jido_jigyo():
    S = "児童入所施設"
    return [
        # --- 体制・評価 ---
        j("ソーシャルワーカー配置加算", service=S, evidence="ソーシャルワーカー雇用契約書、配置証明、業務記録"),
        j("看護師配置加算", choices="1 , 2", condition="看護師配置加算Ⅰ　→　1\n看護師配置加算Ⅱ　→　2",
          service=S, evidence="看護師免許の写し、配置証明"),
        j("看護職員配置加算２", service=S, evidence="看護職員配置証明書"),
        j("栄養マネジメント加算", service=S, evidence="栄養ケア計画書、栄養スクリーニング記録"),
        j("公認心理師加配加算", service=S, evidence="公認心理師登録証、雇用契約書",
          prompt="令和6年新設。心理面の専門支援体制を担保"),
        j("児童指導員等加配加算", choices="1 , 2",
          condition="専門職加配　→　1\n児童指導員等加配　→　2",
          service=S, evidence="加配職員の資格証、勤務記録"),
        j("福祉専門職員配置等加算", choices="1 , 2 , 3",
          condition="加算Ⅰ　→　1\n加算Ⅱ　→　2\n加算Ⅲ　→　3",
          service=S, evidence="社会福祉士等の資格証、勤続年数証明"),
        j("栄養士配置加算", choices="1 , 2",
          condition="栄養士配置加算Ⅰ　→　1\n同Ⅱ　→　2",
          service=S, evidence="栄養士免許証、雇用契約書"),
        j("小規模グループケア加算", choices="1 , 2 , 3 , 4",
          condition="加算Ⅰ（4〜6人）　→　1\n同Ⅱ（7〜8人）　→　2\n同Ⅲ（9〜10人）　→　3\nサテライト型　→　4",
          service=S, evidence="居住区分別人員配置記録、サテライト型は別棟証明"),
        j("感染対策向上加算", choices="1 , 2",
          condition="加算Ⅰ　→　1\n同Ⅱ　→　2",
          service=S, evidence="感染症マニュアル、研修実績、訓練記録"),
        # --- 処遇改善 ---
        *[j(f"福祉介護職員等処遇改善加算{g}", service=S, kind=K_KAIGO,
            condition=f"処遇改善加算{g}　→　○",
            evidence="処遇改善計画書、賃金台帳",
            prompt=f"令和8年6月改定対応。{g}は要件確認必須")
          for g in ("Ⅰイ", "Ⅰロ", "Ⅱイ", "Ⅱロ", "Ⅲ", "Ⅳ")],
        # --- 減算 ---
        j("業務継続計画未策定減算", service=S, kind=K_OPER,
          evidence="感染症BCP、災害BCP、訓練の実施記録",
          prompt="BCP未策定で△1%減算"),
        j("身体拘束廃止未実施減算", service=S, kind=K_OPER,
          evidence="身体拘束適正化指針、委員会議事録",
          prompt="令和6年から△10%に強化"),
        j("虐待防止措置未実施減算", service=S, kind=K_OPER,
          evidence="虐待防止指針、委員会議事録、職員研修記録"),
        j("情報公表未報告減算", service=S, kind=K_OPER,
          evidence="情報公表システム承認画面",
          prompt="情報公表未報告で△10%減算"),
        j("定員超過利用減算", service=S, kind=K_OPER,
          condition="定員超過　→　○", evidence="月別利用実績"),
        j("人員基準欠如減算", choices="1 , 2",
          condition="軽度欠如（△30%）　→　1\n重度欠如（△50%）　→　2",
          service=S, kind=K_OPER, evidence="人員配置体制届、勤務シフト"),
        j("設備基準不適合減算", service=S, kind=K_OPER,
          condition="設備基準不適合　→　○", evidence="設備調査記録"),
        # --- システム系 ---
        j("請求書役職", service=S, choices="", kind=K_SYSTEM, condition=""),
        j("請求書氏名", service=S, choices="", kind=K_SYSTEM, condition=""),
        j("利用者請求書備考", service=S, choices="", kind=K_SYSTEM, condition=""),
        j("実費1", service=S, choices="", kind=K_SYSTEM, condition=""),
        j("実費2", service=S, choices="", kind=K_SYSTEM, condition=""),
        j("実費3", service=S, choices="", kind=K_SYSTEM, condition=""),
        j("実費4", service=S, choices="", kind=K_SYSTEM, condition=""),
        j("実費5", service=S, choices="", kind=K_SYSTEM, condition=""),
    ]


def build_jido_riyousha():
    S = "児童入所施設"
    return [
        # --- 利用者属性日数加算（同月全件反映_カウント） ---
        u("乳幼児加算", service=S, condition="6歳未満対象児に適用　→　○",
          evidence="児童年齢確認資料",
          reflect_cond=R_COUNT,
          prompt="6歳未満児の入所日数で加算"),
        u("自活訓練加算", choices="1 , 2",
          condition="自活訓練加算Ⅰ（同一敷地内）　→　1\n自活訓練加算Ⅱ（同一敷地外）　→　2",
          service=S, evidence="自活訓練計画書、実施記録、本人同意書",
          reflect_cond=R_COUNT),
        u("入院・外泊時加算", choices="1 , 2",
          condition="加算Ⅰ（7日以内）　→　1\n加算Ⅱ（8日超）　→　2",
          service=S, kind=UK_RENKEI,
          evidence="入院通知、外泊届、医療機関連絡記録",
          reflect_cond=R_COUNT,
          prompt="入院・外泊日数で日次計上"),
        u("強度行動障害児特別支援加算", choices="1 , 2",
          condition="加算Ⅰ　→　1\n加算Ⅱ　→　2",
          service=S, kind=UK_SHUCHU,
          evidence="行動関連項目得点表、専門研修修了証、支援計画",
          reflect_cond=R_COUNT,
          prompt="算定開始から90日以内は +700単位"),
        u("重度障害児支援加算", service=S, kind=UK_TAITEI,
          condition="重度障害児対応　→　○",
          evidence="障害支援区分認定、支援計画",
          reflect_cond=R_COUNT),
        u("重度重複障害児加算", service=S, kind=UK_TAITEI,
          condition="複数障害認定者対応　→　○",
          evidence="医師意見書、複数障害認定資料",
          reflect_cond=R_COUNT),
        u("入浴支援加算", service=S, kind=UK_BASIC,
          condition="入浴介助実施　→　○",
          evidence="入浴介助記録、職員配置",
          reflect_cond=R_COUNT,
          prompt="令和6年新設。入浴支援日に算定"),
        u("視覚・聴覚言語機能障害児支援加算", service=S, kind=UK_TAITEI,
          condition="該当障害児支援　→　○",
          evidence="障害認定資料、専門職配置証明",
          reflect_cond=R_COUNT,
          prompt="令和6年新設"),
        u("日中活動支援加算", service=S, kind=UK_TAITEI,
          condition="日中サービス提供　→　○",
          evidence="日中支援計画、活動実績記録",
          reflect_cond=R_COUNT),
        u("新興感染症等施設療養加算", service=S, kind=UK_TAITEI,
          condition="新興感染症発生時療養　→　○（5日限度）",
          evidence="医療機関連携記録、療養期間記録",
          reflect_cond=R_COUNT,
          prompt="令和6年新設"),
        # --- 月次・回数制 ---
        u("移行支援関係機関連携加算", service=S, kind=UK_RENKEI,
          condition="月1回算定　→　○",
          evidence="連携機関との会議録、退所後支援計画",
          reflect_cond=R_LATEST,
          prompt="令和6年新設の加算"),
        u("入院時特別支援加算", service=S, kind=UK_RENKEI,
          condition="月561単位/通常 or 1,122単位/長期入院　→　○",
          evidence="入院期間中の支援記録",
          reflect_cond=R_LATEST),
        u("要支援児童加算", choices="1 , 2",
          condition="加算Ⅰ　→　1\n加算Ⅱ（心理士関与・月4回）　→　2",
          service=S, kind=UK_BASIC,
          evidence="要支援児童台帳、関係機関連携記録",
          reflect_cond=R_LATEST),
        u("家族支援加算", choices="1 , 2",
          condition="加算Ⅰ（個別/グループ）　→　1\n加算Ⅱ（兄弟姉妹支援）　→　2",
          service=S, kind=UK_BASIC,
          evidence="家族支援計画、面談記録",
          reflect_cond=R_COUNT,
          prompt="令和6年新設。実施回数で計上"),
        u("地域移行加算", service=S, kind=UK_BASIC,
          condition="退所準備・退所後フォロー　→　○",
          evidence="地域移行計画、関係機関連携記録",
          reflect_cond=R_COUNT,
          prompt="入所中2回 + 退所後1回 = 計3回限度"),
        u("体験利用支援加算", choices="1 , 2",
          condition="加算Ⅰ（3日以内）　→　1\n加算Ⅱ（5日以内）　→　2",
          service=S, kind=UK_BASIC,
          evidence="体験利用計画、保護者同意書",
          reflect_cond=R_COUNT,
          prompt="令和6年新設"),
        u("集中的支援加算", choices="1 , 2",
          condition="加算Ⅰ（月4回限度）　→　1\n加算Ⅱ（日額）　→　2",
          service=S, kind=UK_SHUCHU,
          evidence="行動評価記録、専門研修修了証",
          reflect_cond=R_COUNT,
          prompt="令和6年新設。強度行動障害悪化期対応"),
        u("利用者負担上限額管理加算", service=S, kind=UK_SHUCHU,
          condition="月150単位/月　→　○",
          evidence="上限額管理結果票",
          reflect_cond=R_LATEST),
    ]


def build_jido_kihon():
    S = "児童入所施設"
    return [
        k("氏名", S),
        k("氏名カナ", S),
        k("受給者証番号", S),
        k("支給市町村", S),
        k("児童氏名", S),
        k("児童氏名カナ", S),
        k("利用者負担上限額", S),
    ]


# ============================================================
# §B. 短期入所
# ============================================================
def build_tanki_jigyo():
    S = "短期入所"
    return [
        # --- 体制・評価 ---
        j("単独型加算", service=S, condition="単独型のみ　→　○（18h以上は +100単位）",
          evidence="単独型指定証明、滞在時間記録"),
        j("常勤看護職員等配置加算", choices="1 , 2 , 3 , 4",
          condition="定員別: 6人/12人/17人/18人+　→　1〜4",
          service=S, evidence="看護職員雇用契約書、勤務記録"),
        j("栄養士配置加算", choices="1 , 2",
          condition="栄養士配置加算Ⅰ　→　1\n同Ⅱ　→　2",
          service=S, evidence="栄養士免許証、雇用契約書"),
        j("食事提供体制加算", service=S, condition="食事提供体制確保　→　○",
          evidence="食事提供計画、栄養管理記録"),
        j("医療連携体制加算", choices="1 , 2 , 3 , 4 , 5 , 6 , 7 , 8 , 9",
          condition="医療連携体制加算Ⅰ〜Ⅸ　→　1〜9",
          service=S, evidence="連携医療機関契約書、看護師訪問記録、医療的ケア判定"),
        j("福祉専門職員配置等加算（共生型）", service=S,
          condition="共生型のみ　→　○",
          evidence="社会福祉士等資格証、勤続年数証明"),
        # --- 処遇改善 ---
        *[j(f"福祉介護職員等処遇改善加算{g}", service=S, kind=K_KAIGO,
            condition=f"処遇改善加算{g}　→　○",
            evidence="処遇改善計画書、賃金台帳",
            prompt="令和8年6月改定対応")
          for g in ("Ⅰイ", "Ⅰロ", "Ⅲ", "Ⅳ")],
        # --- 減算 ---
        j("大規模減算", service=S, kind=K_OPER,
          condition="単独型 定員20人以上　→　○（× 90/100）",
          evidence="定員数、形態証明"),
        j("業務継続計画未策定減算", service=S, kind=K_OPER,
          evidence="感染症BCP、災害BCP、訓練記録",
          prompt="令和6年新設"),
        j("虐待防止措置未実施減算", service=S, kind=K_OPER,
          evidence="虐待防止指針、委員会議事録、職員研修記録"),
        j("身体拘束廃止未実施減算", service=S, kind=K_OPER,
          evidence="身体拘束適正化指針、委員会議事録"),
        j("情報公表未報告減算", service=S, kind=K_OPER,
          evidence="情報公表システム承認画面"),
        j("利用定員超過減算", choices="1 , 2",
          condition="2ヶ月目まで（70/100）　→　1\n3ヶ月以上（50/100）　→　2",
          service=S, kind=K_OPER, evidence="月別利用実績"),
        j("人員欠如減算", service=S, kind=K_OPER,
          condition="基準欠如　→　○", evidence="人員配置記録"),
        # --- システム系 ---
        j("請求書役職", service=S, choices="", kind=K_SYSTEM, condition=""),
        j("請求書氏名", service=S, choices="", kind=K_SYSTEM, condition=""),
        j("利用者請求書備考", service=S, choices="", kind=K_SYSTEM, condition=""),
        j("実費1", service=S, choices="", kind=K_SYSTEM, condition=""),
        j("実費2", service=S, choices="", kind=K_SYSTEM, condition=""),
        j("実費3", service=S, choices="", kind=K_SYSTEM, condition=""),
        j("実費4", service=S, choices="", kind=K_SYSTEM, condition=""),
        j("実費5", service=S, choices="", kind=K_SYSTEM, condition=""),
    ]


def build_tanki_riyousha():
    S = "短期入所"
    return [
        # --- 日数加算（同月全件反映_カウント） ---
        u("医療的ケア対応支援加算", service=S, kind=UK_RENKEI,
          condition="医療的ケア児・者受入　→　○",
          evidence="医療的ケア判定スコア、看護師配置",
          reflect_cond=R_COUNT,
          prompt="令和6年新設"),
        u("重度障害児者対応支援加算", service=S, kind=UK_TAITEI,
          condition="区分5/6 or 障害児区分3 ≧50%　→　○",
          evidence="障害支援区分認定、入所者割合表",
          reflect_cond=R_COUNT,
          prompt="令和6年新設"),
        u("日中活動支援加算", service=S, kind=UK_TAITEI,
          condition="日中サービス提供　→　○",
          evidence="日中支援計画、活動実績",
          reflect_cond=R_COUNT),
        u("送迎加算", service=S, kind=UK_BASIC,
          condition="片道送迎　→　○",
          evidence="送迎運行記録、車両管理簿",
          reflect_cond=R_COUNT),
        u("緊急短期入所受入加算", choices="1 , 2",
          condition="加算Ⅰ　→　1\n加算Ⅱ　→　2",
          service=S, kind=UK_SHUCHU,
          evidence="緊急受入記録、家族連絡記録",
          reflect_cond=R_COUNT,
          prompt="令和6年見直し対象"),
        u("重度障害者支援加算", choices="1 , 2 , 3 , 4",
          condition="加算Ⅰ受入　→　1\n加算Ⅰ初期　→　2\n加算Ⅱ受入　→　3\n加算Ⅱ初期　→　4",
          service=S, kind=UK_TAITEI,
          evidence="重度障害者支援計画、研修修了証",
          reflect_cond=R_COUNT),
        u("特別重度支援加算", choices="1 , 2 , 3",
          condition="加算Ⅰ　→　1\n加算Ⅱ　→　2\n加算Ⅲ　→　3",
          service=S, kind=UK_TAITEI,
          evidence="特別重度判定資料、医師意見書",
          reflect_cond=R_COUNT),
        u("短期利用加算", service=S, kind=UK_BASIC,
          condition="30日以内 / 年30日限度　→　○",
          evidence="利用期間記録",
          reflect_cond=R_COUNT),
        u("地域生活支援拠点加算", choices="1 , 2",
          condition="初日加算　→　1\n連携配置　→　2",
          service=S, kind=UK_SHUCHU,
          evidence="拠点登録通知、連携記録",
          reflect_cond=R_COUNT),
        # --- 月次・回数制 ---
        u("利用者負担上限額管理加算", service=S, kind=UK_SHUCHU,
          condition="月150単位/月　→　○",
          evidence="上限額管理結果票",
          reflect_cond=R_LATEST),
        u("定員超過特例加算", service=S, kind=UK_TAITEI,
          condition="特例利用（10日限度）　→　○",
          evidence="市町村の特例承認書",
          reflect_cond=R_COUNT),
        u("集中的支援加算", choices="1 , 2",
          condition="加算Ⅰ（月4回 3ヶ月限度）　→　1\n加算Ⅱ（日額 3ヶ月限度）　→　2",
          service=S, kind=UK_SHUCHU,
          evidence="集中支援計画書、行動評価",
          reflect_cond=R_COUNT,
          prompt="令和6年新設"),
        u("医療型短期入所受入前支援加算", choices="1 , 2",
          condition="加算Ⅰ　→　1\n加算Ⅱ　→　2",
          service=S, kind=UK_RENKEI,
          evidence="受入前事前訪問記録、医療機関連携記録",
          reflect_cond=R_LATEST,
          prompt="令和6年新設・医療型のみ"),
    ]


def build_tanki_kihon():
    S = "短期入所"
    return [
        k("氏名", S),
        k("氏名カナ", S),
        k("受給者証番号", S),
        k("支給市町村", S),
        k("利用者負担上限額", S),
    ]


# ============================================================
# §C. 日中一時支援（大和高田市）
# ============================================================
def build_nichu_jigyo():
    S = "日中一時支援"
    return [
        # 事業所加算は無し（市町村事業のため）
        # システム系のみ
        j("請求書役職", service=S, choices="", kind=K_SYSTEM, condition=""),
        j("請求書氏名", service=S, choices="", kind=K_SYSTEM, condition=""),
        j("利用者請求書備考", service=S, choices="", kind=K_SYSTEM, condition=""),
        j("実費1", service=S, choices="", kind=K_SYSTEM, condition=""),
        j("実費2", service=S, choices="", kind=K_SYSTEM, condition=""),
    ]


def build_nichu_riyousha():
    S = "日中一時支援"
    return [
        # 大和高田市要綱の 3 加算（すべて日数加算）
        u("食事加算", service=S, kind=UK_BASIC,
          condition="食事提供体制を確保している施設で食事提供　→　○",
          evidence="食事提供記録、栄養士配置",
          reflect_cond=R_COUNT,
          prompt="大和高田市要綱: 420円/日"),
        u("入浴加算", service=S, kind=UK_BASIC,
          condition="入浴サービス提供体制を確保し入浴介助　→　○",
          evidence="入浴介助記録、入浴設備",
          reflect_cond=R_COUNT,
          prompt="大和高田市要綱: 400円/日"),
        u("送迎加算", service=S, kind=UK_BASIC,
          condition="居宅と施設間の送迎（片道）　→　○",
          evidence="送迎運行記録",
          reflect_cond=R_COUNT,
          prompt="大和高田市要綱: 540円/片道"),
    ]


def build_nichu_kihon():
    S = "日中一時支援"
    return [
        k("氏名", S),
        k("氏名カナ", S),
        k("受給者証番号", S),
        k("支給市町村", S),
        k("利用者負担上限額", S),
    ]


# ============================================================
# CSV 出力
# ============================================================
def write_csv(rows, filename, header):
    p = OUT_DIR / filename
    with p.open("w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=header)
        w.writeheader()
        w.writerows(rows)
    print(f"  {filename:<35} {len(rows):>3} 行")


def main():
    print("=== 入所系 3 サービス × 3 マスタ = 9 CSV 生成 ===\n")

    print("[001_事業所加算マスタ]")
    write_csv(build_jido_jigyo(), "児童入所施設_事業所加算.csv", JIGYO_HEADER)
    write_csv(build_tanki_jigyo(), "短期入所_事業所加算.csv", JIGYO_HEADER)
    write_csv(build_nichu_jigyo(), "日中一時支援_事業所加算.csv", JIGYO_HEADER)

    print("\n[001_利用者加算マスタ]")
    write_csv(build_jido_riyousha(), "児童入所施設_利用者加算.csv", RIYOSHA_HEADER)
    write_csv(build_tanki_riyousha(), "短期入所_利用者加算.csv", RIYOSHA_HEADER)
    write_csv(build_nichu_riyousha(), "日中一時支援_利用者加算.csv", RIYOSHA_HEADER)

    print("\n[001_利用者基本マスタ]")
    write_csv(build_jido_kihon(), "児童入所施設_利用者基本.csv", KIHON_HEADER)
    write_csv(build_tanki_kihon(), "短期入所_利用者基本.csv", KIHON_HEADER)
    write_csv(build_nichu_kihon(), "日中一時支援_利用者基本.csv", KIHON_HEADER)

    # 合計
    total = (
        len(build_jido_jigyo()) + len(build_tanki_jigyo()) + len(build_nichu_jigyo())
        + len(build_jido_riyousha()) + len(build_tanki_riyousha()) + len(build_nichu_riyousha())
        + len(build_jido_kihon()) + len(build_tanki_kihon()) + len(build_nichu_kihon())
    )
    print(f"\n合計: {total} 行")


if __name__ == "__main__":
    main()
