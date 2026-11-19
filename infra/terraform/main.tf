terraform {
  required_version = ">= 1.5.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 5.38.0, < 7.0.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

data "google_project" "current" {
  project_id = var.project_id
}

locals {
  audit_bucket_name = (
    trimspace(var.audit_logs_bucket_name) != ""
    ? trimspace(var.audit_logs_bucket_name)
    : "${var.project_id}-triad-audit-logs"
  )

  effective_audit_retention_days = coalesce(var.audit_retention_days, var.audit_logs_retention_days)
  effective_audit_lock_retention = var.audit_logs_lock_retention || var.lock_audit_bucket_retention

  resolved_image = (
    trimspace(var.container_image) != ""
    ? trimspace(var.container_image)
    : "${var.region}-docker.pkg.dev/${var.project_id}/${var.artifact_registry_repo}/${var.service_name}:${var.image_tag}"
  )

  has_notification_channel = (
    trimspace(var.alert_notification_email) != ""
    || length(var.alert_notification_channels) > 0
  )

  create_email_channel = (
    (
      var.enable_alert_policy
      || var.enable_5xx_alert
      || var.enable_latency_alert
      || var.enable_429_alert
      || var.enable_security_alert
      || (var.monthly_budget_amount > 0 && trimspace(var.billing_account_id) != "")
    )
    && trimspace(var.alert_notification_email) != ""
  )

  cloud_run_service_filter = "resource.type=\"cloud_run_revision\" AND resource.label.\"service_name\"=\"${var.service_name}\" AND resource.label.\"location\"=\"${var.region}\""

  resolved_notification_channels = concat(
    var.alert_notification_channels,
    google_monitoring_notification_channel.security_ops_email[*].name,
  )

  resolved_secret_rotation_topic = (
    trimspace(var.secret_rotation_topic) != ""
    ? trimspace(var.secret_rotation_topic)
    : (var.enable_secret_rotation ? google_pubsub_topic.triad_secret_rotation[0].id : "")
  )

  common_labels = {
    app         = "triad"
    compliance  = "nis2"
    managed_by  = "terraform"
    environment = "production"
  }

  required_apis = [
    "aiplatform.googleapis.com",
    "artifactregistry.googleapis.com",
    "billingbudgets.googleapis.com",
    "cloudkms.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "compute.googleapis.com",
    "dlp.googleapis.com",
    "iam.googleapis.com",
    "iap.googleapis.com",
    "logging.googleapis.com",
    "monitoring.googleapis.com",
    "pubsub.googleapis.com",
    "run.googleapis.com",
    "secretmanager.googleapis.com",
    "storage.googleapis.com",
  ]
}

# ==============================================================================
# 1. Activation des API Google Cloud requises
# ==============================================================================
resource "google_project_service" "required_apis" {
  for_each = toset(local.required_apis)

  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}

# ==============================================================================
# 2. Dépôt Artifact Registry Docker (optionnel)
# ==============================================================================
resource "google_artifact_registry_repository" "triad" {
  count = var.create_artifact_registry ? 1 : 0

  project       = var.project_id
  location      = var.region
  repository_id = var.artifact_registry_repo
  description   = "Images conteneurs de production TRIAD (Audit NIS2)"
  format        = "DOCKER"
  labels        = local.common_labels

  depends_on = [google_project_service.required_apis]
}

# ==============================================================================
# 3. Moindre privilège : Compte de service triad-auditor & Rôle métadonnées
#    Exclut strictement roles/viewer et roles/storage.objectViewer afin que
#    storage.objects.get retourne 403 Forbidden sur tous les buckets audités.
# ==============================================================================
resource "google_service_account" "triad_auditor" {
  project      = var.project_id
  account_id   = var.service_account_id
  display_name = "TRIAD Auditor — Lecture seule métadonnées (NIS2)"
  description  = "Identité Cloud Run à moindre privilège : métadonnées GCP uniquement, zéro lecture d'objets métier (storage.objects.get = 403)."

  depends_on = [google_project_service.required_apis]
}

resource "google_project_iam_custom_role" "triad_metadata_auditor" {
  project     = var.project_id
  role_id     = var.custom_role_id
  title       = "TRIAD Metadata Auditor (Zero Object Access)"
  description = "Inspection en lecture seule des métadonnées GCS, pare-feu Compute, clés KMS et rétention Cloud Logging. Exclut storage.objects.get et storage.objects.list."
  stage       = "GA"

  permissions = [
    "cloudkms.cryptoKeys.get",
    "cloudkms.cryptoKeys.list",
    "cloudkms.keyRings.list",
    "cloudkms.locations.list",
    "compute.firewalls.get",
    "compute.firewalls.list",
    "compute.networks.get",
    "compute.networks.list",
    "logging.buckets.get",
    "logging.buckets.list",
    "logging.sinks.get",
    "logging.sinks.list",
    "storage.buckets.get",
    "storage.buckets.getIamPolicy",
    "storage.buckets.list",
  ]

  depends_on = [google_project_service.required_apis]
}

# Rôle personnalisé métadonnées uniquement (aucun accès aux données des buckets)
resource "google_project_iam_member" "triad_metadata_role" {
  project = var.project_id
  role    = google_project_iam_custom_role.triad_metadata_auditor.name
  member  = "serviceAccount:${google_service_account.triad_auditor.email}"
}

# Métadonnées de hiérarchie projet uniquement (sans lecture d'objets ni secrets)
resource "google_project_iam_member" "triad_browser" {
  project = var.project_id
  role    = "roles/browser"
  member  = "serviceAccount:${google_service_account.triad_auditor.email}"
}

# Inspection des politiques IAM et des clés de comptes de service (NIS2 Art. 21)
resource "google_project_iam_member" "triad_security_reviewer" {
  project = var.project_id
  role    = "roles/iam.securityReviewer"
  member  = "serviceAccount:${google_service_account.triad_auditor.email}"
}

# Invocation des modèles Gemini sur Vertex AI par les 4 agents ADK
resource "google_project_iam_member" "triad_vertex_user" {
  project = var.project_id
  role    = "roles/aiplatform.user"
  member  = "serviceAccount:${google_service_account.triad_auditor.email}"
}

# Optionnel : masquage PII assisté par Google Cloud DLP
resource "google_project_iam_member" "triad_dlp_user" {
  count = var.enable_dlp_api ? 1 : 0

  project = var.project_id
  role    = "roles/dlp.user"
  member  = "serviceAccount:${google_service_account.triad_auditor.email}"
}

# ==============================================================================
# 4. Secret Manager souverain (europe-west9) pour clés & configurations sensibles
# ==============================================================================
resource "google_secret_manager_secret" "triad_app_config" {
  project   = var.project_id
  secret_id = var.secret_id
  labels    = local.common_labels

  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }

  depends_on = [google_project_service.required_apis]
}

# Accès en lecture restreint exclusivement à ce secret (aucun accès global projet)
resource "google_secret_manager_secret_iam_member" "triad_secret_accessor" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.triad_app_config.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.triad_auditor.email}"
}

resource "google_pubsub_topic" "triad_secret_rotation" {
  count = (var.enable_secret_rotation && trimspace(var.secret_rotation_topic) == "") ? 1 : 0

  name    = "${var.audit_signing_secret_id}-rotation"
  project = var.project_id
  labels  = local.common_labels

  message_storage_policy {
    allowed_persistence_regions = [var.region]
  }

  depends_on = [google_project_service.required_apis]
}

resource "google_pubsub_topic_iam_member" "triad_secret_rotation_publisher" {
  count = (var.enable_secret_rotation && trimspace(var.secret_rotation_topic) == "") ? 1 : 0

  project = var.project_id
  topic   = google_pubsub_topic.triad_secret_rotation[0].name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:service-${data.google_project.current.number}@gcp-sa-secretmanager.iam.gserviceaccount.com"
}

resource "google_secret_manager_secret" "triad_audit_signing_secret" {
  project   = var.project_id
  secret_id = var.audit_signing_secret_id
  labels    = local.common_labels

  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }

  dynamic "topics" {
    for_each = var.enable_secret_rotation ? [1] : []

    content {
      name = local.resolved_secret_rotation_topic
    }
  }

  dynamic "rotation" {
    for_each = var.enable_secret_rotation ? [1] : []

    content {
      next_rotation_time = var.secret_next_rotation_time
      rotation_period    = var.secret_rotation_period
    }
  }

  depends_on = [
    google_project_service.required_apis,
    google_pubsub_topic_iam_member.triad_secret_rotation_publisher,
  ]
}

# Accès en lecture restreint exclusivement au secret de signature HMAC-SHA256
resource "google_secret_manager_secret_iam_member" "triad_signing_secret_accessor" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.triad_audit_signing_secret.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.triad_auditor.email}"
}

# ==============================================================================
# 5. Bucket GCS dédié aux journaux d'audit immuables (SHA-256 / WORM)
# ==============================================================================
resource "google_storage_bucket" "audit_logs" {
  name                        = local.audit_bucket_name
  project                     = var.project_id
  location                    = var.region
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false
  labels                      = local.common_labels

  versioning {
    enabled = true
  }

  retention_policy {
    is_locked        = local.effective_audit_lock_retention
    retention_period = local.effective_audit_retention_days * 86400
  }

  lifecycle_rule {
    condition {
      age = var.audit_logs_coldline_age_days
    }

    action {
      type          = "SetStorageClass"
      storage_class = "COLDLINE"
    }
  }

  lifecycle_rule {
    condition {
      age = var.audit_logs_archive_age_days
    }

    action {
      type          = "SetStorageClass"
      storage_class = "ARCHIVE"
    }
  }

  depends_on = [google_project_service.required_apis]
}

# Écriture append-only limitée exclusivement au bucket d'audit dédié
resource "google_storage_bucket_iam_member" "audit_logs_append_only" {
  bucket = google_storage_bucket.audit_logs.name
  role   = "roles/storage.objectCreator"
  member = "serviceAccount:${google_service_account.triad_auditor.email}"
}

# ==============================================================================
# 6. Service Cloud Run v2 (europe-west9)
# ==============================================================================
resource "google_cloud_run_v2_service" "triad" {
  name                = var.service_name
  location            = var.region
  project             = var.project_id
  description         = "TRIAD — Plateforme d'audit cyber contradictoire NIS2 (Dit / Écrit / Réel)"
  ingress             = var.ingress_settings
  deletion_protection = var.deletion_protection
  labels              = local.common_labels

  template {
    service_account                  = google_service_account.triad_auditor.email
    timeout                          = "300s"
    max_instance_request_concurrency = var.concurrency

    scaling {
      min_instance_count = var.min_instances
      max_instance_count = var.max_instances
    }

    dynamic "vpc_access" {
      for_each = var.enable_vpc_egress ? [1] : []

      content {
        egress = var.vpc_egress_setting

        network_interfaces {
          network    = var.vpc_network
          subnetwork = trimspace(var.vpc_subnetwork) != "" ? trimspace(var.vpc_subnetwork) : null
          tags       = var.vpc_network_tags
        }
      }
    }

    containers {
      name  = "triad"
      image = local.resolved_image

      ports {
        name           = "http1"
        container_port = 8080
      }

      resources {
        limits = {
          cpu    = var.cpu_limit
          memory = var.memory_limit
        }

        cpu_idle          = true
        startup_cpu_boost = var.enable_startup_cpu_boost
      }

      env {
        name  = "PROJECT_ID"
        value = var.project_id
      }

      env {
        name  = "VERTEX_LOCATION"
        value = var.vertex_location
      }

      env {
        name  = "GEMINI_MODEL"
        value = var.gemini_model
      }

      env {
        name  = "USE_GCP_SNAPSHOT"
        value = tostring(var.use_gcp_snapshot)
      }

      env {
        name  = "USE_DEMO_CACHE"
        value = tostring(var.use_demo_cache)
      }

      env {
        name  = "USE_DLP_API"
        value = tostring(var.enable_dlp_api)
      }

      env {
        name  = "AUDIT_LOGS_BUCKET"
        value = google_storage_bucket.audit_logs.name
      }

      env {
        name  = "RATE_LIMIT_MAX_REQUESTS"
        value = tostring(var.rate_limit_max_requests)
      }

      env {
        name  = "RATE_LIMIT_WINDOW_SECONDS"
        value = tostring(var.rate_limit_window_seconds)
      }

      env {
        name  = "SESSION_TTL_HOURS"
        value = tostring(var.session_ttl_hours)
      }

      env {
        name  = "LOG_FORMAT"
        value = var.log_format
      }

      dynamic "env" {
        for_each = var.mount_secret_env ? [1] : []

        content {
          name = "TRIAD_SENSITIVE_CONFIG"

          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.triad_app_config.secret_id
              version = var.secret_version
            }
          }
        }
      }

      dynamic "env" {
        for_each = var.mount_audit_signing_secret ? [1] : []

        content {
          name = "AUDIT_SIGNING_SECRET"

          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.triad_audit_signing_secret.secret_id
              version = var.audit_signing_secret_version
            }
          }
        }
      }

      # Sonde de démarrage profond (/api/health/ready : 3 référentiels JSON, dist/ UI et /app/logs inscriptible)
      startup_probe {
        initial_delay_seconds = 1
        timeout_seconds       = 2
        period_seconds        = 3
        failure_threshold     = 10

        http_get {
          path = "/api/health/ready"
          port = 8080
        }
      }

      # Sonde de vivacité continue vérifiant la réactivité de la boucle Uvicorn
      liveness_probe {
        initial_delay_seconds = 15
        timeout_seconds       = 3
        period_seconds        = 30
        failure_threshold     = 3

        http_get {
          path = "/api/health"
          port = 8080
        }
      }
    }
  }

  traffic {
    type    = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
    percent = 100
  }

  depends_on = [
    google_project_service.required_apis,
    google_project_iam_member.triad_metadata_role,
    google_project_iam_member.triad_vertex_user,
    google_secret_manager_secret_iam_member.triad_secret_accessor,
    google_secret_manager_secret_iam_member.triad_signing_secret_accessor,
    google_storage_bucket_iam_member.audit_logs_append_only,
  ]
}

# ==============================================================================
# 7. Contrôle d'accès Cloud Run : IAM / IAP (défaut) ou Démo publique
# ==============================================================================
resource "google_cloud_run_v2_service_iam_member" "public_invoker" {
  count = var.allow_unauthenticated ? 1 : 0

  project  = google_cloud_run_v2_service.triad.project
  location = google_cloud_run_v2_service.triad.location
  name     = google_cloud_run_v2_service.triad.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

resource "google_cloud_run_v2_service_iam_member" "authorized_invokers" {
  for_each = var.allow_unauthenticated ? toset([]) : toset(var.authorized_invokers)

  project  = google_cloud_run_v2_service.triad.project
  location = google_cloud_run_v2_service.triad.location
  name     = google_cloud_run_v2_service.triad.name
  role     = "roles/run.invoker"
  member   = each.value
}

resource "google_cloud_run_v2_service_iam_member" "iap_service_agent" {
  count = (!var.allow_unauthenticated && var.enable_iap_invoker) ? 1 : 0

  project  = google_cloud_run_v2_service.triad.project
  location = google_cloud_run_v2_service.triad.location
  name     = google_cloud_run_v2_service.triad.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:service-${data.google_project.current.number}@gcp-sa-iap.iam.gserviceaccount.com"
}

# ==============================================================================
# 8. Durcissement périmétrique : Politique WAF Google Cloud Armor (optionnelle)
# ==============================================================================
resource "google_compute_security_policy" "triad_waf" {
  count = (var.enable_cloud_armor || var.enable_eu_geofencing) ? 1 : 0

  name        = "${var.service_name}-waf-policy"
  project     = var.project_id
  description = "Politique WAF Cloud Armor (OWASP CRS, géo-filtrage UE optionnel, anti-DDoS et limitation de débit) pour TRIAD"

  adaptive_protection_config {
    layer_7_ddos_defense_config {
      enable = true
    }
  }

  dynamic "rule" {
    for_each = var.enable_eu_geofencing ? [1] : []

    content {
      action      = "deny(403)"
      priority    = 900
      description = "Géo-filtrage souverain UE : blocage HTTP 403 du trafic hors codes pays autorisés"

      match {
        expr {
          expression = "!(origin.region_code in [${join(", ", formatlist("'%s'", var.allowed_eu_country_codes))}])"
        }
      }
    }
  }

  rule {
    action      = "throttle"
    priority    = 1000
    description = "Limitation de débit par IP cliente (protection anti-abus API)"

    match {
      versioned_expr = "SRC_IPS_V1"

      config {
        src_ip_ranges = ["*"]
      }
    }

    rate_limit_options {
      conform_action = "allow"
      exceed_action  = "deny(429)"
      enforce_on_key = "IP"

      rate_limit_threshold {
        count        = var.cloud_armor_rate_limit_rpm
        interval_sec = 60
      }
    }
  }

  rule {
    action      = "deny(403)"
    priority    = 2000
    description = "Blocage OWASP CRS : injections SQL (sqli) et Cross-Site Scripting (xss)"

    match {
      expr {
        expression = "evaluatePreconfiguredWaf('sqli-v33-stable') || evaluatePreconfiguredWaf('xss-v33-stable')"
      }
    }
  }

  rule {
    action      = "deny(403)"
    priority    = 2100
    description = "Blocage OWASP CRS : LFI, RFI, exécution de commandes à distance (RCE) et scanners"

    match {
      expr {
        expression = "evaluatePreconfiguredWaf('lfi-v33-stable') || evaluatePreconfiguredWaf('rfi-v33-stable') || evaluatePreconfiguredWaf('rce-v33-stable') || evaluatePreconfiguredWaf('scannerdetection-v33-stable')"
      }
    }
  }

  rule {
    action      = "allow"
    priority    = 2147483647
    description = "Règle par défaut Cloud Armor : autoriser le trafic légitime filtré"

    match {
      versioned_expr = "SRC_IPS_V1"

      config {
        src_ip_ranges = ["*"]
      }
    }
  }

  depends_on = [google_project_service.required_apis]
}

# ==============================================================================
# 9. Observabilité Cloud Monitoring (/api/health) & Alerte Budget FinOps
# ==============================================================================
resource "google_monitoring_uptime_check_config" "triad_health" {
  count = var.enable_uptime_check ? 1 : 0

  project      = var.project_id
  display_name = "${var.service_name} — Cloud Run /api/health"
  timeout      = "10s"
  period       = "60s"

  http_check {
    path           = "/api/health"
    port           = 443
    use_ssl        = true
    validate_ssl   = true
    request_method = "GET"

    accepted_response_status_codes {
      status_class = "STATUS_CLASS_2XX"
    }
  }

  monitored_resource {
    type = "uptime_url"

    labels = {
      project_id = var.project_id
      host       = replace(replace(google_cloud_run_v2_service.triad.uri, "https://", ""), "/", "")
    }
  }

  content_matchers {
    content = "\"ok\""
    matcher = "CONTAINS_STRING"
  }

  depends_on = [google_project_service.required_apis]
}

resource "google_monitoring_notification_channel" "security_ops_email" {
  count = local.create_email_channel ? 1 : 0

  project      = var.project_id
  display_name = "TRIAD Cyber Ops — Alertes Disponibilité & FinOps"
  type         = "email"

  labels = {
    email_address = trimspace(var.alert_notification_email)
  }

  depends_on = [google_project_service.required_apis]
}

resource "google_monitoring_alert_policy" "triad_uptime_alert" {
  count = (var.enable_uptime_check && var.enable_alert_policy) ? 1 : 0

  project               = var.project_id
  display_name          = "${var.service_name} — Indisponibilité /api/health"
  combiner              = "OR"
  enabled               = true
  notification_channels = local.resolved_notification_channels

  conditions {
    display_name = "Échec Uptime Check HTTPS /api/health (> 2 min)"

    condition_threshold {
      filter          = "metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\" AND resource.type=\"uptime_url\" AND metric.label.\"check_id\"=\"${google_monitoring_uptime_check_config.triad_health[0].uptime_check_id}\""
      duration        = "120s"
      comparison      = "COMPARISON_GT"
      threshold_value = 1

      trigger {
        count = 1
      }

      aggregations {
        alignment_period     = "60s"
        per_series_aligner   = "ALIGN_NEXT_OLDER"
        cross_series_reducer = "REDUCE_COUNT_FALSE"

        group_by_fields = [
          "resource.label.project_id",
          "resource.label.host",
        ]
      }
    }
  }

  alert_strategy {
    auto_close = "1800s"
  }

  documentation {
    content   = "Le point de terminaison `/api/health` du service Cloud Run TRIAD (`${var.region}`) ne répond plus. Vérifiez les journaux Cloud Run et l'état du pipeline ADK."
    mime_type = "text/markdown"
  }

  depends_on = [google_project_service.required_apis]
}

resource "google_monitoring_alert_policy" "triad_cloud_run_5xx" {
  count = (var.enable_5xx_alert && local.has_notification_channel) ? 1 : 0

  project               = var.project_id
  display_name          = "${var.service_name} — Erreurs HTTP 5xx Cloud Run"
  combiner              = "OR"
  enabled               = true
  notification_channels = local.resolved_notification_channels

  conditions {
    display_name = "Taux d'erreurs HTTP 5xx Cloud Run supérieur au seuil (fenêtre 5 min)"

    condition_threshold {
      filter          = "metric.type=\"run.googleapis.com/request_count\" AND resource.type=\"cloud_run_revision\" AND resource.label.\"service_name\"=\"${google_cloud_run_v2_service.triad.name}\" AND metric.label.\"response_code_class\"=\"5xx\""
      duration        = "60s"
      comparison      = "COMPARISON_GT"
      threshold_value = var.cloud_run_5xx_threshold

      trigger {
        count = 1
      }

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"

        group_by_fields = [
          "resource.label.service_name",
          "resource.label.location",
        ]
      }
    }
  }

  alert_strategy {
    auto_close = "1800s"
  }

  documentation {
    content   = "Des réponses `HTTP 5xx` anormales ont été détectées sur le service Cloud Run TRIAD (`${var.service_name}`, région `${var.region}`). Inspectez Cloud Logging et les quotas Vertex AI."
    mime_type = "text/markdown"
  }

  depends_on = [google_project_service.required_apis]
}

resource "google_monitoring_alert_policy" "triad_cloud_run_latency_p95" {
  count = (var.enable_latency_alert && local.has_notification_channel) ? 1 : 0

  project               = var.project_id
  display_name          = "${var.service_name} — Dégradation Latence P95 Cloud Run"
  combiner              = "OR"
  enabled               = true
  notification_channels = local.resolved_notification_channels

  conditions {
    display_name = "Latence HTTP P95 Cloud Run supérieure à ${var.cloud_run_p95_latency_ms} ms"

    condition_threshold {
      filter          = "metric.type=\"run.googleapis.com/request_latencies\" AND resource.type=\"cloud_run_revision\" AND resource.label.\"service_name\"=\"${google_cloud_run_v2_service.triad.name}\""
      duration        = "120s"
      comparison      = "COMPARISON_GT"
      threshold_value = var.cloud_run_p95_latency_ms

      trigger {
        count = 1
      }

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_DELTA"
        cross_series_reducer = "REDUCE_PERCENTILE_95"

        group_by_fields = [
          "resource.label.service_name",
          "resource.label.location",
        ]
      }
    }
  }

  alert_strategy {
    auto_close = "1800s"
  }

  documentation {
    content   = "La latence P95 du service Cloud Run TRIAD (`${var.service_name}`, `${var.region}`) dépasse `${var.cloud_run_p95_latency_ms} ms`. Vérifiez les temps de réponse Vertex AI Gemini et le dimensionnement CPU/concurrence."
    mime_type = "text/markdown"
  }

  depends_on = [google_project_service.required_apis]
}

resource "google_monitoring_alert_policy" "triad_cloud_run_rate_limit_429" {
  count = (var.enable_429_alert && local.has_notification_channel) ? 1 : 0

  project               = var.project_id
  display_name          = "${var.service_name} — Pic de Limitation de Débit HTTP 429"
  combiner              = "OR"
  enabled               = true
  notification_channels = local.resolved_notification_channels

  conditions {
    display_name = "Pic de réponses HTTP 429 supérieur à ${var.cloud_run_429_threshold} (fenêtre 300s)"

    condition_threshold {
      filter          = "metric.type=\"run.googleapis.com/request_count\" AND resource.type=\"cloud_run_revision\" AND resource.label.\"service_name\"=\"${google_cloud_run_v2_service.triad.name}\" AND metric.label.\"response_code\"=\"429\""
      duration        = "60s"
      comparison      = "COMPARISON_GT"
      threshold_value = var.cloud_run_429_threshold

      trigger {
        count = 1
      }

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"

        group_by_fields = [
          "resource.label.service_name",
          "resource.label.location",
        ]
      }
    }
  }

  alert_strategy {
    auto_close = "1800s"
  }

  documentation {
    content   = "Un pic de réponses `HTTP 429 Too Many Requests` (> `${var.cloud_run_429_threshold}` sur `300s`) a été détecté sur Cloud Run TRIAD (`${var.service_name}`, `${var.region}`). Vérifiez `/api/metrics`, les journaux d'accès et les règles WAF Cloud Armor."
    mime_type = "text/markdown"
  }

  depends_on = [google_project_service.required_apis]
}

resource "google_logging_metric" "triad_security_violations" {
  project     = var.project_id
  name        = "${var.service_name}_security_violations_blocked"
  description = "Compteur Cloud Logging des actions non autorisées bloquées par le Garde du Corps ADK (SECURITY_VIOLATION_BLOCKED)"
  filter      = "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${var.service_name}\" AND resource.labels.location=\"${var.region}\" AND jsonPayload.event_type=\"SECURITY_VIOLATION_BLOCKED\""

  metric_descriptor {
    metric_kind  = "DELTA"
    value_type   = "INT64"
    unit         = "1"
    display_name = "${var.service_name} — Violations Sécurité ADK Bloquées"
  }

  depends_on = [google_project_service.required_apis]
}

resource "google_monitoring_alert_policy" "triad_security_violation_alert" {
  count = (var.enable_security_alert && local.has_notification_channel) ? 1 : 0

  project               = var.project_id
  display_name          = "${var.service_name} — Violation Sécurité ADK Bloquée (SECURITY_VIOLATION_BLOCKED)"
  combiner              = "OR"
  enabled               = true
  notification_channels = local.resolved_notification_channels

  conditions {
    display_name = "Tentative d'action non autorisée bloquée (SECURITY_VIOLATION_BLOCKED > 0)"

    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.triad_security_violations.name}\" AND resource.type=\"cloud_run_revision\" AND resource.label.\"service_name\"=\"${google_cloud_run_v2_service.triad.name}\""
      duration        = "0s"
      comparison      = "COMPARISON_GT"
      threshold_value = 0

      trigger {
        count = 1
      }

      aggregations {
        alignment_period     = "60s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"

        group_by_fields = [
          "resource.label.service_name",
          "resource.label.location",
        ]
      }
    }
  }

  alert_strategy {
    auto_close = "1800s"
  }

  documentation {
    content   = "Au moins une tentative d'action non autorisée (`SECURITY_VIOLATION_BLOCKED` > `0`) a été interceptée par le Garde du Corps ADK sur Cloud Run TRIAD (`${var.service_name}`, `${var.region}`). Inspectez immédiatement Cloud Logging (`jsonPayload.event_type=\"SECURITY_VIOLATION_BLOCKED\"`) et le journal d'audit SHA-256."
    mime_type = "text/markdown"
  }

  depends_on = [
    google_logging_metric.triad_security_violations,
    google_project_service.required_apis,
  ]
}

resource "google_monitoring_dashboard" "triad_executive_ops" {
  count = var.enable_monitoring_dashboard ? 1 : 0

  project = var.project_id

  dashboard_json = jsonencode({
    displayName = "TRIAD (${var.service_name}) — Observabilité Cloud Run (${var.region})"

    mosaicLayout = {
      columns = 12

      tiles = [
        {
          xPos   = 0
          yPos   = 0
          width  = 6
          height = 4

          widget = {
            title = "Débit HTTP Cloud Run (Requêtes / s)"

            xyChart = {
              dataSets = [
                {
                  plotType = "LINE"

                  timeSeriesQuery = {
                    timeSeriesFilter = {
                      filter = "metric.type=\"run.googleapis.com/request_count\" AND ${local.cloud_run_service_filter}"

                      aggregation = {
                        alignmentPeriod    = "60s"
                        perSeriesAligner   = "ALIGN_RATE"
                        crossSeriesReducer = "REDUCE_SUM"

                        groupByFields = [
                          "resource.label.service_name",
                        ]
                      }
                    }
                  }
                },
              ]
            }
          }
        },
        {
          xPos   = 6
          yPos   = 0
          width  = 6
          height = 4

          widget = {
            title = "Répartition par Classe de Code HTTP (2xx / 4xx / 5xx)"

            xyChart = {
              dataSets = [
                {
                  plotType = "STACKED_BAR"

                  timeSeriesQuery = {
                    timeSeriesFilter = {
                      filter = "metric.type=\"run.googleapis.com/request_count\" AND ${local.cloud_run_service_filter}"

                      aggregation = {
                        alignmentPeriod    = "60s"
                        perSeriesAligner   = "ALIGN_SUM"
                        crossSeriesReducer = "REDUCE_SUM"

                        groupByFields = [
                          "metric.label.response_code_class",
                        ]
                      }
                    }
                  }
                },
              ]
            }
          }
        },
        {
          xPos   = 0
          yPos   = 4
          width  = 12
          height = 4

          widget = {
            title = "Latence HTTP Cloud Run — P50 & P95 (ms)"

            xyChart = {
              thresholds = [
                {
                  label = "Seuil Alerte P95"
                  value = var.cloud_run_p95_latency_ms
                },
              ]

              dataSets = [
                {
                  plotType       = "LINE"
                  legendTemplate = "Latence Médiane P50"

                  timeSeriesQuery = {
                    timeSeriesFilter = {
                      filter = "metric.type=\"run.googleapis.com/request_latencies\" AND ${local.cloud_run_service_filter}"

                      aggregation = {
                        alignmentPeriod    = "60s"
                        perSeriesAligner   = "ALIGN_DELTA"
                        crossSeriesReducer = "REDUCE_PERCENTILE_50"

                        groupByFields = [
                          "resource.label.service_name",
                        ]
                      }
                    }
                  }
                },
                {
                  plotType       = "LINE"
                  legendTemplate = "Latence Critique P95"

                  timeSeriesQuery = {
                    timeSeriesFilter = {
                      filter = "metric.type=\"run.googleapis.com/request_latencies\" AND ${local.cloud_run_service_filter}"

                      aggregation = {
                        alignmentPeriod    = "60s"
                        perSeriesAligner   = "ALIGN_DELTA"
                        crossSeriesReducer = "REDUCE_PERCENTILE_95"

                        groupByFields = [
                          "resource.label.service_name",
                        ]
                      }
                    }
                  }
                },
              ]
            }
          }
        },
        {
          xPos   = 0
          yPos   = 8
          width  = 6
          height = 4

          widget = {
            title = "Utilisation CPU Conteneur (P95)"

            xyChart = {
              dataSets = [
                {
                  plotType = "LINE"

                  timeSeriesQuery = {
                    timeSeriesFilter = {
                      filter = "metric.type=\"run.googleapis.com/container/cpu/utilizations\" AND ${local.cloud_run_service_filter}"

                      aggregation = {
                        alignmentPeriod    = "60s"
                        perSeriesAligner   = "ALIGN_DELTA"
                        crossSeriesReducer = "REDUCE_PERCENTILE_95"

                        groupByFields = [
                          "resource.label.service_name",
                        ]
                      }
                    }
                  }
                },
              ]
            }
          }
        },
        {
          xPos   = 6
          yPos   = 8
          width  = 6
          height = 4

          widget = {
            title = "Utilisation Mémoire Conteneur (P95)"

            xyChart = {
              dataSets = [
                {
                  plotType = "LINE"

                  timeSeriesQuery = {
                    timeSeriesFilter = {
                      filter = "metric.type=\"run.googleapis.com/container/memory/utilizations\" AND ${local.cloud_run_service_filter}"

                      aggregation = {
                        alignmentPeriod    = "60s"
                        perSeriesAligner   = "ALIGN_DELTA"
                        crossSeriesReducer = "REDUCE_PERCENTILE_95"

                        groupByFields = [
                          "resource.label.service_name",
                        ]
                      }
                    }
                  }
                },
              ]
            }
          }
        },
      ]
    }
  })

  depends_on = [
    google_cloud_run_v2_service.triad,
    google_project_service.required_apis,
  ]
}

resource "google_billing_budget" "triad_monthly_budget" {
  count = (var.monthly_budget_amount > 0 && trimspace(var.billing_account_id) != "") ? 1 : 0

  billing_account = trimspace(var.billing_account_id)
  display_name    = "${var.service_name} — Budget Mensuel Cloud Run & Vertex AI"

  budget_filter {
    calendar_period = "MONTH"

    projects = [
      "projects/${data.google_project.current.number}",
    ]
  }

  amount {
    specified_amount {
      currency_code = var.budget_currency
      units         = tostring(floor(var.monthly_budget_amount))
    }
  }

  threshold_rules {
    threshold_percent = 0.5
    spend_basis       = "CURRENT_SPEND"
  }

  threshold_rules {
    threshold_percent = 0.8
    spend_basis       = "CURRENT_SPEND"
  }

  threshold_rules {
    threshold_percent = 1.0
    spend_basis       = "CURRENT_SPEND"
  }

  threshold_rules {
    threshold_percent = 1.0
    spend_basis       = "FORECASTED_SPEND"
  }

  dynamic "all_updates_rule" {
    for_each = length(local.resolved_notification_channels) > 0 ? [1] : []

    content {
      monitoring_notification_channels = local.resolved_notification_channels
      disable_default_iam_recipients   = false
    }
  }

  depends_on = [google_project_service.required_apis]
}

# ==============================================================================
# 10. Garde-fous de Souveraineté GCP (Organization Policies optionnelles)
#     Désactivés par défaut (enable_org_policies = false) pour compatibilité
#     avec les projets ne disposant pas de roles/orgpolicy.policyAdmin.
# ==============================================================================
resource "google_project_organization_policy" "sovereign_resource_locations" {
  count = var.enable_org_policies ? 1 : 0

  project    = var.project_id
  constraint = "constraints/gcp.resourceLocations"

  list_policy {
    allow {
      values = var.allowed_resource_locations
    }
  }

  depends_on = [google_project_service.required_apis]
}

resource "google_project_organization_policy" "disable_sa_key_creation" {
  count = var.enable_org_policies ? 1 : 0

  project    = var.project_id
  constraint = "constraints/iam.disableServiceAccountKeyCreation"

  boolean_policy {
    enforced = true
  }

  depends_on = [google_project_service.required_apis]
}
