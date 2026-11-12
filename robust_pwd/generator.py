"""Générateurs de mots de passe et de secrets aléatoires."""

import base64
import secrets
import string
import uuid

VOWELS = "aeiou"
CONSONANTS = "bcdfghjklmnpqrstvwxyz"
SYMBOLS = "!@#$%^&*"


def _apple_group(length: int) -> str:
    chars = []
    for i in range(length):
        pool = CONSONANTS if i % 2 == 0 else VOWELS
        chars.append(secrets.choice(pool))
    return "".join(chars)


def generate_apple() -> str:
    g1 = _apple_group(5)
    g2 = list(_apple_group(5))
    g2.insert(secrets.randbelow(6), str(secrets.randbelow(10)))
    g3 = list(_apple_group(5))
    g3[secrets.randbelow(5)] = g3[secrets.randbelow(5)].upper()
    return f"{g1}-{''.join(g2)}-{''.join(g3)}"


def generate_google(length: int = 18) -> str:
    alphabet = string.ascii_letters + string.digits + SYMBOLS
    pwd = [
        secrets.choice(string.ascii_uppercase),
        secrets.choice(string.ascii_lowercase),
        secrets.choice(string.digits),
        secrets.choice(SYMBOLS),
    ]
    pwd += [secrets.choice(alphabet) for _ in range(length - 4)]
    secrets.SystemRandom().shuffle(pwd)
    return "".join(pwd)


SECRET_KINDS = ("hex", "base64", "uuid", "google")


def generate_secret(spec: str) -> str:
    """Génère un secret applicatif à partir d'une spécification ``type[:taille]``.

    - ``hex:N``    : N octets aléatoires en hexadécimal (2N caractères), 32 par défaut
    - ``base64:N`` : N octets aléatoires en base64 URL-safe sans remplissage, 32 par défaut
    - ``uuid``     : UUID v4
    - ``google:N`` : mot de passe style Google de N caractères (12–128), 32 par défaut
    """
    kind, _, size_text = spec.strip().lower().partition(":")
    if kind not in SECRET_KINDS:
        raise ValueError(f"Type de secret inconnu : « {kind} » (attendu : {', '.join(SECRET_KINDS)}).")
    if kind == "uuid":
        if size_text:
            raise ValueError("Le type « uuid » n'accepte pas de taille.")
        return str(uuid.uuid4())
    try:
        size = int(size_text) if size_text else 32
    except ValueError:
        raise ValueError(f"Taille invalide : « {size_text} ».")
    if kind == "google":
        if not 12 <= size <= 128:
            raise ValueError("La taille doit être comprise entre 12 et 128.")
        return generate_google(size)
    if not 8 <= size <= 256:
        raise ValueError("La taille doit être comprise entre 8 et 256 octets.")
    raw = secrets.token_bytes(size)
    if kind == "hex":
        return raw.hex()
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()

