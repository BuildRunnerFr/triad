"""Modèles Pydantic pour les findings NIS2, documents nettoyés et rapports TRIAD."""

from __future__ import annotations

from typing import Any, Literal
from pydantic import BaseModel, Field


StatutFinding = Literal["conforme", "partiel", "non_conforme", "a_confirmer"]
GraviteFinding = Literal["critique", "haute", "moyenne", "faible"]
ContradictionType = Literal["Dit ≠ Réel", "Écrit ≠ Réel", "Dit ≠ Écrit", "Dit ≠ Écrit ≠ Réel"]
AuditMode = Literal["AVANT", "APRES"]


class DitCitation(BaseModel):
    """Extrait issu des notes d'entretien (le DIT)."""

    extrait: str = Field(..., min_length=1)
    source: str = Field(..., min_length=1)


class EcritCitation(BaseModel):
    """Extrait issu de la documentation client (l'ÉCRIT)."""

    extrait: str = Field(..., min_length=1)
    source: str = Field(..., min_length=1)
    section: str = Field(default="N/A")


class ReelConstat(BaseModel):
    """Constat technique issu de la configuration GCP (le RÉEL)."""

    constat: str = Field(..., min_length=1)
    ressource: str = Field(..., min_length=1)
    preuve: dict[str, Any] | None = None


class Finding(BaseModel):
    """Écart ou contrôle de conformité NIS2 produit par TRIAD."""

    id: str = Field(..., pattern=r"^F-\d{3}$")
    theme: str
    exigence_nis2: str
    dit: DitCitation | None = None
    ecrit: EcritCitation | None = None
    reel: ReelConstat | None = None
    statut: StatutFinding
    gravite: GraviteFinding
    contradiction: ContradictionType | None = None
    recommandation: str
    commande_correction: str | None = None
    confiance: float = Field(..., ge=0.0, le=1.0)
    citation_verifiee: bool = False


class InjectionScanResult(BaseModel):
    """Résultat de détection de prompt injection."""

    suspect: bool
    raison: str
    extrait_suspect: str | None = None
    methode: Literal["heuristique", "gemini", "combinee"] = "heuristique"


class SanitizedDocument(BaseModel):
    """Document validé, masqué et autorisé à entrer dans le pipeline d'analyse."""

    nom_fichier: str
    type_source: Literal["dit", "ecrit"]
    contenu_masque: str
    masquages: dict[str, int] = Field(default_factory=dict)
    statut: Literal["nettoye", "quarantaine"] = "nettoye"
    raison_quarantaine: str | None = None
    extrait_quarantaine: str | None = None


class AuditSynthesis(BaseModel):
    """Synthèse finale assemblée par le Garde du Corps pour validation humaine."""

    client: str = "Centre Hospitalier de Valmont"
    mode: AuditMode = "APRES"
    statut_validation: Literal["EN ATTENTE DE VALIDATION", "VALIDÉ"] = "EN ATTENTE DE VALIDATION"
    findings: list[Finding] = Field(default_factory=list)
    top_3_risques: list[str] = Field(default_factory=list)
    questions_entretien: list[str] = Field(default_factory=list)
    mail_suivi: str = ""
    documents_nettoyes: list[SanitizedDocument] = Field(default_factory=list)
    documents_quarantaine: list[SanitizedDocument] = Field(default_factory=list)
