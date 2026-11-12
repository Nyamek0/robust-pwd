"""Fournisseur GitHub Actions (secrets de dépôt ou d'environnement, REST API 2022-11-28).

Inclut l'implémentation de ``crypto_box_seal`` (X25519 + Blake2b-24 + XSalsa20-Poly1305)
en s'appuyant sur ``cryptography`` et ``hashlib`` afin de fonctionner sans dépendance
supplémentaire.
"""

import base64
import hashlib
import struct
from typing import Any, Dict, List, Tuple
from urllib.parse import quote

from cryptography.hazmat.primitives.asymmetric import x25519

from .base import HttpTransport, ProviderError, RemoteProvider, default_transport, request_json

_SIGMA = struct.unpack("<4I", b"expand 32-byte k")


def _rotl32(x: int, n: int) -> int:
    return ((x << n) | (x >> (32 - n))) & 0xFFFFFFFF


def _quarter(s: List[int], a: int, b: int, c: int, d: int) -> None:
    s[b] ^= _rotl32((s[a] + s[d]) & 0xFFFFFFFF, 7)
    s[c] ^= _rotl32((s[b] + s[a]) & 0xFFFFFFFF, 9)
    s[d] ^= _rotl32((s[c] + s[b]) & 0xFFFFFFFF, 13)
    s[a] ^= _rotl32((s[d] + s[c]) & 0xFFFFFFFF, 18)


def _salsa20_core(state: List[int]) -> List[int]:
    s = list(state)
    for _ in range(10):
        _quarter(s, 0, 4, 8, 12)
        _quarter(s, 5, 9, 13, 1)
        _quarter(s, 10, 14, 2, 6)
        _quarter(s, 15, 3, 7, 11)
        _quarter(s, 0, 1, 2, 3)
        _quarter(s, 5, 6, 7, 4)
        _quarter(s, 10, 11, 8, 9)
        _quarter(s, 15, 12, 13, 14)
    return s


def _hsalsa20(key32: bytes, nonce16: bytes) -> bytes:
    k = struct.unpack("<8I", key32)
    n = struct.unpack("<4I", nonce16)
    state = [
        _SIGMA[0], k[0], k[1], k[2],
        k[3], _SIGMA[1], n[0], n[1],
        n[2], n[3], _SIGMA[2], k[4],
        k[5], k[6], k[7], _SIGMA[3],
    ]
    y = _salsa20_core(state)
    return struct.pack("<8I", y[0], y[5], y[10], y[15], y[6], y[7], y[8], y[9])


def _salsa20_stream(key32: bytes, nonce8: bytes, length: int) -> bytes:
    k = struct.unpack("<8I", key32)
    n = struct.unpack("<2I", nonce8)
    out = bytearray()
    counter = 0
    while len(out) < length:
        c0 = counter & 0xFFFFFFFF
        c1 = (counter >> 32) & 0xFFFFFFFF
        state = [
            _SIGMA[0], k[0], k[1], k[2],
            k[3], _SIGMA[1], n[0], n[1],
            c0, c1, _SIGMA[2], k[4],
            k[5], k[6], k[7], _SIGMA[3],
        ]
        y = _salsa20_core(state)
        out.extend(struct.pack("<16I", *(((y[i] + state[i]) & 0xFFFFFFFF) for i in range(16))))
        counter += 1
    return bytes(out[:length])


def _poly1305_mac(msg: bytes, key32: bytes) -> bytes:
    r = int.from_bytes(key32[:16], "little") & 0x0FFFFFFC0FFFFFFC0FFFFFFC0FFFFFFF
    s = int.from_bytes(key32[16:], "little")
    p = (1 << 130) - 5
    acc = 0
    for i in range(0, len(msg), 16):
        block = msg[i:i + 16] + b"\x01"
        acc = ((acc + int.from_bytes(block, "little")) * r) % p
    return ((acc + s) & ((1 << 128) - 1)).to_bytes(16, "little")


def seal_box(plaintext: bytes, recipient_pub_key_b64: str) -> str:
    """Chiffre ``plaintext`` au format libsodium ``crypto_box_seal`` attendu par GitHub."""
    try:
        recipient_bytes = base64.b64decode(recipient_pub_key_b64, validate=True)
    except Exception:
        raise ProviderError("INVALID_KEY", "Clé publique GitHub invalide.")
    if len(recipient_bytes) != 32:
        raise ProviderError("INVALID_KEY", "Clé publique GitHub de longueur invalide.")

    eph_sk = x25519.X25519PrivateKey.generate()
    eph_pk = eph_sk.public_key().public_bytes_raw()
    recipient_pk = x25519.X25519PublicKey.from_public_bytes(recipient_bytes)
    shared = eph_sk.exchange(recipient_pk)
    first_key = _hsalsa20(shared, b"\x00" * 16)
    nonce = hashlib.blake2b(eph_pk + recipient_bytes, digest_size=24).digest()
    subkey = _hsalsa20(first_key, nonce[:16])
    stream = _salsa20_stream(subkey, nonce[16:], 32 + len(plaintext))
    poly_key = stream[:32]
    cipher = bytes(a ^ b for a, b in zip(plaintext, stream[32:]))
    tag = _poly1305_mac(cipher, poly_key)
    return base64.b64encode(eph_pk + tag + cipher).decode("ascii")


def open_sealed_box(sealed_b64: str, recipient_priv_bytes: bytes) -> bytes:
    """Déchiffre une boîte scellée (utilisé par les tests unitaires et de compatibilité)."""
    raw = base64.b64decode(sealed_b64)
    if len(raw) < 48:
        raise ValueError("Boîte scellée trop courte.")
    eph_pk_bytes, tag, cipher = raw[:32], raw[32:48], raw[48:]
    sk = x25519.X25519PrivateKey.from_private_bytes(recipient_priv_bytes)
    pk_bytes = sk.public_key().public_bytes_raw()
    shared = sk.exchange(x25519.X25519PublicKey.from_public_bytes(eph_pk_bytes))
    first_key = _hsalsa20(shared, b"\x00" * 16)
    nonce = hashlib.blake2b(eph_pk_bytes + pk_bytes, digest_size=24).digest()
    subkey = _hsalsa20(first_key, nonce[:16])
    stream = _salsa20_stream(subkey, nonce[16:], 32 + len(cipher))
    if _poly1305_mac(cipher, stream[:32]) != tag:
        raise ValueError("Authentification Poly1305 échouée.")
    return bytes(a ^ b for a, b in zip(cipher, stream[32:]))


class GitHubProvider(RemoteProvider):
    name = "github"
    can_read_values = False

    def __init__(
        self,
        host: str,
        token: str,
        transport: HttpTransport = default_transport,
    ) -> None:
        self.host = host.rstrip("/")
        self.token = token
        self.transport = transport

    def _headers(self) -> Dict[str, str]:
        return {
            "Authorization": f"Bearer {self.token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "robust-pwd/1.1",
        }

    def _secrets_base(self, target: str, scope: str) -> str:
        owner, _, repo = target.strip("/").partition("/")
        if not owner or not repo or "/" in repo:
            raise ProviderError("INVALID_TARGET", "Un dépôt GitHub s'écrit « propriétaire/dépôt ».")
        base = f"{self.host}/repos/{quote(owner, safe='')}/{quote(repo, safe='')}"
        if scope == "*":
            return f"{base}/actions/secrets"
        return f"{base}/environments/{quote(scope, safe='')}/actions/secrets"

    def verify_token(self) -> str:
        _, _, data = request_json(self.transport, "GET", f"{self.host}/user", self._headers())
        if not isinstance(data, dict) or not data.get("login"):
            raise ProviderError("INVALID_RESPONSE", "Réponse utilisateur GitHub invalide.")
        return str(data["login"])

    def _fetch_public_key(self, target: str, scope: str) -> Tuple[str, str]:
        base = self._secrets_base(target, scope)
        _, _, data = request_json(self.transport, "GET", f"{base}/public-key", self._headers())
        if not isinstance(data, dict) or not data.get("key_id") or not data.get("key"):
            raise ProviderError("INVALID_RESPONSE", "Clé publique GitHub invalide.")
        return str(data["key_id"]), str(data["key"])

    def list_remote(self, target: str, scope: str) -> List[Dict[str, Any]]:
        base = self._secrets_base(target, scope)
        page = 1
        collected: List[Dict[str, Any]] = []
        while True:
            url = f"{base}?per_page=100&page={page}"
            _, _, data = request_json(self.transport, "GET", url, self._headers())
            if not isinstance(data, dict) or not isinstance(data.get("secrets"), list):
                raise ProviderError("INVALID_RESPONSE", "Liste de secrets GitHub invalide.")
            secrets_list = data["secrets"]
            for item in secrets_list:
                if not isinstance(item, dict) or not item.get("name"):
                    continue
                collected.append(
                    {
                        "key": str(item["name"]),
                        "value": None,
                        "masked": True,
                        "protected": False,
                        "raw": True,
                        "type": "env_var",
                    }
                )
            if len(secrets_list) < 100:
                break
            page += 1
        return collected

    def apply_plan(
        self,
        target: str,
        scope: str,
        local_vars: List[Dict[str, Any]],
        plan_items: List[Dict[str, Any]],
    ) -> Dict[str, int]:
        base = self._secrets_base(target, scope)
        by_upper = {v["key"].upper(): v for v in local_vars}
        needs_key = any(item["action"] in ("create", "update", "overwrite") for item in plan_items)
        key_id = pub_key = ""
        if needs_key:
            key_id, pub_key = self._fetch_public_key(target, scope)

        summary = {"created": 0, "updated": 0, "deleted": 0}
        for item in plan_items:
            action = item["action"]
            name = item["key"].upper()
            encoded_name = quote(name, safe="")
            if action in ("create", "update", "overwrite"):
                var = by_upper[name]
                encrypted = seal_box(var["value"].encode("utf-8"), pub_key)
                payload = {"encrypted_value": encrypted, "key_id": key_id}
                request_json(self.transport, "PUT", f"{base}/{encoded_name}", self._headers(), payload)
                if action == "create":
                    summary["created"] += 1
                else:
                    summary["updated"] += 1
            elif action == "delete":
                request_json(self.transport, "DELETE", f"{base}/{encoded_name}", self._headers())
                summary["deleted"] += 1
        return summary

