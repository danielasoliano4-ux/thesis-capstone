CREATE DATABASE IF NOT EXISTS antirabies_locator
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE antirabies_locator;

CREATE TABLE users (
    user_id       INT UNSIGNED    NOT NULL AUTO_INCREMENT,
    email         VARCHAR(150)    NOT NULL,
    password_hash VARCHAR(255)    NOT NULL,
    role          ENUM('resident','clinic_staff','admin') NOT NULL,
    is_active     TINYINT(1)      NOT NULL DEFAULT 1,
    created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP
                                           ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id),
    UNIQUE KEY uq_users_email (email)
) ENGINE=InnoDB;

CREATE TABLE residents (
    resident_id  INT UNSIGNED  NOT NULL AUTO_INCREMENT,
    user_id      INT UNSIGNED  NOT NULL,
    first_name   VARCHAR(80)   NOT NULL,
    last_name    VARCHAR(80)   NOT NULL,
    middle_name  VARCHAR(80)       NULL,
    birthdate    DATE          NOT NULL,
    sex          ENUM('male','female','prefer_not_to_say') NOT NULL,
    address      VARCHAR(255)  NOT NULL,
    barangay     VARCHAR(100)  NOT NULL,
    phone        VARCHAR(20)       NULL,
    created_at   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP
                                        ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (resident_id),
    UNIQUE KEY uq_residents_user (user_id),
    CONSTRAINT fk_residents_user
        FOREIGN KEY (user_id) REFERENCES users (user_id)
        ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB;

CREATE TABLE clinics (
    clinic_id        INT UNSIGNED     NOT NULL AUTO_INCREMENT,
    name             VARCHAR(150)     NOT NULL,
    address          VARCHAR(255)     NOT NULL,
    barangay         VARCHAR(100)     NOT NULL,
    city             VARCHAR(100)     NOT NULL DEFAULT 'Cabuyao',
    province         VARCHAR(100)     NOT NULL DEFAULT 'Laguna',
    contact_number   VARCHAR(30)          NULL,
    email            VARCHAR(150)         NULL,
    latitude         DECIMAL(10, 8)       NULL,
    longitude        DECIMAL(11, 8)       NULL,
    operating_hours  VARCHAR(255)         NULL,
    is_active        TINYINT(1)       NOT NULL DEFAULT 1,
    created_at       DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at       DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP
                                               ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (clinic_id)
) ENGINE=InnoDB;

CREATE TABLE clinic_staff (
    staff_id    INT UNSIGNED  NOT NULL AUTO_INCREMENT,
    user_id     INT UNSIGNED  NOT NULL,
    clinic_id   INT UNSIGNED  NOT NULL,
    first_name  VARCHAR(80)   NOT NULL,
    last_name   VARCHAR(80)   NOT NULL,
    middle_name VARCHAR(80)       NULL,
    position    VARCHAR(100)      NULL,
    phone       VARCHAR(20)       NULL,
    created_at  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP
                                       ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (staff_id),
    UNIQUE KEY uq_staff_user (user_id),
    CONSTRAINT fk_staff_user
        FOREIGN KEY (user_id)   REFERENCES users   (user_id)
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT fk_staff_clinic
        FOREIGN KEY (clinic_id) REFERENCES clinics (clinic_id)
        ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB;

CREATE TABLE vaccines (
    vaccine_id       INT UNSIGNED  NOT NULL AUTO_INCREMENT,
    clinic_id        INT UNSIGNED  NOT NULL,
    vaccine_name     VARCHAR(150)  NOT NULL,
    brand            VARCHAR(100)      NULL,
    dose_schedule    VARCHAR(100)      NULL,
    available_stock  INT UNSIGNED  NOT NULL DEFAULT 0,
    unit             VARCHAR(30)   NOT NULL DEFAULT 'vial',
    last_updated_by  INT UNSIGNED      NULL,
    last_updated_at  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP
                                            ON UPDATE CURRENT_TIMESTAMP,
    created_at       DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (vaccine_id),
    CONSTRAINT fk_vaccines_clinic
        FOREIGN KEY (clinic_id)       REFERENCES clinics (clinic_id)
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT fk_vaccines_updater
        FOREIGN KEY (last_updated_by) REFERENCES users (user_id)
        ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB;

CREATE TABLE appointments (
    appointment_id   INT UNSIGNED      NOT NULL AUTO_INCREMENT,
    resident_id      INT UNSIGNED      NOT NULL,
    clinic_id        INT UNSIGNED      NOT NULL,
    vaccine_id       INT UNSIGNED      NOT NULL,
    scheduled_date   DATE              NOT NULL,
    scheduled_time   TIME                  NULL,
    dose_number      TINYINT UNSIGNED  NOT NULL DEFAULT 1,
    status           ENUM('pending','confirmed','completed','cancelled','no_show')
                                       NOT NULL DEFAULT 'pending',
    notes            TEXT                  NULL,
    created_at       DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at       DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP
                                                ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (appointment_id),
    CONSTRAINT fk_appt_resident
        FOREIGN KEY (resident_id) REFERENCES residents (resident_id)
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT fk_appt_clinic
        FOREIGN KEY (clinic_id)   REFERENCES clinics   (clinic_id)
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT fk_appt_vaccine
        FOREIGN KEY (vaccine_id)  REFERENCES vaccines  (vaccine_id)
        ON DELETE RESTRICT ON UPDATE CASCADE,
    INDEX idx_appt_scheduled_date (scheduled_date),
    INDEX idx_appt_status         (status)
) ENGINE=InnoDB;

CREATE TABLE notifications (
    notification_id  INT UNSIGNED  NOT NULL AUTO_INCREMENT,
    user_id          INT UNSIGNED  NOT NULL,
    title            VARCHAR(150)  NOT NULL,
    message          TEXT          NOT NULL,
    type             ENUM('appointment_reminder','stock_update',
                          'appointment_confirmed','appointment_cancelled',
                          'general') NOT NULL DEFAULT 'general',
    is_read          TINYINT(1)    NOT NULL DEFAULT 0,
    sent_at          DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (notification_id),
    CONSTRAINT fk_notif_user
        FOREIGN KEY (user_id) REFERENCES users (user_id)
        ON DELETE CASCADE ON UPDATE CASCADE,
    INDEX idx_notif_user_read (user_id, is_read)
) ENGINE=InnoDB;

CREATE TABLE activity_logs (
    log_id       BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
    user_id      INT UNSIGNED         NULL,
    action       VARCHAR(100)     NOT NULL,
    entity_type  VARCHAR(50)          NULL,
    entity_id    INT UNSIGNED         NULL,
    description  TEXT                 NULL,
    ip_address   VARCHAR(45)          NULL,
    created_at   DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (log_id),
    CONSTRAINT fk_log_user
        FOREIGN KEY (user_id) REFERENCES users (user_id)
        ON DELETE SET NULL ON UPDATE CASCADE,
    INDEX idx_log_user       (user_id),
    INDEX idx_log_entity     (entity_type, entity_id),
    INDEX idx_log_created_at (created_at)
) ENGINE=InnoDB;

CREATE TABLE vaccine_stock_history (
    history_id     BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
    vaccine_id     INT UNSIGNED     NOT NULL,
    changed_by     INT UNSIGNED         NULL,
    change_amount  INT              NOT NULL,
    stock_after    INT UNSIGNED     NOT NULL,
    reason         VARCHAR(255)         NULL,
    changed_at     DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (history_id),
    CONSTRAINT fk_stockhist_vaccine
        FOREIGN KEY (vaccine_id) REFERENCES vaccines (vaccine_id)
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT fk_stockhist_user
        FOREIGN KEY (changed_by) REFERENCES users (user_id)
        ON DELETE SET NULL ON UPDATE CASCADE,
    INDEX idx_stockhist_vaccine (vaccine_id),
    INDEX idx_stockhist_date    (changed_at)
) ENGINE=InnoDB;