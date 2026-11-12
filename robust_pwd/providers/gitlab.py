"""Fournisseur GitLab CI/CD (variables de projet, REST v4)."""

from typing import Any, Dict, List
from urllib.parse import quote

from .base import HttpTransport, ProviderError, RemoteProvider, default_transport, request_json


class GitLabProvider(RemoteProvider):
    name = "gitlab"
    can_read_values = True

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
            "PRIVATE-TOKEN": self.token,
            "Accept": "application/json",
            "User-Agent": "robust-pwd/1.1",
        }

    def _project_url(self, target: str) -> str:
        encoded = quote(target.strip("/"), safe="")
        return f"{self.host}/api/v4/projects/{encoded}"

    def verify_token(self) -> str:
        _, _, data = request_json(
            self.transport,
            "GET",
            f"{self.host}/api/v4/user",
            self._headers(),
        )
        if not isinstance(data, dict) or not data.get("username"):
            raise ProviderError("INVALID_RESPONSE", "Réponse utilisateur GitLab invalide.")
        return str(data["username"])

    def list_remote(self, target: str, scope: str) -> List[Dict[str, Any]]:
        base = self._project_url(target)
        page = 1
        collected: List[Dict[str, Any]] = []
        while True:
            url = f"{base}/variables?per_page=100&page={page}"
            _, headers, data = request_json(self.transport, "GET", url, self._headers())
            if not isinstance(data, list):
                raise ProviderError("INVALID_RESPONSE", "Liste de variables GitLab invalide.")
            for item in data:
                if not isinstance(item, dict):
                    continue
                item_scope = item.get("environment_scope") or "*"
                if item_scope != scope:
                    continue
                collected.append(
                    {
                        "key": str(item["key"]),
                        "value": str(item.get("value", "")),
                        "masked": bool(item.get("masked", False)),
                        "protected": bool(item.get("protected", False)),
                        "raw": bool(item.get("raw", True)),
                        "type": "file" if item.get("variable_type") == "file" else "env_var",
                    }
                )
            next_page = headers.get("x-next-page", "").strip()
            if not next_page or len(data) < 100:
                break
            try:
                page = int(next_page)
            except ValueError:
                break
        return collected

    def apply_plan(
        self,
        target: str,
        scope: str,
        local_vars: List[Dict[str, Any]],
        plan_items: List[Dict[str, Any]],
    ) -> Dict[str, int]:
        base = self._project_url(target)
        by_key = {v["key"]: v for v in local_vars}
        encoded_scope = quote(scope, safe="")
        summary = {"created": 0, "updated": 0, "deleted": 0}

        for item in plan_items:
            action = item["action"]
            key = item["key"]
            encoded_key = quote(key, safe="")
            if action == "create":
                var = by_key[key]
                payload = {
                    "key": key,
                    "value": var["value"],
                    "masked": bool(var.get("masked", False)),
                    "protected": bool(var.get("protected", False)),
                    "raw": bool(var.get("raw", True)),
                    "variable_type": var.get("type", "env_var"),
                    "environment_scope": scope,
                }
                request_json(self.transport, "POST", f"{base}/variables", self._headers(), payload)
                summary["created"] += 1
            elif action == "update":
                var = by_key[key]
                payload = {
                    "value": var["value"],
                    "masked": bool(var.get("masked", False)),
                    "protected": bool(var.get("protected", False)),
                    "raw": bool(var.get("raw", True)),
                    "variable_type": var.get("type", "env_var"),
                    "environment_scope": scope,
                }
                url = f"{base}/variables/{encoded_key}?filter[environment_scope]={encoded_scope}"
                request_json(self.transport, "PUT", url, self._headers(), payload)
                summary["updated"] += 1
            elif action == "delete":
                url = f"{base}/variables/{encoded_key}?filter[environment_scope]={encoded_scope}"
                request_json(self.transport, "DELETE", url, self._headers())
                summary["deleted"] += 1
        return summary

