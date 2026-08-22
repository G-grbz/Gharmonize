# Security Policy

## Supported versions

Security fixes are provided for the latest released version of Gharmonize. Users should upgrade before reporting issues that may already be fixed on `main`.

## Reporting a vulnerability

Please do **not** open a public GitHub issue for an undisclosed vulnerability. Use GitHub Private Vulnerability Reporting when it is enabled for this repository. If private reporting is temporarily unavailable, contact the maintainer through the contact information published on the repository profile and avoid including exploit details in public channels.

Include the affected version, deployment mode (desktop, native web, or Docker), reproduction steps, impact, and any relevant logs with secrets removed.

## Security model

- The native web server binds to `127.0.0.1` by default. Docker explicitly opts into `0.0.0.0`.
- Remote deployments should be placed behind HTTPS and a trusted reverse proxy/firewall.
- `TRUST_PROXY` should only be enabled together with explicit `TRUSTED_PROXY_CIDRS`.
- Admin passwords are stored as scrypt hashes. Sensitive settings supported by the settings UI are encrypted at rest with AES-256-GCM.
- Keep `.gharmonize-key`, `.env`, cookie files, media inputs, and output directories out of source control and backups with overly broad access.
- Runtime binary downloads are restricted to trusted HTTPS origins; GitHub release asset SHA-256 digests are verified when supplied by GitHub.
- Electron uses context isolation, renderer sandboxing, navigation restrictions, IPC sender validation, and denies unexpected permission requests.

## Release verification

Official tagged releases publish `SHA256SUMS`, a CycloneDX SBOM, and GitHub artifact attestations. Verify a downloaded artifact with:

```bash
gh attestation verify <artifact> --repo G-grbz/Gharmonize
sha256sum -c SHA256SUMS
```
