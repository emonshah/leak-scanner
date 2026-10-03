-- Full schema for leak-scanner.
-- ensureSchema() in mysql.ts creates tables idempotently on boot;
-- this file is the canonical reference + manual-init option.

CREATE TABLE IF NOT EXISTS users (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  email VARCHAR(320) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(16) NOT NULL DEFAULT 'user',
  display_name VARCHAR(60) NULL,
  avatar_updated_at TIMESTAMP NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_email (email(191))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS websites (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  url VARCHAR(2048) NOT NULL,
  normalized_url VARCHAR(2048) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  niche VARCHAR(32) NOT NULL DEFAULT 'general',
  primary_tech VARCHAR(64) NULL,
  contact_email VARCHAR(320) NULL,
  contact_name VARCHAR(255) NULL,
  business_name VARCHAR(255) NULL,
  city VARCHAR(128) NULL,
  country VARCHAR(64) NULL,
  notes VARCHAR(1000) NULL,
  email_status VARCHAR(16) NULL DEFAULT 'unknown',
  email_checked_at TIMESTAMP NULL,
  verified_email VARCHAR(320) NULL,
  email_evidence JSON NULL,
  email_reason VARCHAR(255) NULL,
  email_confidence VARCHAR(8) NULL,
  email_manual TINYINT(1) NOT NULL DEFAULT 0,
  research_brief TEXT NULL,
  research_at TIMESTAMP NULL,
  research_model VARCHAR(64) NULL,
  gmail_thread_id VARCHAR(150) NULL,
  sent_count INT NOT NULL DEFAULT 0,
  last_sent_at TIMESTAMP NULL,
  last_subject VARCHAR(255) NULL,
  draft_status VARCHAR(16) NOT NULL DEFAULT 'not_drafted',
  replied TINYINT(1) NOT NULL DEFAULT 0,
  replied_at TIMESTAMP NULL,
  do_not_email TINYINT(1) NOT NULL DEFAULT 0,
  parked_at TIMESTAMP NULL,
  lead_status VARCHAR(16) NOT NULL DEFAULT 'new',
  lead_status_at TIMESTAMP NULL,
  lead_status_note VARCHAR(500) NULL,
  user_id INT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_websites_user (user_id),
  UNIQUE KEY uq_websites_owner_url (user_id, normalized_url(512)),
  CONSTRAINT fk_websites_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS scans (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  website_id INT UNSIGNED NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  started_at TIMESTAMP NULL,
  completed_at TIMESTAMP NULL,
  error TEXT NULL,
  opportunity_score INT NULL,
  minor_issues_count INT NOT NULL DEFAULT 0,
  quality JSON NULL,
  progress_log JSON NULL,
  triage_brief TEXT NULL,
  triage_chosen JSON NULL,
  triage_at TIMESTAMP NULL,
  triage_model VARCHAR(64) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_scans_website (website_id),
  KEY idx_scans_status (status),
  KEY idx_scans_website_status (website_id, status),
  CONSTRAINT fk_scans_website FOREIGN KEY (website_id) REFERENCES websites(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS scan_logs (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  scan_id INT UNSIGNED NOT NULL,
  timestamp VARCHAR(32) NOT NULL,
  stage VARCHAR(32) NOT NULL,
  status VARCHAR(16) NOT NULL,
  message TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_logs_scan (scan_id),
  CONSTRAINT fk_logs_scan FOREIGN KEY (scan_id) REFERENCES scans(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS pages (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  scan_id INT UNSIGNED NOT NULL,
  url VARCHAR(2048) NOT NULL,
  normalized_url VARCHAR(2048) NOT NULL,
  status_code INT NULL,
  final_url VARCHAR(2048) NULL,
  response_time_ms INT NULL,
  is_homepage TINYINT(1) NOT NULL DEFAULT 0,
  title VARCHAR(512) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_pages_scan (scan_id),
  CONSTRAINT fk_pages_scan FOREIGN KEY (scan_id) REFERENCES scans(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS findings (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  scan_id INT UNSIGNED NOT NULL,
  website_id INT UNSIGNED NOT NULL,
  page_url VARCHAR(2048) NULL,
  module VARCHAR(64) NOT NULL,
  category VARCHAR(64) NOT NULL,
  severity VARCHAR(16) NOT NULL,
  title VARCHAR(255) NOT NULL,
  description TEXT NULL,
  measured_value VARCHAR(512) NULL,
  expected_value VARCHAR(512) NULL,
  evidence JSON NULL,
  business_category VARCHAR(64) NULL,
  conversion_impact VARCHAR(32) NULL,
  confidence VARCHAR(16) NULL,
  priority_score INT NULL,
  group_key VARCHAR(128) NULL,
  is_group_primary TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_findings_scan (scan_id),
  KEY idx_findings_severity (severity),
  KEY idx_findings_group (group_key),
  KEY idx_findings_scan_severity (scan_id, severity),
  CONSTRAINT fk_findings_scan FOREIGN KEY (scan_id) REFERENCES scans(id) ON DELETE CASCADE,
  CONSTRAINT fk_findings_website FOREIGN KEY (website_id) REFERENCES websites(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS security_checks (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  scan_id INT UNSIGNED NOT NULL,
  check_id VARCHAR(64) NOT NULL,
  title VARCHAR(255) NOT NULL,
  status VARCHAR(24) NOT NULL,
  observed VARCHAR(1024) NULL,
  expected VARCHAR(1024) NULL,
  risk VARCHAR(16) NOT NULL DEFAULT 'Info',
  recommendation VARCHAR(1024) NULL,
  evidence JSON NULL,
  owasp VARCHAR(16) NULL,
  automated VARCHAR(24) NOT NULL DEFAULT 'AUTOMATED',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_sec_scan (scan_id),
  CONSTRAINT fk_sec_scan FOREIGN KEY (scan_id) REFERENCES scans(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS ui_checks (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  scan_id INT UNSIGNED NOT NULL,
  viewport VARCHAR(16) NOT NULL,
  kind VARCHAR(32) NOT NULL,
  label VARCHAR(255) NOT NULL,
  dom_found TINYINT(1) NOT NULL DEFAULT 0,
  visible TINYINT(1) NOT NULL DEFAULT 0,
  box_json JSON NULL,
  hit_test VARCHAR(16) NULL,
  screenshot VARCHAR(512) NULL,
  verdict VARCHAR(24) NOT NULL,
  confidence VARCHAR(16) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_ui_scan (scan_id),
  CONSTRAINT fk_ui_scan FOREIGN KEY (scan_id) REFERENCES scans(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS technologies (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  scan_id INT UNSIGNED NOT NULL,
  category VARCHAR(64) NOT NULL,
  technology VARCHAR(128) NOT NULL,
  version VARCHAR(64) NULL,
  confidence VARCHAR(16) NOT NULL DEFAULT 'MEDIUM',
  evidence JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_tech_scan (scan_id),
  CONSTRAINT fk_tech_scan FOREIGN KEY (scan_id) REFERENCES scans(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS email_verifications (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  website_id INT UNSIGNED NOT NULL,
  email VARCHAR(320) NOT NULL,
  status VARCHAR(16) NOT NULL,
  confidence VARCHAR(16) NULL,
  reason VARCHAR(255) NULL,
  evidence JSON NULL,
  checked_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  manual TINYINT(1) NOT NULL DEFAULT 0,
  verified_email VARCHAR(320) NULL,
  PRIMARY KEY (id),
  KEY idx_ev_website (website_id),
  CONSTRAINT fk_ev_website FOREIGN KEY (website_id) REFERENCES websites(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS research_jobs (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  website_id INT UNSIGNED NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'processing',
  prompt TEXT NULL,
  result_json JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_rjobs_website (website_id),
  KEY idx_rjobs_status (status),
  CONSTRAINT fk_rjobs_website FOREIGN KEY (website_id) REFERENCES websites(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS outreach_campaigns (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id INT UNSIGNED NOT NULL,
  name VARCHAR(255) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'draft',
  template_json JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_campaigns_user (user_id),
  CONSTRAINT fk_campaigns_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS outreach_emails (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  campaign_id INT UNSIGNED NOT NULL,
  website_id INT UNSIGNED NULL,
  scan_id INT UNSIGNED NULL,
  to_email VARCHAR(320) NOT NULL,
  subject VARCHAR(500) NOT NULL,
  body TEXT NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'pending',
  sent_at TIMESTAMP NULL,
  opened_at TIMESTAMP NULL,
  replied_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_emails_campaign (campaign_id),
  KEY idx_emails_website (website_id),
  KEY idx_emails_scan (scan_id),
  CONSTRAINT fk_emails_campaign FOREIGN KEY (campaign_id) REFERENCES outreach_campaigns(id) ON DELETE CASCADE,
  CONSTRAINT fk_emails_website FOREIGN KEY (website_id) REFERENCES websites(id) ON DELETE SET NULL,
  CONSTRAINT fk_emails_scan FOREIGN KEY (scan_id) REFERENCES scans(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS activity_log (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id INT UNSIGNED NULL,
  category VARCHAR(16) NOT NULL,
  action VARCHAR(48) NOT NULL,
  detail JSON NULL,
  ip VARCHAR(64) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_activity_user (user_id),
  KEY idx_activity_time (created_at),
  KEY idx_activity_cat (category),
  CONSTRAINT fk_activity_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
