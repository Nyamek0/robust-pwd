"""Chiffrement des coffres : PBKDF2-HMAC-SHA256 + AES-256-GCM.

Format binaire commun à tous les coffres (et à l'application desktop) :
    salt (16) | nonce (12) | ciphertext | tag GCM (16)
"""

import os
import tempfile
from pathlib import Path

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

PBKDF2_ITERATIONS = 600_000
KEY_LENGTH = 32
SALT_LENGTH = 16
NONCE_LENGTH = 12
TAG_LENGTH = 16


def derive_key(master: str, salt: bytes) -> bytes:
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=KEY_LENGTH,
        salt=salt,
        iterations=PBKDF2_ITERATIONS,
    )
    return kdf.derive(master.encode())


def encrypt(data: bytes, master: str) -> bytes:
    salt = os.urandom(SALT_LENGTH)
    nonce = os.urandom(NONCE_LENGTH)
    key = derive_key(master, salt)
    ciphertext = AESGCM(key).encrypt(nonce, data, None)
    return salt + nonce + ciphertext


def decrypt(blob: bytes, master: str) -> bytes:
    """Déchiffre un coffre. Lève ``InvalidTag`` ou ``ValueError`` en cas d'échec."""
    if len(blob) < SALT_LENGTH + NONCE_LENGTH + TAG_LENGTH:
        raise ValueError("Fichier incomplet ou corrompu.")
    salt = blob[:SALT_LENGTH]
    nonce = blob[SALT_LENGTH:SALT_LENGTH + NONCE_LENGTH]
    ciphertext = blob[SALT_LENGTH + NONCE_LENGTH:]
    key = derive_key(master, salt)
    return AESGCM(key).decrypt(nonce, ciphertext, None)


def write_atomic(path: Path, data: bytes) -> None:
    """Écrit ``data`` dans ``path`` de façon atomique, dossier 700 et fichier 600."""
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        try:
            tmp.chmod(0o600)
        except OSError:
            pass
        os.replace(tmp, path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    try:
        path.chmod(0o600)
    except OSError:
        pass

