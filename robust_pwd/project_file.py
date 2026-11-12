"""Fichier projet ``.robust-pwd.json`` et vérifications Git (voir docs/secrets-format.md, §4)."""

import json
import subprocess
from pathlib import Path
from typing import Dict, Optional, Tuple

from .secrets_vault import SecretsVaultError, validate_env_name, validate_project_name

PROJECT_FILENAME = ".robust-pwd.json"


def parse_project_file(raw: str, source: Optional[Path] = None) -> Dict[str, str]:
    loc = f" ({source})" if source else ""
    try:
        parsed = json.loads(raw)
    except Exception:
        raise SecretsVaultError("INVALID", f"Fichier {PROJECT_FILENAME} illisible{loc}.")
    if not isinstance(parsed, dict):
        raise SecretsVaultError("INVALID", f"Fichier {PROJECT_FILENAME} invalide{loc}.")
    project = validate_project_name(parsed.get("project", ""))
    env_raw = parsed.get("environment")
    environment = validate_env_name(env_raw) if env_raw else "local"
    return {"project": project, "environment": environment}


def find_project_file(start_dir: Optional[Path] = None) -> Optional[Tuple[Path, Dict[str, str]]]:
    """Remonte depuis ``start_dir`` jusqu'à la racine du dépôt Git ou du système."""
    current = (Path(start_dir) if start_dir is not None else Path.cwd()).resolve()
    while True:
        candidate = current / PROJECT_FILENAME
        if candidate.is_file():
            text = candidate.read_text(encoding="utf-8")
            return candidate, parse_project_file(text, candidate)
        if (current / ".git").exists():
            return None
        parent = current.parent
        if parent == current:
            return None
        current = parent


def resolve_project_and_env(
    project: Optional[str] = None,
    environment: Optional[str] = None,
    start_dir: Optional[Path] = None,
) -> Tuple[str, str]:
    """Résout ``(project, environment)`` à partir des arguments ou de ``.robust-pwd.json``."""
    if project and environment:
        return validate_project_name(project), validate_env_name(environment)
    found = find_project_file(start_dir)
    if found is None:
        if not project:
            raise SecretsVaultError(
                "INVALID",
                f"Aucun projet précisé et aucun fichier {PROJECT_FILENAME} trouvé.",
            )
        return validate_project_name(project), validate_env_name(environment or "local")
    _, config = found
    resolved_project = validate_project_name(project) if project else config["project"]
    resolved_env = validate_env_name(environment) if environment else config["environment"]
    return resolved_project, resolved_env


def write_project_file(
    project: str,
    environment: str = "local",
    directory: Optional[Path] = None,
) -> Path:
    clean_project = validate_project_name(project)
    clean_env = validate_env_name(environment)
    target_dir = (Path(directory) if directory is not None else Path.cwd()).resolve()
    target = target_dir / PROJECT_FILENAME
    payload = json.dumps({"project": clean_project, "environment": clean_env}, ensure_ascii=False, indent=2) + "\n"
    target.write_text(payload, encoding="utf-8")
    return target


def is_git_ignored(path: Path) -> Optional[bool]:
    """Retourne ``True`` si ``path`` est ignoré par Git, ``False`` s'il est dans un dépôt Git
    sans être ignoré, ou ``None`` hors dépôt Git / si ``git`` est absent."""
    target = Path(path).resolve()
    cwd = target.parent if target.parent.exists() else Path.cwd()
    try:
        inside = subprocess.run(
            ["git", "rev-parse", "--is-inside-work-tree"],
            cwd=str(cwd),
            capture_output=True,
            text=True,
            timeout=3,
        )
        if inside.returncode != 0 or inside.stdout.strip() != "true":
            return None
        chk = subprocess.run(
            ["git", "check-ignore", "-q", str(target)],
            cwd=str(cwd),
            capture_output=True,
            timeout=3,
        )
        if chk.returncode == 0:
            return True
        if chk.returncode == 1:
            return False
        return None
    except Exception:
        return None

