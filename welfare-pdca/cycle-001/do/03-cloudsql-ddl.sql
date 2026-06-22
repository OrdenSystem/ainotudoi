-- -------------------------------------------------------------------
-- cycle: 001
-- related_spec_sections: §6.Must.3, §6.Must.5, §6.Must.6
-- streams_independent_of: [04, 06, 07, 09]
-- NOTE: 本 DDL は「新規設計版」。既存コピー元スキーマとの突合は Cycle 2 で実施（spec §8 R-03）。
-- -------------------------------------------------------------------
-- CloudSQL for MySQL 8.x / Enterprise / asia-northeast1
-- 文字コード: utf8mb4 / utf8mb4_unicode_ci
-- タイムゾーン: Asia/Tokyo（接続時 SET time_zone = 'Asia/Tokyo' を前提）
-- -------------------------------------------------------------------

SET NAMES utf8mb4;
SET time_zone = 'Asia/Tokyo';

CREATE DATABASE IF NOT EXISTS `welfare_db`
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE `welfare_db`;

-- -------------------------------------------------------------------
-- 1. 事業所マスタ
-- -------------------------------------------------------------------
CREATE TABLE `facilities` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `sf_account_id` VARCHAR(18)     DEFAULT NULL  COMMENT 'Salesforce Account Id（事業所法人が SF にある場合）',
  `facility_code` VARCHAR(20)     NOT NULL       COMMENT '指定事業所番号（都道府県付与）',
  `facility_name` VARCHAR(100)    NOT NULL,
  `service_type`  VARCHAR(30)     NOT NULL       COMMENT '生活介護/就B/GH 等',
  `prefecture`    VARCHAR(10)     NOT NULL,
  `is_active`     TINYINT(1)      NOT NULL DEFAULT 1,
  `created_at`    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_facility_code` (`facility_code`),
  KEY `idx_service_type` (`service_type`)
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_unicode_ci
  COMMENT='事業所マスタ';

-- -------------------------------------------------------------------
-- 2. 利用者ミラー（Salesforce PersonAccount の CloudSQL 同期先）
-- -------------------------------------------------------------------
-- PII 注記: recipient_cert_no は AES_ENCRYPT で暗号化保存。
--           disability_type は要配慮個人情報。アクセスは RLS + GAS サービスアカウントに限定。
CREATE TABLE `user_mirror` (
  `id`                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `sf_account_id`         VARCHAR(18)     NOT NULL COMMENT 'Salesforce PersonAccount.Id（同期キー）',
  `last_name`             VARCHAR(80)     NOT NULL,
  `first_name`            VARCHAR(40)     NOT NULL,
  `disability_type`       VARCHAR(20)     NOT NULL COMMENT '【要配慮PII】障害種別',
  `recipient_cert_no`     VARBINARY(64)   NOT NULL COMMENT '【特定機微PII】受給者証番号（AES_ENCRYPT済み）',
  `recipient_cert_expiry` DATE            NOT NULL,
  `facility_id`           BIGINT UNSIGNED NOT NULL,
  `is_active`             TINYINT(1)      NOT NULL DEFAULT 1,
  `sf_synced_at`          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Salesforce からの最終同期日時（JST）',
  `created_at`            DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`            DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_sf_account_id` (`sf_account_id`),
  KEY `idx_facility_active` (`facility_id`, `is_active`),
  CONSTRAINT `fk_um_facility`
    FOREIGN KEY (`facility_id`) REFERENCES `facilities` (`id`)
    ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_unicode_ci
  COMMENT='利用者ミラー — Salesforce PersonAccount 同期先。SoE(AppSheet)からの参照用';

-- -------------------------------------------------------------------
-- 3. スタッフ基本情報
-- -------------------------------------------------------------------
CREATE TABLE `staff` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `sf_user_id`    VARCHAR(18)     DEFAULT NULL COMMENT 'Salesforce User.Id（連携時に設定）',
  `last_name`     VARCHAR(40)     NOT NULL,
  `first_name`    VARCHAR(40)     NOT NULL,
  `email`         VARCHAR(100)    NOT NULL,
  `qualification` VARCHAR(50)     DEFAULT NULL COMMENT '資格区分（社会福祉士/介護福祉士/サービス管理責任者等）',
  `is_active`     TINYINT(1)      NOT NULL DEFAULT 1,
  `created_at`    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_email` (`email`),
  KEY `idx_sf_user_id` (`sf_user_id`)
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_unicode_ci
  COMMENT='スタッフ基本情報';

-- -------------------------------------------------------------------
-- 4. スタッフ × 事業所 兼務テーブル
-- spec §6.Must.5 受入基準「1スタッフが複数事業所兼務可能」対応
-- -------------------------------------------------------------------
CREATE TABLE `staff_facility` (
  `id`           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `staff_id`     BIGINT UNSIGNED NOT NULL,
  `facility_id`  BIGINT UNSIGNED NOT NULL,
  `primary_flag` TINYINT(1)      NOT NULL DEFAULT 0 COMMENT '1=主所属、0=兼務',
  `start_date`   DATE            NOT NULL,
  `end_date`     DATE            DEFAULT NULL COMMENT 'NULLは現在継続中',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_staff_facility` (`staff_id`, `facility_id`),
  KEY `idx_facility_active` (`facility_id`, `end_date`),
  CONSTRAINT `fk_sf_staff`
    FOREIGN KEY (`staff_id`) REFERENCES `staff` (`id`)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT `fk_sf_facility`
    FOREIGN KEY (`facility_id`) REFERENCES `facilities` (`id`)
    ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_unicode_ci
  COMMENT='スタッフ事業所兼務テーブル — 1スタッフ複数事業所対応';

-- -------------------------------------------------------------------
-- 5. シフト
-- spec §6.Must.5 受入基準「シフト衝突検出ルール」
-- 衝突検出: AppSheet Valid_If または GAS バッチで重複チェック（本 DDL では一意制約のみ）
-- -------------------------------------------------------------------
CREATE TABLE `shifts` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `staff_id`    BIGINT UNSIGNED NOT NULL,
  `facility_id` BIGINT UNSIGNED NOT NULL,
  `shift_date`  DATE            NOT NULL,
  `start_time`  TIME            NOT NULL COMMENT 'Asia/Tokyo 基準',
  `end_time`    TIME            NOT NULL COMMENT 'Asia/Tokyo 基準',
  `shift_type`  ENUM('normal','overtime','holiday') NOT NULL DEFAULT 'normal',
  `created_at`  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_staff_date` (`staff_id`, `shift_date`),
  KEY `idx_facility_date` (`facility_id`, `shift_date`),
  CONSTRAINT `fk_shift_staff`
    FOREIGN KEY (`staff_id`) REFERENCES `staff` (`id`)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT `fk_shift_facility`
    FOREIGN KEY (`facility_id`) REFERENCES `facilities` (`id`)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT `chk_shift_time`
    CHECK (`end_time` > `start_time`)
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_unicode_ci
  COMMENT='スタッフシフト — 同一スタッフの時刻重複は AppSheet/GAS 層で検出';

-- -------------------------------------------------------------------
-- 6. サービスマスタ
-- spec §8 R-04「サービスコード・単位数をハードコードしない」対応
-- -------------------------------------------------------------------
CREATE TABLE `service_master` (
  `id`               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `service_code`     VARCHAR(20)     NOT NULL COMMENT '国保連サービスコード',
  `service_name`     VARCHAR(100)    NOT NULL,
  `service_type`     VARCHAR(30)     NOT NULL COMMENT '生活介護/就B/GH等',
  `unit_per_minute`  DECIMAL(8,4)    DEFAULT NULL COMMENT '分あたり単位数（時間依存型）',
  `unit_fixed`       SMALLINT        DEFAULT NULL COMMENT '固定単位数（1回型）',
  `valid_from`       DATE            NOT NULL,
  `valid_to`         DATE            DEFAULT NULL COMMENT 'NULLは継続中',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_service_code_valid` (`service_code`, `valid_from`),
  KEY `idx_service_type` (`service_type`)
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_unicode_ci
  COMMENT='サービスマスタ — 報酬改定毎に valid_from で新行追加';

-- -------------------------------------------------------------------
-- 7. 加算・減算マスタ
-- spec §8 R-04 対応
-- -------------------------------------------------------------------
CREATE TABLE `addition_master` (
  `id`             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `addition_code`  VARCHAR(20)     NOT NULL COMMENT '加算/減算コード',
  `addition_name`  VARCHAR(100)    NOT NULL,
  `service_type`   VARCHAR(30)     NOT NULL COMMENT '対象サービス種別',
  `unit_diff`      SMALLINT        NOT NULL COMMENT '単位数増減（正=加算、負=減算）',
  `valid_from`     DATE            NOT NULL,
  `valid_to`       DATE            DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_addition_code_valid` (`addition_code`, `valid_from`)
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_unicode_ci
  COMMENT='加算減算マスタ — 報酬改定時に valid_from で新行追加';

-- -------------------------------------------------------------------
-- 8. 日次サービス提供記録
-- spec §6.Must.3 対応
-- INDEX: (user_id, service_date) — spec §6.Must.3 受入基準明示
-- タイムゾーン: Asia/Tokyo（接続時 SET time_zone で担保）
-- -------------------------------------------------------------------
CREATE TABLE `service_records` (
  `id`               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id`          BIGINT UNSIGNED NOT NULL,
  `staff_id`         BIGINT UNSIGNED NOT NULL,
  `service_id`       BIGINT UNSIGNED NOT NULL,
  `facility_id`      BIGINT UNSIGNED NOT NULL,
  `service_date`     DATE            NOT NULL COMMENT '提供日（Asia/Tokyo）',
  `start_time`       TIME            NOT NULL COMMENT '開始時刻（Asia/Tokyo）',
  `end_time`         TIME            NOT NULL COMMENT '終了時刻（Asia/Tokyo）',
  `duration_minutes` SMALLINT UNSIGNED NOT NULL COMMENT '提供時間（分）',
  `location_type`    ENUM('facility','home','other') NOT NULL DEFAULT 'facility',
  `location_note`    VARCHAR(100)    DEFAULT NULL,
  `notes`            TEXT            DEFAULT NULL COMMENT '【要配慮PII】特記事項（支援内容詳細）',
  `is_approved`      TINYINT(1)      NOT NULL DEFAULT 0,
  `approved_by`      BIGINT UNSIGNED DEFAULT NULL COMMENT 'FK → staff.id（承認者）',
  `approved_at`      DATETIME        DEFAULT NULL,
  `created_at`       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_user_date`     (`user_id`, `service_date`),    -- spec §6.Must.3 受入基準
  KEY `idx_staff_date`    (`staff_id`, `service_date`),
  KEY `idx_facility_date` (`facility_id`, `service_date`),
  CONSTRAINT `fk_sr_user`
    FOREIGN KEY (`user_id`) REFERENCES `user_mirror` (`id`)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT `fk_sr_staff`
    FOREIGN KEY (`staff_id`) REFERENCES `staff` (`id`)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT `fk_sr_service`
    FOREIGN KEY (`service_id`) REFERENCES `service_master` (`id`)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT `fk_sr_facility`
    FOREIGN KEY (`facility_id`) REFERENCES `facilities` (`id`)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT `fk_sr_approver`
    FOREIGN KEY (`approved_by`) REFERENCES `staff` (`id`)
    ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT `chk_sr_time`
    CHECK (`end_time` > `start_time`),
  CONSTRAINT `chk_sr_duration`
    CHECK (`duration_minutes` > 0)
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_unicode_ci
  COMMENT='日次サービス提供記録 — 楽観ロックは updated_at で実装（spec §8 R-08）';

-- -------------------------------------------------------------------
-- 9. 請求準備データ
-- spec §6.Must.6 対応
-- UNIQUE KEY で冪等性を担保（同バッチ実行の二重書き込み防止）
-- -------------------------------------------------------------------
CREATE TABLE `billing_prep` (
  `id`               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id`          BIGINT UNSIGNED NOT NULL,
  `facility_id`      BIGINT UNSIGNED NOT NULL,
  `billing_year_month` CHAR(6)       NOT NULL COMMENT '対象年月 YYYYMM',
  `service_id`       BIGINT UNSIGNED NOT NULL,
  `service_days`     TINYINT UNSIGNED NOT NULL,
  `total_units`      DECIMAL(10,2)   NOT NULL COMMENT '基本単位数合計',
  `addition_units`   DECIMAL(10,2)   NOT NULL DEFAULT 0.00,
  `deduction_units`  DECIMAL(10,2)   NOT NULL DEFAULT 0.00,
  `net_units`        DECIMAL(10,2)   NOT NULL COMMENT '請求単位数 = total + addition - deduction',
  `batch_run_id`     VARCHAR(50)     NOT NULL COMMENT 'バッチ実行ID（冪等性キー）',
  `status`           ENUM('draft','confirmed','submitted') NOT NULL DEFAULT 'draft',
  `created_at`       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_billing_idempotent` (`user_id`, `billing_year_month`, `service_id`, `batch_run_id`),
  KEY `idx_billing_ym_facility` (`billing_year_month`, `facility_id`),
  CONSTRAINT `fk_bp_user`
    FOREIGN KEY (`user_id`) REFERENCES `user_mirror` (`id`)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT `fk_bp_facility`
    FOREIGN KEY (`facility_id`) REFERENCES `facilities` (`id`)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT `fk_bp_service`
    FOREIGN KEY (`service_id`) REFERENCES `service_master` (`id`)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT `chk_bp_net_units`
    CHECK (`net_units` >= 0)
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_unicode_ci
  COMMENT='請求準備データ — batch_run_id で冪等性担保（spec §6.Must.6）';

-- -------------------------------------------------------------------
-- 10. 支給決定残量ビュー（spec §6.Must.4「支給決定残量計算」対応）
-- AppSheet から参照する集計ビュー。実体データは SF_ServiceAllotment（Salesforce 側）。
-- CloudSQL 側では service_records を集計して消費量を算出。
-- -------------------------------------------------------------------
-- NOTE: Salesforce の支給量は GAS 経由で user_allotment_cache テーブルに同期する（Cycle 1 設計）
CREATE TABLE `user_allotment_cache` (
  `id`             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id`        BIGINT UNSIGNED NOT NULL,
  `service_type`   VARCHAR(30)     NOT NULL,
  `allotment_qty`  DECIMAL(10,2)   NOT NULL COMMENT '支給量（時間/回数/日）',
  `allotment_unit` ENUM('hour','times','day') NOT NULL,
  `valid_from`     DATE            NOT NULL,
  `valid_to`       DATE            DEFAULT NULL,
  `sf_allotment_id` VARCHAR(18)    DEFAULT NULL COMMENT 'Salesforce ServiceAllotment__c.Id',
  `sf_synced_at`   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `created_at`     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_user_valid` (`user_id`, `valid_from`, `valid_to`),
  CONSTRAINT `fk_uac_user`
    FOREIGN KEY (`user_id`) REFERENCES `user_mirror` (`id`)
    ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_unicode_ci
  COMMENT='支給決定残量計算用キャッシュ（Salesforce ServiceAllotment 同期先）';

-- 支給決定残量集計ビュー
CREATE OR REPLACE VIEW `v_allotment_usage` AS
SELECT
  u.id                         AS user_id,
  u.sf_account_id,
  CONCAT(u.last_name, u.first_name) AS user_name,
  a.service_type,
  a.allotment_qty,
  a.allotment_unit,
  a.valid_from,
  a.valid_to,
  -- 当月消費時間（hour 単位の場合）
  COALESCE(
    SUM(
      CASE WHEN a.allotment_unit = 'hour'
        THEN sr.duration_minutes / 60.0
        ELSE NULL
      END
    ),
    0
  ) AS consumed_hours,
  -- 当月消費回数（times 単位の場合）
  COALESCE(
    SUM(
      CASE WHEN a.allotment_unit = 'times'
        THEN 1
        ELSE NULL
      END
    ),
    0
  ) AS consumed_times,
  -- 当月消費日数（day 単位の場合）
  COALESCE(
    COUNT(DISTINCT CASE WHEN a.allotment_unit = 'day' THEN sr.service_date ELSE NULL END),
    0
  ) AS consumed_days,
  -- 残量（超過を負で表現）
  CASE a.allotment_unit
    WHEN 'hour'  THEN a.allotment_qty - COALESCE(SUM(sr.duration_minutes / 60.0), 0)
    WHEN 'times' THEN a.allotment_qty - COALESCE(COUNT(sr.id), 0)
    WHEN 'day'   THEN a.allotment_qty - COALESCE(COUNT(DISTINCT sr.service_date), 0)
  END                          AS remaining_qty
FROM `user_allotment_cache` a
JOIN `user_mirror` u
  ON u.id = a.user_id
LEFT JOIN `service_records` sr
  ON sr.user_id = a.user_id
 AND sr.service_date BETWEEN a.valid_from AND COALESCE(a.valid_to, '9999-12-31')
 AND sr.is_approved = 1
WHERE a.valid_from <= CURDATE()
  AND (a.valid_to IS NULL OR a.valid_to >= CURDATE())
GROUP BY
  u.id, u.sf_account_id, u.last_name, u.first_name,
  a.service_type, a.allotment_qty, a.allotment_unit,
  a.valid_from, a.valid_to;

-- -------------------------------------------------------------------
-- 11. システム監査ログ
-- spec §6.Must.8 対応 / 保持期間 5年（法務レビュー要フラグ）
-- -------------------------------------------------------------------
CREATE TABLE `audit_log` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `event_type`  VARCHAR(50)     NOT NULL COMMENT 'CREATE/UPDATE/DELETE/LOGIN/EXPORT等',
  `table_name`  VARCHAR(50)     DEFAULT NULL,
  `record_id`   VARCHAR(50)     DEFAULT NULL,
  `actor_type`  ENUM('staff','gas_batch','system') NOT NULL,
  `actor_id`    VARCHAR(50)     NOT NULL,
  `before_json` JSON            DEFAULT NULL,
  `after_json`  JSON            DEFAULT NULL,
  `ip_address`  VARCHAR(45)     DEFAULT NULL,
  `created_at`  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_event_created` (`event_type`, `created_at`),
  KEY `idx_actor`         (`actor_type`, `actor_id`),
  KEY `idx_table_record`  (`table_name`, `record_id`)
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_unicode_ci
  COMMENT='システム監査ログ — 保持5年、物理削除は定期バッチ（08-security-and-privacy.md参照）';

-- -------------------------------------------------------------------
-- 12. GAS バッチ実行ログ
-- spec §6.Must.7「実行ログ保存先」対応
-- -------------------------------------------------------------------
CREATE TABLE `batch_run_log` (
  `id`           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `batch_name`   VARCHAR(50)     NOT NULL COMMENT 'バッチ識別名（例: sf_sync_users, monthly_billing）',
  `run_id`       VARCHAR(50)     NOT NULL COMMENT 'UUID等の一意実行ID',
  `status`       ENUM('running','success','failed','partial') NOT NULL DEFAULT 'running',
  `started_at`   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `finished_at`  DATETIME        DEFAULT NULL,
  `records_processed` INT        DEFAULT 0,
  `records_failed`    INT        DEFAULT 0,
  `error_message` TEXT           DEFAULT NULL,
  `retry_count`  TINYINT         NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_run_id` (`run_id`),
  KEY `idx_batch_name_status` (`batch_name`, `status`)
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_unicode_ci
  COMMENT='GASバッチ実行ログ — spec §6.Must.7 受入基準「実行ログ保存先」';

-- -------------------------------------------------------------------
-- EOF
-- スキーマ注記:
--   - CloudSQL for MySQL 8.x / Enterprise Edition
--   - リージョン: asia-northeast1（東京）
--   - インスタンス想定: db-custom-2-7680
--   - recipient_cert_no は AES_ENCRYPT/AES_DECRYPT で暗号化（鍵は Cloud Secret Manager 管理）
--   - テーブル削除順（FK制約考慮）:
--     audit_log → batch_run_log → billing_prep → service_records → shifts → user_allotment_cache
--     → staff_facility → user_mirror → staff → service_master → addition_master → facilities
-- -------------------------------------------------------------------
