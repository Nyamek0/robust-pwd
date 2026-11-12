"""Coffre de mots de passe (``~/.robust-pwd/vault.enc``)."""

import json
from pathlib import Path
from typing import Optional

from . import crypto

VAULT_PATH = Path.home() / ".robust-pwd" / "vault.enc"


def _path(path: Optional[Path]) -> Path:
    return Path(path) if path is not None else VAULT_PATH


def load_vault(master: str, path: Optional[Path] = None) -> dict:
    target = _path(path)
    if not target.exists():
        return {"entries": []}
    try:
        return json.loads(crypto.decrypt(target.read_bytes(), master))
    except Exception:
        raise ValueError("Mot de passe maître incorrect ou fichier corrompu.")


def save_vault(vault: dict, master: str, path: Optional[Path] = None) -> None:
    data = json.dumps(vault, ensure_ascii=False).encode()
    crypto.write_atomic(_path(path), crypto.encrypt(data, master))


def vault_exists(path: Optional[Path] = None) -> bool:
    return _path(path).exists()


def next_id(vault: dict) -> int:
    return max((e["id"] for e in vault["entries"]), default=0) + 1

