# Code Signing & Release Verification Policy

This policy applies to Windows binaries distributed through the official [G-grbz/Gharmonize](https://github.com/G-grbz/Gharmonize) GitHub repository.

## Current Release Status

Windows binaries built for **Gharmonize v2.2.0 do not carry a trusted Authenticode signature**.

This includes:

- The NSIS installer
- The standalone portable executable
- The application executable inside the portable-folder ZIP

Self-signed test certificates are never used for public releases.

Windows may display an unknown-publisher or Microsoft Defender SmartScreen warning. Managed security policies may also restrict execution.

Gharmonize provides separate release-integrity verification through GPG-signed checksums and GitHub artifact attestations. These mechanisms help verify the authenticity and integrity of published release artifacts, but they do not provide Windows Authenticode trust.

Users should not disable antivirus protection or other operating system security features to install Gharmonize.

## Project Roles

| Role | Members |
| --- | --- |
| Authors and committers | [@G-grbz](https://github.com/G-grbz) |
| Reviewers | [@G-grbz](https://github.com/G-grbz) |
| Release maintainers | [@G-grbz](https://github.com/G-grbz) |

Contributions from developers without commit access are reviewed before merging.

Accounts used for repository administration and release management must use multi-factor authentication.

## Build and Release Process

Official Gharmonize releases are created from version tags in the repository using GitHub Actions.

The release workflow verifies that:

- The Git tag matches the application version.
- The tagged commit is reachable from the `main` branch.
- Required automated tests and security checks are completed.
- Release artifacts are generated through the project's official workflows.

Release integrity is supported through:

- SHA-256 checksums
- GPG-signed checksum manifests
- GitHub artifact attestations
- Software Bill of Materials (SBOM)
- Automated security analysis

These verification mechanisms provide transparency and help users confirm that downloaded files correspond to the official release.

## Verification and Official Distribution

Official Gharmonize binaries are distributed exclusively through the project's [GitHub Releases](https://github.com/G-grbz/Gharmonize/releases) page.

Users should avoid downloading Gharmonize from unofficial repositories, third-party mirrors, or websites claiming to provide modified or enhanced versions.

Third-party application managers may reference official GitHub release assets, but they are not themselves official distribution channels.

Release verification instructions are available in [SECURITY.md](SECURITY.md#release-verification).

Suspected malicious distributions, modified release artifacts, impersonation, or other security issues should be reported according to [SECURITY.md](SECURITY.md#reporting-a-vulnerability).

## Privacy

Release verification does not require uploading user media, personal files, or credentials.

Gharmonize's runtime data handling and network connections are described in the [Privacy Policy](PRIVACY.md).
