"""Calcul du plan de synchronisation et validation par fournisseur (voir docs/secrets-format.md, §5).

Implémentation jumelle de ``desktop/src/main/sync.ts``.
"""

import re
from typing import Any, Dict, List

ACTION_ORDER = {
    "create": 0,
    "update": 1,
    "overwrite": 2,
    "delete": 3,
    "keep": 4,
    "unchanged": 5,
}

_GITLAB_MASKED_RE = re.compile(r"^[A-Za-z0-9+/=@:.~_-]{8,}$")
_GITHUB_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
GITLAB_MAX_VALUE_LENGTH = 10_000
GITHUB_MAX_VALUE_BYTES = 48 * 1024


def validate_for_provider(provider: str, local_vars: List[Dict[str, Any]]) -> List[str]:
    """Retourne la liste des erreurs de validation (sans jamais inclure de valeur)."""
    errors: List[str] = []
    if provider == "gitlab":
        for var in local_vars:
            key = var["key"]
            value = var["value"]
            if len(value) > GITLAB_MAX_VALUE_LENGTH:
                errors.append(
                    f"{key} : dépasse la taille maximale GitLab ({GITLAB_MAX_VALUE_LENGTH} caractères)."
                )
            if var.get("masked"):
                if len(value) < 8:
                    errors.append(f"{key} : une variable masquée GitLab doit faire au moins 8 caractères.")
                elif "\n" in value or "\r" in value:
                    errors.append(f"{key} : une variable masquée GitLab ne peut pas être multi-ligne.")
                elif not _GITLAB_MASKED_RE.match(value):
                    errors.append(
                        f"{key} : contient des caractères non pris en charge par le masquage GitLab."
                    )
    elif provider == "github":
        seen_upper: Dict[str, str] = {}
        for var in local_vars:
            key = var["key"]
            value = var["value"]
            upper = key.upper()
            if upper in seen_upper and seen_upper[upper] != key:
                errors.append(
                    f"{key} : collision de nom insensible à la casse avec « {seen_upper[upper]} » sur GitHub."
                )
            seen_upper[upper] = key
            if not _GITHUB_KEY_RE.match(key):
                errors.append(f"{key} : nom de secret GitHub invalide.")
            if upper.startswith("GITHUB_"):
                errors.append(f"{key} : un secret GitHub ne peut pas commencer par « GITHUB_ ».")
            if len(value) == 0:
                errors.append(f"{key} : un secret GitHub ne peut pas être vide.")
            if len(value.encode("utf-8")) > GITHUB_MAX_VALUE_BYTES:
                errors.append(f"{key} : dépasse la limite GitHub de 48 Ko.")
    else:
        errors.append(f"Fournisseur inconnu : {provider}")
    return errors


def _same_gitlab_var(local: Dict[str, Any], remote: Dict[str, Any]) -> bool:
    return (
        local["value"] == remote.get("value")
        and bool(local.get("masked", False)) == bool(remote.get("masked", False))
        and bool(local.get("protected", False)) == bool(remote.get("protected", False))
        and bool(local.get("raw", True)) == bool(remote.get("raw", True))
        and local.get("type", "env_var") == remote.get("type", "env_var")
    )


def build_sync_plan(
    *,
    provider: str,
    target: str,
    environment: str,
    scope: str,
    local_vars: List[Dict[str, Any]],
    remote_vars: List[Dict[str, Any]],
    prune: bool = False,
) -> Dict[str, Any]:
    can_read = provider == "gitlab"
    case_insensitive = provider == "github"

    def norm(k: str) -> str:
        return k.upper() if case_insensitive else k

    local_by_norm = {norm(v["key"]): v for v in local_vars}
    remote_by_norm = {norm(v["key"]): v for v in remote_vars}

    items: List[Dict[str, Any]] = []
    for nkey, lvar in local_by_norm.items():
        out_key = nkey if case_insensitive else lvar["key"]
        rvar = remote_by_norm.get(nkey)
        if rvar is None:
            action = "create"
        elif not can_read:
            action = "overwrite"
        elif _same_gitlab_var(lvar, rvar):
            action = "unchanged"
        else:
            action = "update"
        items.append(
            {
                "key": out_key,
                "action": action,
                "masked": bool(lvar.get("masked", False)),
                "protected": bool(lvar.get("protected", False)),
                "raw": bool(lvar.get("raw", True)),
                "type": lvar.get("type", "env_var"),
            }
        )

    for nkey, rvar in remote_by_norm.items():
        if nkey in local_by_norm:
            continue
        items.append(
            {
                "key": rvar["key"],
                "action": "delete" if prune else "keep",
                "masked": bool(rvar.get("masked", False)),
                "protected": bool(rvar.get("protected", False)),
                "raw": bool(rvar.get("raw", True)),
                "type": rvar.get("type", "env_var"),
            }
        )

    items.sort(key=lambda item: (ACTION_ORDER[item["action"]], item["key"]))
    counts = {name: 0 for name in ACTION_ORDER}
    for item in items:
        counts[item["action"]] += 1

    errors = validate_for_provider(provider, local_vars)
    return {
        "provider": provider,
        "target": target,
        "environment": environment,
        "scope": scope,
        "can_read_values": can_read,
        "items": items,
        "errors": errors,
        "counts": counts,
    }

