"""Interface et transport HTTP communs aux fournisseurs distants (GitLab, GitHub)."""

import json
import time
import urllib.error
import urllib.request
from typing import Any, Callable, Dict, List, Optional, Tuple
from urllib.parse import urlparse


class ProviderError(RuntimeError):
    """Erreur réseau ou API d'un fournisseur distant (ne contient jamais de secret)."""

    def __init__(self, code: str, message: str, status: Optional[int] = None) -> None:
        super().__init__(message)
        self.code = code
        self.status = status


# Type d'un transport injectable pour les tests :
# (method, url, headers, body_bytes_or_none) -> (status_code, response_headers_dict, response_bytes)
HttpTransport = Callable[[str, str, Dict[str, str], Optional[bytes]], Tuple[int, Dict[str, str], bytes]]


def default_transport(
    method: str,
    url: str,
    headers: Dict[str, str],
    body: Optional[bytes] = None,
) -> Tuple[int, Dict[str, str], bytes]:
    parsed = urlparse(url)
    if parsed.scheme != "https":
        raise ProviderError("INSECURE_URL", "Seules les URL HTTPS sont autorisées.")
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            status = resp.getcode()
            resp_headers = {k.lower(): v for k, v in resp.headers.items()}
            data = resp.read()
            return status, resp_headers, data
    except urllib.error.HTTPError as exc:
        resp_headers = {k.lower(): v for k, v in (exc.headers.items() if exc.headers else [])}
        try:
            data = exc.read()
        except Exception:
            data = b""
        return exc.code, resp_headers, data
    except urllib.error.URLError as exc:
        raise ProviderError("NETWORK", f"Impossible de joindre le serveur distant ({exc.reason}).")


def request_json(
    transport: HttpTransport,
    method: str,
    url: str,
    headers: Dict[str, str],
    payload: Optional[Dict[str, Any]] = None,
    *,
    retries: int = 3,
    sleep_fn: Callable[[float], None] = time.sleep,
) -> Tuple[int, Dict[str, str], Any]:
    req_headers = dict(headers)
    body: Optional[bytes] = None
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
        req_headers.setdefault("Content-Type", "application/json")

    attempt = 0
    while True:
        status, resp_headers, raw = transport(method, url, req_headers, body)
        if status == 429 and attempt + 1 < retries:
            attempt += 1
            retry_after = resp_headers.get("retry-after", "")
            try:
                delay = min(max(float(retry_after), 0.1), 5.0)
            except ValueError:
                delay = 0.5 * attempt
            sleep_fn(delay)
            continue
        break

    if status in (401, 403):
        raise ProviderError(
            "AUTH",
            "Jeton refusé ou permissions insuffisantes sur le fournisseur distant.",
            status=status,
        )
    if status == 404:
        raise ProviderError(
            "NOT_FOUND",
            "Projet, dépôt ou ressource introuvable sur le fournisseur distant.",
            status=status,
        )
    if status >= 400:
        detail = ""
        if raw:
            try:
                err_obj = json.loads(raw.decode("utf-8", errors="replace"))
                if isinstance(err_obj, dict):
                    msg = err_obj.get("message")
                    if isinstance(msg, str):
                        detail = f" ({msg})"
                    elif isinstance(msg, dict):
                        detail = f" ({', '.join(str(k) for k in msg.keys())})"
            except Exception:
                pass
        raise ProviderError(
            "HTTP_ERROR",
            f"Erreur HTTP {status} renvoyée par le fournisseur distant{detail}.",
            status=status,
        )

    if not raw or status == 204:
        return status, resp_headers, None
    try:
        return status, resp_headers, json.loads(raw.decode("utf-8"))
    except Exception:
        raise ProviderError("INVALID_RESPONSE", "Réponse JSON invalide du fournisseur distant.", status=status)


class RemoteProvider:
    name: str = ""
    can_read_values: bool = False

    def verify_token(self) -> str:
        raise NotImplementedError

    def list_remote(self, target: str, scope: str) -> List[Dict[str, Any]]:
        raise NotImplementedError

    def apply_plan(
        self,
        target: str,
        scope: str,
        local_vars: List[Dict[str, Any]],
        plan_items: List[Dict[str, Any]],
    ) -> Dict[str, int]:
        raise NotImplementedError

