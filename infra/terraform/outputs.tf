output "cloud_run_service_url" {
  description = "URL HTTPS du service Cloud Run v2 TRIAD déployé."
  value       = google_cloud_run_v2_service.triad.uri
}

output "cloud_run_service_name" {
  description = "Nom de la ressource Cloud Run v2."
  value       = google_cloud_run_v2_service.triad.name
}

output "cloud_run_startup_cpu_boost_enabled" {
  description = "État d'activation de l'accélération CPU au démarrage à froid (startup_cpu_boost) sur Cloud Run v2."
  value       = var.enable_startup_cpu_boost
}

output "cloud_run_direct_vpc_egress" {
  description = "État et mode de routage Direct VPC Egress du service Cloud Run v2."

  value = {
    enabled        = var.enable_vpc_egress
    egress_setting = var.enable_vpc_egress ? var.vpc_egress_setting : null
    network        = var.enable_vpc_egress ? var.vpc_network : null
  }
}

output "auditor_service_account_email" {
  description = "Adresse e-mail du compte de service à moindre privilège attaché à Cloud Run."
  value       = google_service_account.triad_auditor.email
}

output "custom_metadata_role_name" {
  description = "Identifiant complet du rôle IAM personnalisé lecture seule métadonnées (403 sur storage.objects.get)."
  value       = google_project_iam_custom_role.triad_metadata_auditor.name
}

output "audit_logs_bucket_url" {
  description = "URI gs:// du bucket GCS immuable dédié aux journaux d'audit SHA-256."
  value       = google_storage_bucket.audit_logs.url
}

output "audit_logs_retention_policy" {
  description = "Politique WORM et cycle de vie PSSI §6.1 (COLDLINE 90j / ARCHIVE 365j) du bucket GCS d'audit."

  value = {
    bucket_name         = google_storage_bucket.audit_logs.name
    retention_days      = local.effective_audit_retention_days
    retention_seconds   = local.effective_audit_retention_days * 86400
    retention_locked    = local.effective_audit_lock_retention
    coldline_after_days = var.audit_logs_coldline_age_days
    archive_after_days  = var.audit_logs_archive_age_days
  }
}

output "secret_manager_secret_name" {
  description = "Nom complet du secret Google Secret Manager répliqué dans la région souveraine."
  value       = google_secret_manager_secret.triad_app_config.name
}

output "audit_signing_secret_name" {
  description = "Nom complet du secret Secret Manager dédié à la signature HMAC-SHA256 (AUDIT_SIGNING_SECRET)."
  value       = google_secret_manager_secret.triad_audit_signing_secret.name
}

output "audit_signing_secret_rotation" {
  description = "Politique de rotation périodique du secret HMAC-SHA256 AUDIT_SIGNING_SECRET (NIS2 Art. 21 §2 j)."

  value = {
    enabled         = var.enable_secret_rotation
    rotation_period = var.enable_secret_rotation ? var.secret_rotation_period : null
    pubsub_topic    = var.enable_secret_rotation ? local.resolved_secret_rotation_topic : null
  }
}

output "cloud_armor_policy_name" {
  description = "Nom de la politique WAF Google Cloud Armor (si activée)."

  value = (
    var.enable_cloud_armor || var.enable_eu_geofencing
    ? google_compute_security_policy.triad_waf[0].name
    : null
  )
}

output "cloud_armor_eu_geofencing_enabled" {
  description = "État d'activation du géo-filtrage souverain UE dans Google Cloud Armor (deny 403 hors UE)."
  value       = var.enable_eu_geofencing
}

output "uptime_check_id" {
  description = "Identifiant de la sonde Cloud Monitoring Uptime Check sur /api/health (si activée)."

  value = (
    var.enable_uptime_check
    ? google_monitoring_uptime_check_config.triad_health[0].uptime_check_id
    : null
  )
}

output "uptime_alert_policy_name" {
  description = "Nom de la politique d'alerte Cloud Monitoring rattachée à /api/health (si activée)."

  value = (
    var.enable_uptime_check && var.enable_alert_policy
    ? google_monitoring_alert_policy.triad_uptime_alert[0].name
    : null
  )
}

output "cloud_run_5xx_alert_policy_name" {
  description = "Nom de la politique d'alerte Cloud Monitoring sur les erreurs HTTP 5xx Cloud Run (si activée)."

  value = (
    var.enable_5xx_alert && (trimspace(var.alert_notification_email) != "" || length(var.alert_notification_channels) > 0)
    ? google_monitoring_alert_policy.triad_cloud_run_5xx[0].name
    : null
  )
}

output "cloud_run_latency_alert_policy_name" {
  description = "Nom de la politique d'alerte Cloud Monitoring sur la latence P95 Cloud Run (si activée)."

  value = (
    var.enable_latency_alert && (trimspace(var.alert_notification_email) != "" || length(var.alert_notification_channels) > 0)
    ? google_monitoring_alert_policy.triad_cloud_run_latency_p95[0].name
    : null
  )
}

output "cloud_run_429_alert_policy_name" {
  description = "Nom de la politique d'alerte Cloud Monitoring sur les pics HTTP 429 Cloud Run (si activée)."

  value = (
    var.enable_429_alert && (trimspace(var.alert_notification_email) != "" || length(var.alert_notification_channels) > 0)
    ? google_monitoring_alert_policy.triad_cloud_run_rate_limit_429[0].name
    : null
  )
}

output "security_violations_metric_name" {
  description = "Nom de la métrique Cloud Logging comptabilisant les événements SECURITY_VIOLATION_BLOCKED."
  value       = google_logging_metric.triad_security_violations.name
}

output "security_violation_alert_policy_name" {
  description = "Nom de la politique d'alerte Cloud Monitoring sur les violations sécurité ADK bloquées (si activée)."

  value = (
    var.enable_security_alert && (trimspace(var.alert_notification_email) != "" || length(var.alert_notification_channels) > 0)
    ? google_monitoring_alert_policy.triad_security_violation_alert[0].name
    : null
  )
}

output "monitoring_dashboard_id" {
  description = "Identifiant du tableau de bord Cloud Monitoring Cloud Run TRIAD (si activé)."

  value = (
    var.enable_monitoring_dashboard
    ? google_monitoring_dashboard.triad_executive_ops[0].id
    : null
  )
}

output "billing_budget_name" {
  description = "Identifiant du budget mensuel Cloud Billing FinOps (si activé)."

  value = (
    var.monthly_budget_amount > 0 && trimspace(var.billing_account_id) != ""
    ? google_billing_budget.triad_monthly_budget[0].name
    : null
  )
}

output "artifact_registry_repository" {
  description = "Chemin du dépôt Docker Artifact Registry (si activé)."

  value = (
    var.create_artifact_registry
    ? "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.triad[0].repository_id}"
    : null
  )
}

output "sovereign_org_policies_enabled" {
  description = "État d'activation des contraintes GCP de souveraineté (gcp.resourceLocations europe-west9 & iam.disableServiceAccountKeyCreation)."
  value       = var.enable_org_policies
}

output "sovereign_locations_policy_etag" {
  description = "ETag de la politique d'organisation constraints/gcp.resourceLocations (si activée)."

  value = (
    var.enable_org_policies
    ? google_project_organization_policy.sovereign_resource_locations[0].etag
    : null
  )
}

output "disable_sa_keys_policy_etag" {
  description = "ETag de la politique d'organisation constraints/iam.disableServiceAccountKeyCreation (si activée)."

  value = (
    var.enable_org_policies
    ? google_project_organization_policy.disable_sa_key_creation[0].etag
    : null
  )
}
