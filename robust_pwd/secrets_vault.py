"""Coffre de secrets applicatifs (``~/.robust-pwd/secrets.enc``).

Implémentation conforme à ``docs/secrets-format.md`` et jumelle de
``desktop/src/main/secretsVault.ts``.
"""

import json
import os
import re
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlparse

from cryptography.exceptions import InvalidTag

from . import crypto

SECRETS_KIND = "robust-pwd/secrets"
SECRETS_VERSION = 1

MIN_MASTER_LENGTH = 8
MAX_MASTER_LENGTH = 1024
MAX_VAULT_BYTES = 10 * 1024 * 1024
MAX_PROJECTS = 200
MAX_ENVIRONMENTS = 20
MAX_VARIABLES = 1000
MAX_DESCRIPTION_LENGTH = 200
MAX_VALUE_LENGTH = 65_536
MAX_SCOPE_LENGTH = 255
MAX_TOKEN_LENGTH = 512

DEFAULT_ENVIRONMENTS = ("local", "staging", "production")
PROVIDERS = ("gitlab", "github")
DEFAULT_HOSTS = {
    "gitlab": "https://gitlab.com",
    "github": "https://api.github.com",
}
VARIABLE_TYPES = ("env_var", "file")

_PROJECT_NAME_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
_ENV_NAME_RE = re.compile(r"^[a-z0-9._-]{1,32}$")
_VAR_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,254}$")
_TARGET_RE = re.compile(r"^[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)+$")


class SecretsVaultError(ValueError):
    """Erreur métier du coffre de secrets avec code normalisé."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def default_secrets_path() -> Path:
    override = os.environ.get("ROBUST_PWD_SECRETS_VAULT", "").strip()
    if override:
        return Path(override)
    return Path.home() / ".robust-pwd" / "secrets.enc"


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

def validate_master(master: str) -> str:
    if not isinstance(master, str) or len(master) < MIN_MASTER_LENGTH:
        raise SecretsVaultError(
            "WEAK_MASTER",
            f"Le mot de passe maître doit contenir au moins {MIN_MASTER_LENGTH} caractères.",
        )
    if len(master) > MAX_MASTER_LENGTH:
        raise SecretsVaultError("INVALID", "Le mot de passe maître est trop long.")
    return master


def validate_project_name(name: str) -> str:
    clean = name.strip() if isinstance(name, str) else ""
    if not _PROJECT_NAME_RE.match(clean):
        raise SecretsVaultError(
            "INVALID",
            "Nom de projet invalide (1–64 caractères parmi A-Z, a-z, 0-9, ., _, -).",
        )
    return clean


def validate_env_name(name: str) -> str:
    clean = name.strip() if isinstance(name, str) else ""
    if not _ENV_NAME_RE.match(clean):
        raise SecretsVaultError(
            "INVALID",
            "Nom d'environnement invalide (1–32 caractères parmi a-z, 0-9, ., _, -).",
        )
    return clean


def validate_var_key(key: str) -> str:
    clean = key.strip() if isinstance(key, str) else ""
    if not _VAR_KEY_RE.match(clean):
        raise SecretsVaultError(
            "INVALID",
            "Clé de variable invalide (lettres, chiffres et _, ne commence pas par un chiffre).",
        )
    return clean


def validate_var_value(value: str) -> str:
    if not isinstance(value, str):
        raise SecretsVaultError("INVALID", "Valeur de variable invalide.")
    if len(value) > MAX_VALUE_LENGTH:
        raise SecretsVaultError("INVALID", f"La valeur dépasse la limite de {MAX_VALUE_LENGTH} caractères.")
    return value


def validate_provider(provider: str) -> str:
    clean = provider.strip().lower() if isinstance(provider, str) else ""
    if clean not in PROVIDERS:
        raise SecretsVaultError("INVALID", f"Fournisseur inconnu : « {provider} » (attendu : gitlab, github).")
    return clean


def normalize_host(host: Optional[str], provider: str) -> str:
    validate_provider(provider)
    raw = (host or "").strip() or DEFAULT_HOSTS[provider]
    raw = raw.rstrip("/")
    parsed = urlparse(raw)
    if parsed.scheme != "https" or not parsed.netloc or parsed.params or parsed.query or parsed.fragment:
        raise SecretsVaultError("INVALID", "L'hôte distant doit être une URL HTTPS valide.")
    return raw


def validate_remote_target(target: str, provider: str) -> str:
    validate_provider(provider)
    clean = target.strip().strip("/") if isinstance(target, str) else ""
    if not _TARGET_RE.match(clean):
        raise SecretsVaultError("INVALID", "Cible distante invalide (attendu : groupe/projet ou owner/repo).")
    if provider == "github" and clean.count("/") != 1:
        raise SecretsVaultError("INVALID", "Un dépôt GitHub s'écrit « propriétaire/dépôt ».")
    return clean


def validate_remote_scope(scope: Optional[str]) -> Optional[str]:
    if scope is None:
        return None
    if not isinstance(scope, str):
        raise SecretsVaultError("INVALID", "Portée distante invalide.")
    clean = scope.strip()
    if not clean or clean.lower() == "none":
        return None
    if len(clean) > MAX_SCOPE_LENGTH:
        raise SecretsVaultError("INVALID", "Portée distante trop longue.")
    return clean


def _validate_variable_record(raw: Any) -> Dict[str, Any]:
    if not isinstance(raw, dict):
        raise SecretsVaultError("CORRUPT", "Variable invalide dans le coffre.")
    key = validate_var_key(raw.get("key", ""))
    value = validate_var_value(raw.get("value", ""))
    masked = bool(raw.get("masked", False))
    protected = bool(raw.get("protected", False))
    is_raw = bool(raw.get("raw", True))
    vtype = raw.get("type", "env_var")
    if vtype not in VARIABLE_TYPES:
        raise SecretsVaultError("CORRUPT", f"Type de variable invalide : {vtype}")
    updated_at = raw.get("updated_at")
    if not isinstance(updated_at, str) or not updated_at:
        raise SecretsVaultError("CORRUPT", "Horodatage de variable manquant.")
    out = dict(raw)
    out.update(
        {
            "key": key,
            "value": value,
            "masked": masked,
            "protected": protected,
            "raw": is_raw,
            "type": vtype,
            "updated_at": updated_at,
        }
    )
    return out


def _validate_environment_record(raw: Any) -> Dict[str, Any]:
    if not isinstance(raw, dict):
        raise SecretsVaultError("CORRUPT", "Environnement invalide dans le coffre.")
    name = validate_env_name(raw.get("name", ""))
    scope = validate_remote_scope(raw.get("remote_scope"))
    vars_raw = raw.get("variables")
    if not isinstance(vars_raw, list) or len(vars_raw) > MAX_VARIABLES:
        raise SecretsVaultError("CORRUPT", "Liste de variables invalide.")
    seen_keys = set()
    variables = []
    for item in vars_raw:
        var = _validate_variable_record(item)
        if var["key"] in seen_keys:
            raise SecretsVaultError("CORRUPT", f"Clé de variable dupliquée : {var['key']}")
        seen_keys.add(var["key"])
        variables.append(var)
    out = dict(raw)
    out.update({"name": name, "remote_scope": scope, "variables": variables})
    return out


def _validate_remote_record(raw: Any) -> Optional[Dict[str, Any]]:
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise SecretsVaultError("CORRUPT", "Configuration distante invalide.")
    provider = validate_provider(raw.get("provider", ""))
    host = normalize_host(raw.get("host"), provider)
    target = validate_remote_target(raw.get("target", ""), provider)
    out = dict(raw)
    out.update({"provider": provider, "host": host, "target": target})
    return out


def _validate_project_record(raw: Any) -> Dict[str, Any]:
    if not isinstance(raw, dict):
        raise SecretsVaultError("CORRUPT", "Projet invalide dans le coffre.")
    pid = raw.get("id")
    if not isinstance(pid, int) or isinstance(pid, bool) or pid < 1:
        raise SecretsVaultError("CORRUPT", "Identifiant de projet invalide.")
    name = validate_project_name(raw.get("name", ""))
    description = raw.get("description", "")
    if not isinstance(description, str) or len(description) > MAX_DESCRIPTION_LENGTH:
        raise SecretsVaultError("CORRUPT", "Description de projet invalide.")
    created_at = raw.get("created_at")
    updated_at = raw.get("updated_at")
    if not isinstance(created_at, str) or not isinstance(updated_at, str):
        raise SecretsVaultError("CORRUPT", "Horodatage de projet manquant.")
    remote = _validate_remote_record(raw.get("remote"))
    envs_raw = raw.get("environments")
    if not isinstance(envs_raw, list) or len(envs_raw) > MAX_ENVIRONMENTS:
        raise SecretsVaultError("CORRUPT", "Liste d'environnements invalide.")
    seen_envs = set()
    environments = []
    for item in envs_raw:
        env = _validate_environment_record(item)
        if env["name"] in seen_envs:
            raise SecretsVaultError("CORRUPT", f"Environnement dupliqué : {env['name']}")
        seen_envs.add(env["name"])
        environments.append(env)
    out = dict(raw)
    out.update(
        {
            "id": pid,
            "name": name,
            "description": description,
            "created_at": created_at,
            "updated_at": updated_at,
            "remote": remote,
            "environments": environments,
        }
    )
    return out


def _validate_credential_record(raw: Any) -> Dict[str, Any]:
    if not isinstance(raw, dict):
        raise SecretsVaultError("CORRUPT", "Identifiant distant invalide.")
    provider = validate_provider(raw.get("provider", ""))
    host = normalize_host(raw.get("host"), provider)
    token = raw.get("token", "")
    if not isinstance(token, str) or not (1 <= len(token.strip()) <= MAX_TOKEN_LENGTH):
        raise SecretsVaultError("CORRUPT", "Jeton distant invalide.")
    added_at = raw.get("added_at")
    if not isinstance(added_at, str) or not added_at:
        raise SecretsVaultError("CORRUPT", "Horodatage de jeton manquant.")
    out = dict(raw)
    out.update({"provider": provider, "host": host, "token": token.strip(), "added_at": added_at})
    return out


def parse_vault_document(parsed: Any) -> Dict[str, Any]:
    if not isinstance(parsed, dict):
        raise SecretsVaultError("CORRUPT", "Le contenu du coffre de secrets est invalide.")
    if parsed.get("kind") != SECRETS_KIND:
        raise SecretsVaultError(
            "WRONG_KIND",
            "Ce fichier n'est pas un coffre de secrets applicatifs (kind invalide).",
        )
    if parsed.get("version") != SECRETS_VERSION:
        raise SecretsVaultError(
            "UNSUPPORTED_VERSION",
            f"Version de coffre non prise en charge : {parsed.get('version')}.",
        )
    projects_raw = parsed.get("projects")
    if not isinstance(projects_raw, list) or len(projects_raw) > MAX_PROJECTS:
        raise SecretsVaultError("CORRUPT", "Liste des projets invalide.")
    seen_ids = set()
    seen_names = set()
    projects = []
    for item in projects_raw:
        proj = _validate_project_record(item)
        if proj["id"] in seen_ids or proj["name"] in seen_names:
            raise SecretsVaultError("CORRUPT", f"Projet en doublon : {proj['name']}")
        seen_ids.add(proj["id"])
        seen_names.add(proj["name"])
        projects.append(proj)

    creds_raw = parsed.get("credentials", [])
    if not isinstance(creds_raw, list):
        raise SecretsVaultError("CORRUPT", "Liste des identifiants invalide.")
    seen_creds = set()
    credentials = []
    for item in creds_raw:
        cred = _validate_credential_record(item)
        key = (cred["provider"], cred["host"])
        if key in seen_creds:
            raise SecretsVaultError("CORRUPT", f"Jeton en doublon pour {cred['provider']} ({cred['host']}).")
        seen_creds.add(key)
        credentials.append(cred)

    out = dict(parsed)
    out.update(
        {
            "kind": SECRETS_KIND,
            "version": SECRETS_VERSION,
            "projects": projects,
            "credentials": credentials,
        }
    )
    return out


# ---------------------------------------------------------------------------
# Lecture / écriture sur disque
# ---------------------------------------------------------------------------

def empty_vault() -> Dict[str, Any]:
    return {
        "kind": SECRETS_KIND,
        "version": SECRETS_VERSION,
        "projects": [],
        "credentials": [],
    }


def secrets_vault_exists(path: Optional[Path] = None) -> bool:
    target = Path(path) if path is not None else default_secrets_path()
    return target.exists()


def create_secrets_vault(master: str, path: Optional[Path] = None) -> Dict[str, Any]:
    target = Path(path) if path is not None else default_secrets_path()
    if target.exists():
        raise SecretsVaultError("EXISTS", "Un coffre de secrets existe déjà à cet emplacement.")
    validate_master(master)
    doc = empty_vault()
    save_secrets_vault(doc, master, target)
    return doc


def load_secrets_vault(master: str, path: Optional[Path] = None) -> Dict[str, Any]:
    target = Path(path) if path is not None else default_secrets_path()
    if not target.exists():
        raise SecretsVaultError("NO_VAULT", "Aucun coffre de secrets trouvé. Lancez « robust-pwd secrets init ».")
    if not isinstance(master, str) or not master or len(master) > MAX_MASTER_LENGTH:
        raise SecretsVaultError("BAD_MASTER", "Mot de passe maître incorrect.")
    try:
        blob = target.read_bytes()
    except OSError:
        raise SecretsVaultError("CORRUPT", "Impossible de lire le fichier du coffre de secrets.")
    if len(blob) > MAX_VAULT_BYTES:
        raise SecretsVaultError("CORRUPT", "Le fichier du coffre de secrets dépasse la taille maximale.")
    try:
        plaintext = crypto.decrypt(blob, master)
    except InvalidTag:
        raise SecretsVaultError("BAD_MASTER", "Mot de passe maître incorrect.")
    except ValueError:
        raise SecretsVaultError("CORRUPT", "Le fichier du coffre de secrets est incomplet ou corrompu.")
    try:
        parsed = json.loads(plaintext.decode("utf-8"))
    except Exception:
        raise SecretsVaultError("CORRUPT", "Le contenu du coffre de secrets est illisible.")
    return parse_vault_document(parsed)


def save_secrets_vault(vault: Dict[str, Any], master: str, path: Optional[Path] = None) -> None:
    target = Path(path) if path is not None else default_secrets_path()
    validate_master(master)
    validated = parse_vault_document(vault)
    payload = json.dumps(validated, ensure_ascii=False).encode("utf-8")
    if len(payload) > MAX_VAULT_BYTES:
        raise SecretsVaultError("INVALID", "Le coffre de secrets dépasse la taille maximale autorisée.")
    crypto.write_atomic(target, crypto.encrypt(payload, master))


# ---------------------------------------------------------------------------
# Opérations sur le document en mémoire
# ---------------------------------------------------------------------------

def find_project(vault: Dict[str, Any], name_or_id: Any) -> Dict[str, Any]:
    for proj in vault["projects"]:
        if isinstance(name_or_id, int) and not isinstance(name_or_id, bool):
            if proj["id"] == name_or_id:
                return proj
        elif proj["name"] == name_or_id:
            return proj
    raise SecretsVaultError("NOT_FOUND", f"Projet introuvable : « {name_or_id} ».")


def find_environment(project: Dict[str, Any], env_name: str) -> Dict[str, Any]:
    for env in project["environments"]:
        if env["name"] == env_name:
            return env
    raise SecretsVaultError(
        "NOT_FOUND",
        f"Environnement « {env_name} » introuvable dans le projet « {project['name']} ».",
    )


def add_project(
    vault: Dict[str, Any],
    name: str,
    description: str = "",
    environments: Optional[List[str]] = None,
) -> Dict[str, Any]:
    clean_name = validate_project_name(name)
    if any(p["name"] == clean_name for p in vault["projects"]):
        raise SecretsVaultError("EXISTS", f"Un projet « {clean_name} » existe déjà.")
    if len(vault["projects"]) >= MAX_PROJECTS:
        raise SecretsVaultError("INVALID", f"Limite de {MAX_PROJECTS} projets atteinte.")
    clean_desc = (description or "").strip()
    if len(clean_desc) > MAX_DESCRIPTION_LENGTH:
        raise SecretsVaultError("INVALID", f"Description trop longue ({MAX_DESCRIPTION_LENGTH} caractères max).")

    env_names = list(DEFAULT_ENVIRONMENTS) if environments is None else list(environments)
    if len(env_names) > MAX_ENVIRONMENTS:
        raise SecretsVaultError("INVALID", f"Maximum {MAX_ENVIRONMENTS} environnements par projet.")
    env_records = []
    seen = set()
    for raw_env in env_names:
        ename = validate_env_name(raw_env)
        if ename in seen:
            continue
        seen.add(ename)
        env_records.append({"name": ename, "remote_scope": None, "variables": []})

    now = _now()
    next_id = max((p["id"] for p in vault["projects"]), default=0) + 1
    project = {
        "id": next_id,
        "name": clean_name,
        "description": clean_desc,
        "created_at": now,
        "updated_at": now,
        "remote": None,
        "environments": env_records,
    }
    vault["projects"].append(project)
    return project


def rename_project(
    vault: Dict[str, Any],
    current: Any,
    new_name: str,
    description: Optional[str] = None,
) -> Dict[str, Any]:
    project = find_project(vault, current)
    clean_name = validate_project_name(new_name)
    if clean_name != project["name"] and any(p["name"] == clean_name for p in vault["projects"]):
        raise SecretsVaultError("EXISTS", f"Un projet « {clean_name} » existe déjà.")
    project["name"] = clean_name
    if description is not None:
        clean_desc = description.strip()
        if len(clean_desc) > MAX_DESCRIPTION_LENGTH:
            raise SecretsVaultError("INVALID", f"Description trop longue ({MAX_DESCRIPTION_LENGTH} caractères max).")
        project["description"] = clean_desc
    project["updated_at"] = _now()
    return project


def remove_project(vault: Dict[str, Any], name_or_id: Any) -> Dict[str, Any]:
    project = find_project(vault, name_or_id)
    vault["projects"] = [p for p in vault["projects"] if p["id"] != project["id"]]
    return project


def add_environment(vault: Dict[str, Any], project_ref: Any, env_name: str) -> Dict[str, Any]:
    project = find_project(vault, project_ref)
    clean_env = validate_env_name(env_name)
    if any(e["name"] == clean_env for e in project["environments"]):
        raise SecretsVaultError("EXISTS", f"L'environnement « {clean_env} » existe déjà.")
    if len(project["environments"]) >= MAX_ENVIRONMENTS:
        raise SecretsVaultError("INVALID", f"Limite de {MAX_ENVIRONMENTS} environnements atteinte.")
    env = {"name": clean_env, "remote_scope": None, "variables": []}
    project["environments"].append(env)
    project["updated_at"] = _now()
    return env


def remove_environment(vault: Dict[str, Any], project_ref: Any, env_name: str) -> Dict[str, Any]:
    project = find_project(vault, project_ref)
    env = find_environment(project, env_name)
    project["environments"] = [e for e in project["environments"] if e["name"] != env["name"]]
    project["updated_at"] = _now()
    return env


def set_variable(
    vault: Dict[str, Any],
    project_ref: Any,
    env_name: str,
    key: str,
    value: str,
    *,
    masked: Optional[bool] = None,
    protected: Optional[bool] = None,
    raw: Optional[bool] = None,
    var_type: Optional[str] = None,
) -> Dict[str, Any]:
    project = find_project(vault, project_ref)
    env = find_environment(project, env_name)
    clean_key = validate_var_key(key)
    clean_value = validate_var_value(value)
    if var_type is not None and var_type not in VARIABLE_TYPES:
        raise SecretsVaultError("INVALID", f"Type de variable invalide : {var_type}")

    now = _now()
    existing = next((v for v in env["variables"] if v["key"] == clean_key), None)
    if existing is not None:
        existing["value"] = clean_value
        if masked is not None:
            existing["masked"] = bool(masked)
        if protected is not None:
            existing["protected"] = bool(protected)
        if raw is not None:
            existing["raw"] = bool(raw)
        if var_type is not None:
            existing["type"] = var_type
        existing["updated_at"] = now
        project["updated_at"] = now
        return existing

    if len(env["variables"]) >= MAX_VARIABLES:
        raise SecretsVaultError("INVALID", f"Limite de {MAX_VARIABLES} variables atteinte.")
    record = {
        "key": clean_key,
        "value": clean_value,
        "masked": bool(masked) if masked is not None else False,
        "protected": bool(protected) if protected is not None else False,
        "raw": bool(raw) if raw is not None else True,
        "type": var_type if var_type is not None else "env_var",
        "updated_at": now,
    }
    env["variables"].append(record)
    project["updated_at"] = now
    return record


def get_variable(vault: Dict[str, Any], project_ref: Any, env_name: str, key: str) -> Dict[str, Any]:
    project = find_project(vault, project_ref)
    env = find_environment(project, env_name)
    clean_key = validate_var_key(key)
    for var in env["variables"]:
        if var["key"] == clean_key:
            return var
    raise SecretsVaultError("NOT_FOUND", f"Variable « {clean_key} » introuvable dans {project['name']}/{env_name}.")


def unset_variable(vault: Dict[str, Any], project_ref: Any, env_name: str, key: str) -> Dict[str, Any]:
    project = find_project(vault, project_ref)
    env = find_environment(project, env_name)
    var = get_variable(vault, project_ref, env_name, key)
    env["variables"] = [v for v in env["variables"] if v["key"] != var["key"]]
    project["updated_at"] = _now()
    return var


def import_variables(
    vault: Dict[str, Any],
    project_ref: Any,
    env_name: str,
    pairs: List[Dict[str, str]],
    *,
    overwrite: bool = True,
) -> Tuple[int, int, int]:
    """Importe une liste ``[{"key", "value"}]``. Retourne ``(ajoutées, modifiées, ignorées)``."""
    project = find_project(vault, project_ref)
    env = find_environment(project, env_name)
    by_key = {v["key"]: v for v in env["variables"]}
    added = updated = skipped = 0
    for item in pairs:
        key = validate_var_key(item["key"])
        value = validate_var_value(item["value"])
        if key in by_key:
            if not overwrite or by_key[key]["value"] == value:
                skipped += 1
                continue
            set_variable(vault, project["id"], env_name, key, value)
            updated += 1
        else:
            rec = set_variable(vault, project["id"], env_name, key, value)
            by_key[key] = rec
            added += 1
    return added, updated, skipped


def link_remote(
    vault: Dict[str, Any],
    project_ref: Any,
    provider: str,
    target: str,
    host: Optional[str] = None,
) -> Dict[str, Any]:
    project = find_project(vault, project_ref)
    clean_provider = validate_provider(provider)
    clean_host = normalize_host(host, clean_provider)
    clean_target = validate_remote_target(target, clean_provider)
    project["remote"] = {
        "provider": clean_provider,
        "host": clean_host,
        "target": clean_target,
    }
    project["updated_at"] = _now()
    return project["remote"]


def unlink_remote(vault: Dict[str, Any], project_ref: Any) -> None:
    project = find_project(vault, project_ref)
    project["remote"] = None
    project["updated_at"] = _now()


def set_remote_scope(
    vault: Dict[str, Any],
    project_ref: Any,
    env_name: str,
    scope: Optional[str],
) -> Optional[str]:
    project = find_project(vault, project_ref)
    env = find_environment(project, env_name)
    env["remote_scope"] = validate_remote_scope(scope)
    project["updated_at"] = _now()
    return env["remote_scope"]


def save_credential(
    vault: Dict[str, Any],
    provider: str,
    token: str,
    host: Optional[str] = None,
) -> Dict[str, Any]:
    clean_provider = validate_provider(provider)
    clean_host = normalize_host(host, clean_provider)
    clean_token = token.strip() if isinstance(token, str) else ""
    if not (1 <= len(clean_token) <= MAX_TOKEN_LENGTH):
        raise SecretsVaultError("INVALID", "Le jeton ne peut pas être vide.")
    now = _now()
    for cred in vault["credentials"]:
        if cred["provider"] == clean_provider and cred["host"] == clean_host:
            cred["token"] = clean_token
            cred["added_at"] = now
            return cred
    record = {
        "provider": clean_provider,
        "host": clean_host,
        "token": clean_token,
        "added_at": now,
    }
    vault["credentials"].append(record)
    return record


def remove_credential(vault: Dict[str, Any], provider: str, host: Optional[str] = None) -> bool:
    clean_provider = validate_provider(provider)
    clean_host = normalize_host(host, clean_provider)
    before = len(vault["credentials"])
    vault["credentials"] = [
        c for c in vault["credentials"] if not (c["provider"] == clean_provider and c["host"] == clean_host)
    ]
    return len(vault["credentials"]) < before


def find_credential(vault: Dict[str, Any], provider: str, host: Optional[str] = None) -> Optional[str]:
    clean_provider = validate_provider(provider)
    clean_host = normalize_host(host, clean_provider)
    env_var = "GITLAB_TOKEN" if clean_provider == "gitlab" else "GITHUB_TOKEN"
    from_env = os.environ.get(env_var, "").strip()
    if from_env:
        return from_env
    for cred in vault["credentials"]:
        if cred["provider"] == clean_provider and cred["host"] == clean_host:
            return cred["token"]
    return None

