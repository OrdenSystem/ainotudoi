-- -------------------------------------------------------------------
-- cycle: 002
-- related_spec_sections: §6.Must.1, §6.Must.3, §6.Must.4, §6.Must.5, §6.Must.6, §6.Must.10, §6.Must.11, §4（SoR単一化）, §4（鍵管理経路）
-- streams_independent_of: [04, 05, 06, 07, 09]
-- NOTE: 本 DDL は「新規設計版」。既存コピー元スキーマとの突合は Cycle 3 で実施（spec §8 R-03）。
-- -------------------------------------------------------------------
-- CloudSQL for MySQL 8.x / Enterprise / asia-northeast1
-- 文字コード: utf8mb4 / utf8mb4_unicode_ci
-- タイムゾーン: Asia/Tokyo（接続時 SET time_zone = 'Asia/Tokyo' を前提）
-- CMEK: KEK = projects/{p}/locations/asia-northeast1/keyRings/welfare/cryptoKeys/cloudsql-kek
--        Cloud SQL インスタンス作成時に --disk-encryption-key で指定（C-01 解消）
-- Application-level 暗号化: Cloud KMS API encrypt/decrypt で受給者証番号を暗号化
--   KeyPath = projects/{p}/locations/asia-northeast1/keyRings/welfare/cryptoKeys/cloudsql-kek
--   ※ AES_ENCRYPT(?, @@global.secure_file_priv) は全廃（C-01 解消）
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
-- 2. Facility ID マッピング（C-06 解消）
-- Salesforce Facility__c.Id <-> CloudSQL facilities.id 変換テーブル
-- GAS syncFacilitiesFromSF が管理。全テーブルの facility_id FK はこのテーブル経由で解決。
-- -------------------------------------------------------------------
CREATE TABLE `facility_id_map` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `salesforce_id` VARCHAR(18)     NOT NULL COMMENT 'Salesforce Facility__c.Id（18桁）',
  `cloudsql_id`   BIGINT UNSIGNED NOT NULL COMMENT 'CloudSQL facilities.id',
  `facility_name` VARCHAR(100)    NOT NULL COMMENT '事業所名（参照用キャッシュ）',
  `is_active`     TINYINT(1)      NOT NULL DEFAULT 1,
  `sf_synced_at`  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `created_at`    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_salesforce_id` (`salesforce_id`),
  UNIQUE KEY `uq_cloudsql_id`   (`cloudsql_id`),
  CONSTRAINT `fk_fim_facility`
    FOREIGN KEY (`cloudsql_id`) REFERENCES `facilities` (`id`)
    ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_unicode_ci
  COMMENT='Salesforce Facility__c <-> CloudSQL facilities ID マッピング（C-06解消）';

-- -------------------------------------------------------------------
-- 3. 利用者ミラー（Salesforce PersonAccount の CloudSQL 同期先）
-- C-01 解消: recipient_cert_no の暗号化は Cloud KMS Application-level 暗号化に変更。
--            AES_ENCRYPT(?, @@global.secure_file_priv) は廃止。
--            暗号化済みバイト列を VARBINARY(256) に格納。
-- C-06 解消: facility_id は facility_id_map.cloudsql_id 経由で解決済みのものを格納。
-- -------------------------------------------------------------------
CREATE TABLE `user_mirror` (
  `id`                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `sf_account_id`         VARCHAR(18)     NOT NULL COMMENT 'Salesforce PersonAccount.Id（同期キー）',
  `last_name`             VARCHAR(80)     NOT NULL,
  `first_name`            VARCHAR(40)     NOT NULL,
  `disability_type`       ENUM('physical','intellectual','mental','developmental','other')
                                          NOT NULL COMMENT '【要配慮PII】障害種別（SF picklist と対応 — C-14）',
  `recipient_cert_no`     VARBINARY(256)  NOT NULL COMMENT '【特定機微PII】受給者証番号（Cloud KMS Application-level 暗号化済み。KeyPath: projects/{p}/locations/asia-northeast1/keyRings/welfare/cryptoKeys/cloudsql-kek — C-01）',
  `recipient_cert_expiry` DATE            NOT NULL,
  `facility_id`           BIGINT UNSIGNED NOT NULL COMMENT 'facility_id_map.cloudsql_id 経由で解決済み（C-06）',
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
-- 4. スタッフ基本情報（C-16 解消: role enum 追加）
-- -------------------------------------------------------------------
CREATE TABLE `staff` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `sf_user_id`    VARCHAR(18)     DEFAULT NULL COMMENT 'Salesforce User.Id（同期キー）',
  `last_name`     VARCHAR(40)     NOT NULL,
  `first_name`    VARCHAR(40)     NOT NULL,
  `email`         VARCHAR(100)    NOT NULL,
  `role`          ENUM('service_manager','service_provider_lead','support_worker','billing_officer','facility_admin')
                                  NOT NULL DEFAULT 'support_worker' COMMENT '役職（C-16解消）',
  `qualification` VARCHAR(50)     DEFAULT NULL COMMENT '資格区分（社会福祉士/介護福祉士/サービス管理責任者等）',
  `is_active`     TINYINT(1)      NOT NULL DEFAULT 1,
  `created_at`    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_email` (`email`),
  KEY `idx_sf_user_id` (`sf_user_id`),
  KEY `idx_role_active` (`role`, `is_active`)
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_unicode_ci
  COMMENT='スタッフ基本情報（role: service_manager/service_provider_lead/support_worker/billing_officer/facility_admin）';

-- -------------------------------------------------------------------
-- 5. スタッフ × 事業所 兼務テーブル（AppSheet Security Filter 参照元 — C-05 解消）
-- AppSheet Security Filter 式: [facility_id] IN SELECT(staff_facility_map[facility_id], [email] = USEREMAIL())
-- USERSETTINGS() 参照なし（C-05 解消）
-- -------------------------------------------------------------------
CREATE TABLE `staff_facility_map` (
  `id`           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `staff_id`     BIGINT UNSIGNED NOT NULL,
  `facility_id`  BIGINT UNSIGNED NOT NULL,
  `email`        VARCHAR(100)    NOT NULL COMMENT 'AppSheet Security Filter で USEREMAIL() と照合するメールアドレス（C-05）',
  `primary_flag` TINYINT(1)      NOT NULL DEFAULT 0 COMMENT '1=主所属、0=兼務',
  `start_date`   DATE            NOT NULL,
  `end_date`     DATE            DEFAULT NULL COMMENT 'NULLは現在継続中',
  `created_at`   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_staff_facility` (`staff_id`, `facility_id`),
  KEY `idx_email_facility` (`email`, `facility_id`),
  KEY `idx_facility_active` (`facility_id`, `end_date`),
  CONSTRAINT `fk_sfm_staff`
    FOREIGN KEY (`staff_id`) REFERENCES `staff` (`id`)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT `fk_sfm_facility`
    FOREIGN KEY (`facility_id`) REFERENCES `facilities` (`id`)
    ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_unicode_ci
  COMMENT='スタッフ事業所兼務テーブル — AppSheet Security Filter: USEREMAIL()+email列参照（C-05解消）';

-- -------------------------------------------------------------------
-- 6. シフト（C-07 解消: is_overnight フラグ追加、chk_shift_time を緩和）
-- 夜勤シフト例: shift_date='2026-06-01', start_time='22:00', end_time='08:00', is_overnight=1
--  → 2026-06-01 22:00 ～ 2026-06-02 08:00 の日跨ぎシフト
-- spec §3「夜勤シフトは start_time > end_time の表現を許容」対応（C-07）
-- -------------------------------------------------------------------
CREATE TABLE `shifts` (
  `id`           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `staff_id`     BIGINT UNSIGNED NOT NULL,
  `facility_id`  BIGINT UNSIGNED NOT NULL,
  `shift_date`   DATE            NOT NULL COMMENT 'シフト開始日（is_overnight=1の場合、翌日が終了日）',
  `start_time`   TIME            NOT NULL COMMENT 'Asia/Tokyo 基準',
  `end_time`     TIME            NOT NULL COMMENT 'Asia/Tokyo 基準。is_overnight=1の場合 start_time > end_time を許容（C-07）',
  `is_overnight` TINYINT(1)      NOT NULL DEFAULT 0 COMMENT '夜勤日跨ぎフラグ（C-07解消）: 1=翌日まで継続',
  `shift_type`   ENUM('normal','overnight','holiday') NOT NULL DEFAULT 'normal',
  `created_at`   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_staff_date`    (`staff_id`, `shift_date`),
  KEY `idx_facility_date` (`facility_id`, `shift_date`),
  CONSTRAINT `fk_shift_staff`
    FOREIGN KEY (`staff_id`) REFERENCES `staff` (`id`)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT `fk_shift_facility`
    FOREIGN KEY (`facility_id`) REFERENCES `facilities` (`id`)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  -- C-07 解消: end_time > start_time の制約を廃止し end_time != start_time のみに緩和
  -- 夜勤(is_overnight=1)の場合 start_time > end_time が正常（例: 22:00 ～ 08:00）
  CONSTRAINT `chk_shift_time`
    CHECK (`end_time` != `start_time`)
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_unicode_ci
  COMMENT='スタッフシフト — is_overnight=1で夜勤日跨ぎ対応（C-07解消）。衝突検出はAppSheet/GAS層';

-- -------------------------------------------------------------------
-- 7. サービスマスタ（報酬改定対応: valid_from で新行追加）
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
  `created_at`       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_service_code_valid` (`service_code`, `valid_from`),
  KEY `idx_service_type` (`service_type`)
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_unicode_ci
  COMMENT='サービスマスタ — 報酬改定毎に valid_from で新行追加';

-- -------------------------------------------------------------------
-- 8. 加算・減算マスタ
-- -------------------------------------------------------------------
CREATE TABLE `addition_master` (
  `id`             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `addition_code`  VARCHAR(20)     NOT NULL COMMENT '加算/減算コード',
  `addition_name`  VARCHAR(100)    NOT NULL,
  `service_type`   VARCHAR(30)     NOT NULL COMMENT '対象サービス種別',
  `unit_diff`      SMALLINT        NOT NULL COMMENT '単位数増減（正=加算、負=減算）',
  `valid_from`     DATE            NOT NULL,
  `valid_to`       DATE            DEFAULT NULL,
  `created_at`     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_addition_code_valid` (`addition_code`, `valid_from`)
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_unicode_ci
  COMMENT='加算減算マスタ — 報酬改定時に valid_from で新行追加';

-- -------------------------------------------------------------------
-- 9. 日次サービス提供記録
-- spec §6.Must.3 対応 / shift_date 参照でGH夜勤日跨ぎを追跡
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
  `shift_date`       DATE            DEFAULT NULL COMMENT '参照シフト日（夜勤の場合 service_date と異なる可能性）',
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
  CONSTRAINT `chk_sr_duration`
    CHECK (`duration_minutes` > 0)
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_unicode_ci
  COMMENT='日次サービス提供記録 — 楽観ロックは updated_at で実装（spec §8 R-08）';

-- -------------------------------------------------------------------
-- 10. 支給決定キャッシュ（Salesforce ServiceAllotment 同期先）
-- C-02 解消: v_allotment_usage は月単位集計に修正
-- -------------------------------------------------------------------
CREATE TABLE `user_allotment_cache` (
  `id`               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id`          BIGINT UNSIGNED NOT NULL,
  `sf_allotment_id`  VARCHAR(18)     DEFAULT NULL COMMENT 'Salesforce ServiceAllotment__c.Id（同期キー）',
  `service_type`     VARCHAR(30)     NOT NULL,
  `allotment_qty`    DECIMAL(10,2)   NOT NULL COMMENT '支給量（時間/回数/日）',
  `allotment_unit`   ENUM('hour','times','day') NOT NULL,
  `valid_from`       DATE            NOT NULL,
  `valid_to`         DATE            DEFAULT NULL,
  `service_year_month` CHAR(6)       DEFAULT NULL COMMENT '月次集計パーティション列（YYYYMM）',
  `sf_synced_at`     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `created_at`       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_sf_allotment_id` (`sf_allotment_id`),
  KEY `idx_user_valid` (`user_id`, `valid_from`, `valid_to`),
  CONSTRAINT `fk_uac_user`
    FOREIGN KEY (`user_id`) REFERENCES `user_mirror` (`id`)
    ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_unicode_ci
  COMMENT='支給決定残量計算用キャッシュ（Salesforce ServiceAllotment 同期先）';

-- -------------------------------------------------------------------
-- 支給決定残量集計ビュー（C-02 解消）
-- C-02 解消: WHERE 句に月単位フィルタを追加
--   YEAR(sr.service_date) = YEAR(NOW()) AND MONTH(sr.service_date) = MONTH(NOW())
-- Cycle 1 の「有効期間全体の累積集計」を「当月分のみの集計」に修正
-- -------------------------------------------------------------------
CREATE OR REPLACE VIEW `v_allotment_usage` AS
SELECT
  u.id                              AS user_id,
  u.sf_account_id,
  CONCAT(u.last_name, u.first_name) AS user_name,
  a.service_type,
  a.allotment_qty,
  a.allotment_unit,
  a.valid_from,
  a.valid_to,
  -- 当月消費時間（hour 単位）— C-02: 月単位フィルタ適用
  COALESCE(
    SUM(
      CASE
        WHEN a.allotment_unit = 'hour'
          AND YEAR(sr.service_date)  = YEAR(NOW())
          AND MONTH(sr.service_date) = MONTH(NOW())
        THEN sr.duration_minutes / 60.0
        ELSE NULL
      END
    ),
    0
  ) AS consumed_hours,
  -- 当月消費回数（times 単位）— C-02: 月単位フィルタ適用
  COALESCE(
    SUM(
      CASE
        WHEN a.allotment_unit = 'times'
          AND YEAR(sr.service_date)  = YEAR(NOW())
          AND MONTH(sr.service_date) = MONTH(NOW())
        THEN 1
        ELSE NULL
      END
    ),
    0
  ) AS consumed_times,
  -- 当月消費日数（day 単位）— C-02: 月単位フィルタ適用
  COALESCE(
    COUNT(DISTINCT
      CASE
        WHEN a.allotment_unit = 'day'
          AND YEAR(sr.service_date)  = YEAR(NOW())
          AND MONTH(sr.service_date) = MONTH(NOW())
        THEN sr.service_date
        ELSE NULL
      END
    ),
    0
  ) AS consumed_days,
  -- 残量（超過を負で表現）— 当月分のみで計算（C-02 解消）
  CASE a.allotment_unit
    WHEN 'hour'  THEN a.allotment_qty - COALESCE(
      SUM(CASE WHEN YEAR(sr.service_date) = YEAR(NOW()) AND MONTH(sr.service_date) = MONTH(NOW())
               THEN sr.duration_minutes / 60.0 ELSE NULL END), 0)
    WHEN 'times' THEN a.allotment_qty - COALESCE(
      SUM(CASE WHEN YEAR(sr.service_date) = YEAR(NOW()) AND MONTH(sr.service_date) = MONTH(NOW())
               AND a.allotment_unit = 'times' THEN 1 ELSE NULL END), 0)
    WHEN 'day'   THEN a.allotment_qty - COALESCE(
      COUNT(DISTINCT CASE WHEN YEAR(sr.service_date) = YEAR(NOW()) AND MONTH(sr.service_date) = MONTH(NOW())
                          AND a.allotment_unit = 'day' THEN sr.service_date ELSE NULL END), 0)
  END AS remaining_qty
FROM `user_allotment_cache` a
JOIN `user_mirror` u
  ON u.id = a.user_id
LEFT JOIN `service_records` sr
  ON sr.user_id      = a.user_id
 AND sr.service_date BETWEEN a.valid_from AND COALESCE(a.valid_to, '9999-12-31')
 AND sr.is_approved  = 1
WHERE a.valid_from  <= CURDATE()
  AND (a.valid_to IS NULL OR a.valid_to >= CURDATE())
GROUP BY
  u.id, u.sf_account_id, u.last_name, u.first_name,
  a.service_type, a.allotment_qty, a.allotment_unit,
  a.valid_from, a.valid_to;

-- -------------------------------------------------------------------
-- 11. 契約ミラー（Salesforce ServiceContract 同期先）— Must.10 対応
-- C-04 解消: AppSheet は CloudSQL 経由でのみ参照
-- -------------------------------------------------------------------
CREATE TABLE `contract_mirror` (
  `id`                        BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `sf_contract_id`            VARCHAR(18)     NOT NULL COMMENT 'Salesforce ServiceContract__c.Id（同期キー）',
  `user_id`                   BIGINT UNSIGNED NOT NULL,
  `facility_id`               BIGINT UNSIGNED NOT NULL,
  `contract_start_date`       DATE            NOT NULL,
  `contract_end_date`         DATE            DEFAULT NULL COMMENT 'NULLは継続中',
  `service_type`              VARCHAR(30)     NOT NULL,
  `status`                    ENUM('draft','active','expired','terminated') NOT NULL DEFAULT 'draft',
  `has_important_matter_doc`  TINYINT(1)      NOT NULL DEFAULT 0 COMMENT '重要事項説明書交付済みフラグ',
  `has_consent_form`          TINYINT(1)      NOT NULL DEFAULT 0 COMMENT '同意書取得済みフラグ',
  `sf_synced_at`              DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `created_at`                DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`                DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_sf_contract_id` (`sf_contract_id`),
  KEY `idx_user_status`          (`user_id`, `status`),
  KEY `idx_facility_status`      (`facility_id`, `status`),
  CONSTRAINT `fk_cm_user`
    FOREIGN KEY (`user_id`) REFERENCES `user_mirror` (`id`)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT `fk_cm_facility`
    FOREIGN KEY (`facility_id`) REFERENCES `facilities` (`id`)
    ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_unicode_ci
  COMMENT='契約ミラー — Salesforce ServiceContract__c 同期先（Must.10）';

-- -------------------------------------------------------------------
-- 12. 上限管理事業所マスタ — Must.11 対応（C-03 解消）
-- -------------------------------------------------------------------
CREATE TABLE `upper_limit_facility` (
  `id`              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `facility_number` VARCHAR(20)     NOT NULL COMMENT '指定事業所番号',
  `facility_name`   VARCHAR(100)    NOT NULL,
  `prefecture`      VARCHAR(10)     NOT NULL,
  `contact_person`  VARCHAR(80)     DEFAULT NULL COMMENT '担当者名',
  `contact_phone`   VARCHAR(20)     DEFAULT NULL,
  `is_own_facility` TINYINT(1)      NOT NULL DEFAULT 0 COMMENT '1=当事業所、0=他事業所',
  `is_active`       TINYINT(1)      NOT NULL DEFAULT 1,
  `created_at`      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_facility_number` (`facility_number`)
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_unicode_ci
  COMMENT='上限管理事業所マスタ（Must.11 / C-03解消）';

-- -------------------------------------------------------------------
-- 13. 利用者負担上限月額決定 — Must.11 対応（C-03 解消）
-- -------------------------------------------------------------------
CREATE TABLE `upper_limit_decision` (
  `id`                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id`               BIGINT UNSIGNED NOT NULL,
  `upper_limit_facility_id` BIGINT UNSIGNED NOT NULL,
  `monthly_upper_limit`   DECIMAL(10,2)   NOT NULL COMMENT '利用者負担上限月額（円）',
  `copayment_type`        ENUM('none','family_income_based','flat') NOT NULL DEFAULT 'family_income_based'
                                          COMMENT '負担区分',
  `valid_from`            DATE            NOT NULL,
  `valid_to`              DATE            DEFAULT NULL COMMENT 'NULLは継続',
  `created_at`            DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`            DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_user_valid_from` (`user_id`, `valid_from`),
  KEY `idx_user_valid`            (`user_id`, `valid_from`, `valid_to`),
  CONSTRAINT `fk_uld_user`
    FOREIGN KEY (`user_id`) REFERENCES `user_mirror` (`id`)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT `fk_uld_facility`
    FOREIGN KEY (`upper_limit_facility_id`) REFERENCES `upper_limit_facility` (`id`)
    ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_unicode_ci
  COMMENT='利用者負担上限月額決定（Must.11 / C-03解消）';

-- -------------------------------------------------------------------
-- 14. 上限管理結果票 — Must.11 対応（C-03 解消）
-- 国保連請求の前提として billing_prep が本テーブルを参照（Must.6）
-- ⚠️ L-13: 電子授受方式は国保連確認要
-- -------------------------------------------------------------------
CREATE TABLE `upper_limit_result_sheet` (
  `id`                      BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id`                 BIGINT UNSIGNED NOT NULL,
  `upper_limit_decision_id` BIGINT UNSIGNED NOT NULL,
  `billing_year_month`      CHAR(6)         NOT NULL COMMENT '対象年月（YYYYMM）',
  `direction`               ENUM('sent','received') NOT NULL
                                            COMMENT '発行=sent（当事業所管理）/ 受信=received（他事業所管理）',
  `total_cost_all_facilities` DECIMAL(12,2) NOT NULL COMMENT '全事業所合算費用（円）',
  `own_facility_cost`       DECIMAL(12,2)   NOT NULL COMMENT '当事業所費用（円）',
  `adjusted_copayment`      DECIMAL(10,2)   NOT NULL COMMENT '調整後利用者負担額（円）',
  `received_evidence_url`   VARCHAR(500)    DEFAULT NULL COMMENT '受信エビデンスファイルURL（⚠️ L-13）',
  `is_confirmed`            TINYINT(1)      NOT NULL DEFAULT 0 COMMENT '確認済みフラグ',
  `confirmed_at`            DATETIME        DEFAULT NULL,
  `confirmed_by`            BIGINT UNSIGNED DEFAULT NULL,
  `created_at`              DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`              DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_user_ym_direction` (`user_id`, `billing_year_month`, `direction`),
  KEY `idx_ym_confirmed`            (`billing_year_month`, `is_confirmed`),
  CONSTRAINT `fk_ulrs_user`
    FOREIGN KEY (`user_id`) REFERENCES `user_mirror` (`id`)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT `fk_ulrs_decision`
    FOREIGN KEY (`upper_limit_decision_id`) REFERENCES `upper_limit_decision` (`id`)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT `fk_ulrs_confirmer`
    FOREIGN KEY (`confirmed_by`) REFERENCES `staff` (`id`)
    ON UPDATE CASCADE ON DELETE SET NULL
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_unicode_ci
  COMMENT='上限管理結果票（Must.11 / C-03解消）— billing_prep が参照（Must.6）';

-- -------------------------------------------------------------------
-- 15. 請求準備データ（Must.6 / 上限管理結果票参照追加）
-- -------------------------------------------------------------------
CREATE TABLE `billing_prep` (
  `id`                         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id`                    BIGINT UNSIGNED NOT NULL,
  `facility_id`                BIGINT UNSIGNED NOT NULL,
  `billing_year_month`         CHAR(6)         NOT NULL COMMENT '対象年月 YYYYMM',
  `service_id`                 BIGINT UNSIGNED NOT NULL,
  `upper_limit_result_sheet_id` BIGINT UNSIGNED DEFAULT NULL COMMENT 'FK → upper_limit_result_sheet.id（Must.11 反映）',
  `service_days`               TINYINT UNSIGNED NOT NULL,
  `total_units`                DECIMAL(10,2)   NOT NULL COMMENT '基本単位数合計',
  `addition_units`             DECIMAL(10,2)   NOT NULL DEFAULT 0.00,
  `deduction_units`            DECIMAL(10,2)   NOT NULL DEFAULT 0.00,
  `net_units`                  DECIMAL(10,2)   NOT NULL COMMENT '請求単位数 = total + addition - deduction',
  `adjusted_copayment`         DECIMAL(10,2)   DEFAULT NULL COMMENT '上限管理後利用者負担額（Must.11 反映）',
  `batch_run_id`               VARCHAR(50)     NOT NULL COMMENT 'バッチ実行ID（冪等性キー）',
  `status`                     ENUM('draft','confirmed','submitted') NOT NULL DEFAULT 'draft',
  `created_at`                 DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`                 DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_billing_idempotent` (`user_id`, `billing_year_month`, `service_id`, `batch_run_id`),
  KEY `idx_billing_ym_facility`      (`billing_year_month`, `facility_id`),
  CONSTRAINT `fk_bp_user`
    FOREIGN KEY (`user_id`) REFERENCES `user_mirror` (`id`)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT `fk_bp_facility`
    FOREIGN KEY (`facility_id`) REFERENCES `facilities` (`id`)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT `fk_bp_service`
    FOREIGN KEY (`service_id`) REFERENCES `service_master` (`id`)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT `fk_bp_upper_limit`
    FOREIGN KEY (`upper_limit_result_sheet_id`) REFERENCES `upper_limit_result_sheet` (`id`)
    ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT `chk_bp_net_units`
    CHECK (`net_units` >= 0)
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_unicode_ci
  COMMENT='請求準備データ — batch_run_id で冪等性担保（spec §6.Must.6）';

-- -------------------------------------------------------------------
-- 16. システム監査ログ（append-only / C-10 解消）
-- append-only 実現: CREATE TABLE 後に appwrite ユーザーへの UPDATE/DELETE 権限を剥奪
--   REVOKE UPDATE, DELETE ON welfare_db.audit_log FROM 'appwrite_user'@'%';
-- Cloud Storage WORM バケット（Bucket Lock + retention 5年）への書出し:
--   Cloud Run jobs または GAS が1時間ごとに未エクスポート行を GCS に書出し（08-security-and-privacy.md §5）
-- -------------------------------------------------------------------
CREATE TABLE `audit_log` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `event_type`  VARCHAR(50)     NOT NULL COMMENT 'CREATE/UPDATE/DELETE/LOGIN/EXPORT/SYNC_SF/BILLING_PREP等',
  `table_name`  VARCHAR(50)     DEFAULT NULL,
  `record_id`   VARCHAR(50)     DEFAULT NULL,
  `actor_type`  ENUM('staff','gas_batch','cloud_run_job','system') NOT NULL,
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
  COMMENT='システム監査ログ — append-only（UPDATE/DELETE 権限剥奪）+ WORM バケット書出し（C-10解消）';

-- -------------------------------------------------------------------
-- 17. GAS バッチ実行ログ
-- -------------------------------------------------------------------
CREATE TABLE `batch_run_log` (
  `id`                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `batch_name`         VARCHAR(50)     NOT NULL COMMENT 'バッチ識別名',
  `run_id`             VARCHAR(50)     NOT NULL COMMENT 'UUID等の一意実行ID',
  `status`             ENUM('running','success','failed','partial') NOT NULL DEFAULT 'running',
  `started_at`         DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `finished_at`        DATETIME        DEFAULT NULL,
  `records_processed`  INT             DEFAULT 0,
  `records_failed`     INT             DEFAULT 0,
  `error_message`      TEXT            DEFAULT NULL,
  `retry_count`        TINYINT         NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_run_id` (`run_id`),
  KEY `idx_batch_name_status` (`batch_name`, `status`)
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_unicode_ci
  COMMENT='GASバッチ / Cloud Run jobs 実行ログ';

-- -------------------------------------------------------------------
-- 18. append-only 権限設定（audit_log）
-- Cloud SQL Auth Proxy 接続ユーザー（例: welfare_app_user）から UPDATE/DELETE を剥奪
-- CMEK + KMS 鍵パス: projects/{p}/locations/asia-northeast1/keyRings/welfare/cryptoKeys/cloudsql-kek
-- -------------------------------------------------------------------
-- GRANT SELECT, INSERT ON welfare_db.audit_log TO 'welfare_app_user'@'%';
-- REVOKE UPDATE, DELETE ON welfare_db.audit_log FROM 'welfare_app_user'@'%';
-- ※ 上記 GRANT/REVOKE は Cloud SQL のユーザー管理で実施（gcloud sql users）

-- -------------------------------------------------------------------
-- EOF
-- スキーマ注記:
--   - CloudSQL for MySQL 8.x / Enterprise Edition
--   - リージョン: asia-northeast1（東京）
--   - インスタンス想定: db-custom-2-7680
--   - CMEK KEK: projects/{p}/locations/asia-northeast1/keyRings/welfare/cryptoKeys/cloudsql-kek
--   - recipient_cert_no は Cloud KMS API encrypt/decrypt で暗号化（AES_ENCRYPT廃止 — C-01）
--   - テーブル削除順（FK制約考慮）:
--     audit_log → batch_run_log → billing_prep → upper_limit_result_sheet → upper_limit_decision
--     → contract_mirror → service_records → shifts → user_allotment_cache
--     → staff_facility_map → user_mirror → staff → service_master → addition_master
--     → facility_id_map → upper_limit_facility → facilities
-- -------------------------------------------------------------------
