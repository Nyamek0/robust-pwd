"""Fabrique des fournisseurs distants (GitLab CI/CD, GitHub Actions)."""

from .base import HttpTransport, ProviderError, RemoteProvider, default_transport
from .github import GitHubProvider, open_sealed_box, seal_box
from .gitlab import GitLabProvider


def create_provider(
    provider: str,
    host: str,
    token: str,
    transport: HttpTransport = default_transport,
) -> RemoteProvider:
    clean = provider.strip().lower()
    if clean == "gitlab":
        return GitLabProvider(host, token, transport)
    if clean == "github":
        return GitHubProvider(host, token, transport)
    raise ProviderError("INVALID", f"Fournisseur inconnu : {provider}")


__all__ = [
    "GitHubProvider",
    "GitLabProvider",
    "HttpTransport",
    "ProviderError",
    "RemoteProvider",
    "create_provider",
    "default_transport",
    "open_sealed_box",
    "seal_box",
]

