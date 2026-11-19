variable "project_id" {
  description = "Identifiant du projet Google Cloud cible."
  type        = string

  validation {
    condition     = length(trimspace(var.project_id)) > 4
    error_message = "project_id doit être un identifiant de projet GCP valide."
  }
}

variable "region" {
  description = "Région Google Cloud souveraine pour Cloud Run, Secret Manager et le stockage des journaux d'audit."
  type        = string
  default     = "europe-west9"
}

variable "vertex_location" {
  description = "Région ou endpoint Vertex AI utilisé par les agents Google ADK / Gemini."
  type        = string
  default     = "europe-west9"
}

variable "gemini_model" {
  description = "Modèle Gemini invoqué sur Vertex AI par le pipeline TRIAD."
  type        = string
  default     = "gemini-2.5-flash"
}

variable "service_name" {
  description = "Nom du service Cloud Run v2."
  type        = string
  default     = "triad"
}

variable "container_image" {
  description = "URI complet de l'image conteneur à déployer sur Cloud Run (ex: europe-west9-docker.pkg.dev/PROJET/triad/triad:latest)."
  type        = string
  default     = ""
}

variable "create_artifact_registry" {
  description = "Crée un dépôt Docker Artifact Registry dédié dans la région cible."
  type        = bool
  default     = true
}

variable "artifact_registry_repo" {
  description = "Identifiant du dépôt Artifact Registry Docker."
  type        = string
  default     = "triad"
}

variable "image_tag" {
  description = "Tag d'image par défaut lorsque container_image n'est pas spécifié."
  type        = string
  default     = "latest"
}

variable "service_account_id" {
  description = "Identifiant court du compte de service à moindre privilège attaché à Cloud Run."
  type        = string
  default     = "triad-auditor"
}

variable "custom_role_id" {
  description = "Identifiant du rôle IAM personnalisé lecture seule métadonnées (exclut storage.objects.get)."
  type        = string
  default     = "triadMetadataAuditor"
}

variable "audit_logs_bucket_name" {
  description = "Nom du bucket GCS dédié aux pistes d'audit immuables (défaut: <project_id>-triad-audit-logs)."
  type        = string
  default     = ""
}

variable "audit_logs_retention_days" {
  description = "Durée de rétention réglementaire WORM en jours du bucket GCS des journaux d'audit SHA-256 (PSSI §6.1 / NIS2)."
  type        = number
  default     = 365

  validation {
    condition     = var.audit_logs_retention_days >= 30 && var.audit_logs_retention_days <= 3650
    error_message = "audit_logs_retention_days doit être compris entre 30 et 3650 jours."
  }
}

variable "audit_logs_lock_retention" {
  description = "Verrouille irréversiblement la politique WORM du bucket d'audit (false par défaut pour ne pas bloquer terraform destroy)."
  type        = bool
  default     = false
}

variable "audit_logs_coldline_age_days" {
  description = "Âge en jours déclenchant la transition automatique des journaux d'audit vers la classe COLDLINE (PSSI §6.1)."
  type        = number
  default     = 90

  validation {
    condition     = var.audit_logs_coldline_age_days >= 30
    error_message = "audit_logs_coldline_age_days doit être supérieur ou égal à 30 jours."
  }
}

variable "audit_logs_archive_age_days" {
  description = "Âge en jours déclenchant la transition automatique des journaux d'audit vers la classe ARCHIVE longue durée (PSSI §6.1)."
  type        = number
  default     = 365

  validation {
    condition     = var.audit_logs_archive_age_days >= 90
    error_message = "audit_logs_archive_age_days doit être supérieur ou égal à 90 jours."
  }
}

variable "audit_retention_days" {
  description = "Alias rétrocompatible de audit_logs_retention_days (laisser null pour utiliser audit_logs_retention_days)."
  type        = number
  default     = null
  nullable    = true
}

variable "lock_audit_bucket_retention" {
  description = "Alias rétrocompatible de audit_logs_lock_retention."
  type        = bool
  default     = false
}

variable "allow_unauthenticated" {
  description = "Autorise l'invocation publique (allUsers) pour les démonstrations. Laisser à false en production (IAM / IAP requis)."
  type        = bool
  default     = false
}

variable "authorized_invokers" {
  description = "Liste des principaux IAM autorisés à invoquer Cloud Run lorsque allow_unauthenticated = false (ex: group:cyber@deloitte.fr)."
  type        = list(string)
  default     = []
}

variable "enable_iap_invoker" {
  description = "Autorise le Service Agent Identity-Aware Proxy (IAP) à invoquer le service Cloud Run derrière un Load Balancer HTTPS."
  type        = bool
  default     = false
}

variable "ingress_settings" {
  description = "Périmètre réseau d'entrée Cloud Run (utiliser INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER derrière IAP / Cloud Armor)."
  type        = string
  default     = "INGRESS_TRAFFIC_ALL"

  validation {
    condition = contains([
      "INGRESS_TRAFFIC_ALL",
      "INGRESS_TRAFFIC_INTERNAL_ONLY",
      "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER",
    ], var.ingress_settings)
    error_message = "ingress_settings doit être INGRESS_TRAFFIC_ALL, INGRESS_TRAFFIC_INTERNAL_ONLY ou INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER."
  }
}

variable "enable_vpc_egress" {
  description = "Active le routage sortant Direct VPC Egress sur Cloud Run v2 (sans Serverless VPC Access Connector)."
  type        = bool
  default     = false
}

variable "vpc_egress_setting" {
  description = "Mode de routage Direct VPC Egress Cloud Run lorsque enable_vpc_egress = true (PRIVATE_RANGES_ONLY par défaut ou ALL_TRAFFIC)."
  type        = string
  default     = "PRIVATE_RANGES_ONLY"

  validation {
    condition     = contains(["PRIVATE_RANGES_ONLY", "ALL_TRAFFIC"], var.vpc_egress_setting)
    error_message = "vpc_egress_setting doit être PRIVATE_RANGES_ONLY ou ALL_TRAFFIC."
  }
}

variable "vpc_network" {
  description = "Nom ou identifiant du réseau VPC cible lorsque enable_vpc_egress = true."
  type        = string
  default     = "default"
}

variable "vpc_subnetwork" {
  description = "Nom ou identifiant du sous-réseau régional (europe-west9) pour Direct VPC Egress (optionnel sur un VPC auto-mode)."
  type        = string
  default     = ""
}

variable "vpc_network_tags" {
  description = "Tags réseau appliqués aux interfaces Direct VPC Egress de Cloud Run v2 pour le filtrage pare-feu."
  type        = list(string)
  default     = ["triad-cloud-run-egress"]
}

variable "use_gcp_snapshot" {
  description = "Active le mode snapshot statique (false en production pour interroger les vraies API GCP en lecture seule)."
  type        = bool
  default     = false
}

variable "use_demo_cache" {
  description = "Active le cache de synthèse de démonstration."
  type        = bool
  default     = false
}

variable "enable_dlp_api" {
  description = "Active l'API Cloud Data Loss Prevention (DLP) en complément du masquage PII local du Douanier."
  type        = bool
  default     = false
}

variable "min_instances" {
  description = "Nombre minimal d'instances Cloud Run maintenues à chaud."
  type        = number
  default     = 0
}

variable "max_instances" {
  description = "Nombre maximal d'instances Cloud Run pour maîtriser les coûts."
  type        = number
  default     = 5
}

variable "concurrency" {
  description = "Nombre maximal de requêtes simultanées par instance Cloud Run."
  type        = number
  default     = 40
}

variable "cpu_limit" {
  description = "Allocation CPU par instance Cloud Run."
  type        = string
  default     = "2"
}

variable "memory_limit" {
  description = "Allocation mémoire par instance Cloud Run."
  type        = string
  default     = "1Gi"
}

variable "enable_startup_cpu_boost" {
  description = "Active l'allocation CPU supplémentaire au démarrage à froid (startup_cpu_boost) sur Cloud Run v2."
  type        = bool
  default     = true
}

variable "deletion_protection" {
  description = "Active la protection contre la suppression accidentelle du service Cloud Run v2."
  type        = bool
  default     = false
}

variable "rate_limit_max_requests" {
  description = "Plafond applicatif de requêtes d'audit/import par fenêtre glissante (protection anti-abus API HTTP 429)."
  type        = number
  default     = 60
}

variable "rate_limit_window_seconds" {
  description = "Fenêtre glissante en secondes du limiteur de débit applicatif TRIAD."
  type        = number
  default     = 60
}

variable "session_ttl_hours" {
  description = "Durée de rétention en heures des sessions secondaires avant éligibilité à la purge (/api/sessions/cleanup)."
  type        = number
  default     = 24

  validation {
    condition     = var.session_ttl_hours >= 1 && var.session_ttl_hours <= 8760
    error_message = "session_ttl_hours doit être compris entre 1 et 8760 heures."
  }
}

variable "log_format" {
  description = "Format de journalisation applicative sur Cloud Run (json pour Cloud Logging structuré, auto ou text)."
  type        = string
  default     = "json"

  validation {
    condition     = contains(["auto", "json", "text"], var.log_format)
    error_message = "log_format doit être auto, json ou text."
  }
}

variable "secret_id" {
  description = "Identifiant du secret Google Secret Manager dédié aux clés et configurations sensibles de TRIAD."
  type        = string
  default     = "triad-sensitive-config"
}

variable "mount_secret_env" {
  description = "Injecte le secret Secret Manager dans Cloud Run (activer après création d'au moins une version du secret)."
  type        = bool
  default     = false
}

variable "secret_version" {
  description = "Version du secret Secret Manager injectée dans Cloud Run lorsque mount_secret_env = true."
  type        = string
  default     = "latest"
}

variable "audit_signing_secret_id" {
  description = "Identifiant du secret Google Secret Manager contenant la clé HMAC-SHA256 (AUDIT_SIGNING_SECRET) des livrables scellés."
  type        = string
  default     = "triad-audit-signing-secret"
}

variable "mount_audit_signing_secret" {
  description = "Injecte le secret Secret Manager AUDIT_SIGNING_SECRET dans Cloud Run (activer après ajout d'une version du secret)."
  type        = bool
  default     = false
}

variable "audit_signing_secret_version" {
  description = "Version du secret AUDIT_SIGNING_SECRET injectée dans Cloud Run lorsque mount_audit_signing_secret = true."
  type        = string
  default     = "latest"
}

variable "enable_secret_rotation" {
  description = "Active la politique de rotation périodique automatisée (Pub/Sub + Secret Manager) sur le secret HMAC AUDIT_SIGNING_SECRET."
  type        = bool
  default     = false
}

variable "secret_rotation_period" {
  description = "Période de rotation du secret AUDIT_SIGNING_SECRET au format durée GCP en secondes (défaut : 7776000s = 90 jours, min 3600s)."
  type        = string
  default     = "7776000s"

  validation {
    condition     = can(regex("^[1-9][0-9]*s$", var.secret_rotation_period)) && tonumber(trimsuffix(var.secret_rotation_period, "s")) >= 3600
    error_message = "secret_rotation_period doit être exprimé en secondes avec suffixe 's' et supérieur ou égal à 3600s (ex: 7776000s pour 90 jours)."
  }
}

variable "secret_next_rotation_time" {
  description = "Horodatage RFC3339 UTC (Zulu) de la prochaine échéance de rotation lorsque enable_secret_rotation = true."
  type        = string
  default     = "2027-02-17T00:00:00Z"

  validation {
    condition     = can(regex("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$", var.secret_next_rotation_time))
    error_message = "secret_next_rotation_time doit être au format RFC3339 UTC Zulu (ex: 2027-02-17T00:00:00Z)."
  }
}

variable "secret_rotation_topic" {
  description = "Identifiant complet (projects/.../topics/...) d'un topic Pub/Sub existant pour les notifications SECRET_ROTATE (créé automatiquement dans var.region si vide)."
  type        = string
  default     = ""
}

variable "enable_uptime_check" {
  description = "Provisionne une sonde Cloud Monitoring Uptime Check HTTPS sur le point de terminaison /api/health."
  type        = bool
  default     = true
}

variable "enable_monitoring_dashboard" {
  description = "Provisionne le tableau de bord exécutif Cloud Monitoring (requêtes/s, latence P50/P95, 2xx/4xx/5xx, CPU, mémoire)."
  type        = bool
  default     = true
}

variable "enable_alert_policy" {
  description = "Provisionne une politique d'alerte Cloud Monitoring en cas d'indisponibilité de /api/health."
  type        = bool
  default     = false
}

variable "enable_5xx_alert" {
  description = "Provisionne une politique d'alerte Cloud Monitoring sur les erreurs HTTP 5xx Cloud Run lorsqu'un canal de notification est fourni."
  type        = bool
  default     = true
}

variable "cloud_run_5xx_threshold" {
  description = "Seuil d'erreurs HTTP 5xx cumulées sur 5 minutes déclenchant l'alerte Cloud Run."
  type        = number
  default     = 5

  validation {
    condition     = var.cloud_run_5xx_threshold >= 1
    error_message = "cloud_run_5xx_threshold doit être supérieur ou égal à 1."
  }
}

variable "enable_latency_alert" {
  description = "Provisionne une politique d'alerte Cloud Monitoring sur la dégradation de latence P95 Cloud Run lorsqu'un canal de notification est fourni."
  type        = bool
  default     = true
}

variable "cloud_run_p95_latency_ms" {
  description = "Seuil maximal de latence P95 en millisecondes sur Cloud Run avant déclenchement d'alerte."
  type        = number
  default     = 5000

  validation {
    condition     = var.cloud_run_p95_latency_ms >= 100
    error_message = "cloud_run_p95_latency_ms doit être supérieur ou égal à 100 ms."
  }
}

variable "enable_429_alert" {
  description = "Provisionne une politique d'alerte Cloud Monitoring sur les pics de réponses HTTP 429 (limitation de débit / abus API) lorsqu'un canal de notification est fourni."
  type        = bool
  default     = true
}

variable "cloud_run_429_threshold" {
  description = "Seuil de réponses HTTP 429 cumulées sur 300s déclenchant l'alerte anti-abus Cloud Run."
  type        = number
  default     = 25

  validation {
    condition     = var.cloud_run_429_threshold >= 1
    error_message = "cloud_run_429_threshold doit être supérieur ou égal à 1."
  }
}

variable "enable_security_alert" {
  description = "Provisionne une politique d'alerte Cloud Monitoring déclenchée dès > 0 tentative SECURITY_VIOLATION_BLOCKED lorsqu'un canal de notification est fourni."
  type        = bool
  default     = true
}

variable "alert_notification_email" {
  description = "Adresse e-mail optionnelle pour recevoir les alertes Cloud Monitoring et Budget."
  type        = string
  default     = ""
}

variable "alert_notification_channels" {
  description = "Liste d'identifiants de Notification Channels existants à rattacher aux politiques d'alerte."
  type        = list(string)
  default     = []
}

variable "enable_cloud_armor" {
  description = "Provisionne une politique WAF Google Cloud Armor (OWASP CRS, anti-DDoS et limitation de débit par IP)."
  type        = bool
  default     = false
}

variable "cloud_armor_rate_limit_rpm" {
  description = "Seuil maximal de requêtes par minute et par IP cliente autorisé par Cloud Armor avant réponse HTTP 429."
  type        = number
  default     = 120

  validation {
    condition     = var.cloud_armor_rate_limit_rpm >= 10 && var.cloud_armor_rate_limit_rpm <= 10000
    error_message = "cloud_armor_rate_limit_rpm doit être compris entre 10 et 10000 requêtes/minute."
  }
}

variable "enable_eu_geofencing" {
  description = "Active la règle Cloud Armor de géo-filtrage souverain bloquant en HTTP 403 tout trafic hors Union Européenne (allowed_eu_country_codes)."
  type        = bool
  default     = false
}

variable "allowed_eu_country_codes" {
  description = "Liste des codes pays ISO 3166-1 alpha-2 autorisés par le géo-filtrage Cloud Armor lorsque enable_eu_geofencing = true (par défaut : UE-27)."
  type        = list(string)
  default     = ["AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "ES", "FI", "FR", "GR", "HR", "HU", "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PL", "PT", "RO", "SE", "SI", "SK"]

  validation {
    condition     = length(var.allowed_eu_country_codes) > 0 && alltrue([for code in var.allowed_eu_country_codes : can(regex("^[A-Z]{2}$", code))])
    error_message = "allowed_eu_country_codes doit contenir au moins un code pays ISO 3166-1 alpha-2 majuscule (ex: FR, DE, BE)."
  }
}

variable "monthly_budget_amount" {
  description = "Montant mensuel cible du budget d'alerte FinOps GCP (0 = désactivé ; requiert billing_account_id si > 0)."
  type        = number
  default     = 0

  validation {
    condition     = var.monthly_budget_amount >= 0
    error_message = "monthly_budget_amount doit être supérieur ou égal à 0."
  }
}

variable "billing_account_id" {
  description = "Identifiant du compte de facturation GCP (ex: 012345-6789AB-CDEF01) requis pour provisionner l'alerte budget."
  type        = string
  default     = ""
}

variable "budget_currency" {
  description = "Devise ISO 4217 du budget mensuel Cloud Billing."
  type        = string
  default     = "EUR"
}

variable "enable_org_policies" {
  description = "Applique les contraintes d'organisation GCP de souveraineté (constraints/gcp.resourceLocations europe-west9 & constraints/iam.disableServiceAccountKeyCreation). Requiert roles/orgpolicy.policyAdmin."
  type        = bool
  default     = false
}

variable "allowed_resource_locations" {
  description = "Liste des emplacements GCP souverains autorisés lorsque enable_org_policies = true (par défaut : europe-west9)."
  type        = list(string)
  default     = ["in:europe-west9-locations"]

  validation {
    condition     = length(var.allowed_resource_locations) > 0
    error_message = "allowed_resource_locations doit contenir au moins une région souveraine (ex: in:europe-west9-locations)."
  }
}
