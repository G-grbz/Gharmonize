# Code signing policy

This policy applies to Windows binaries distributed through the official
[`G-grbz/Gharmonize`](https://github.com/G-grbz/Gharmonize) GitHub repository.
Test-signed workflow artifacts are for validation only and are not official
releases.

## Current release status

The Windows artifacts in **v1.4.3 do not carry a trusted Authenticode signature**.
This includes
the NSIS installer, the standalone portable executable, and the application
executable inside the portable-folder ZIP. Self-signed test certificates are
not used in this public release.

Windows may show an unknown-publisher or SmartScreen warning, and managed
security policies may block execution. The GPG-signed checksum manifest and
GitHub artifact attestations provide separate release-integrity verification;
they do not provide Windows Authenticode trust. Users should not disable security
protections or install a test certificate to run an official release.

## Project roles

| Role | Members |
| --- | --- |
| Authors and committers | [@G-grbz](https://github.com/G-grbz) |
| Reviewers | [@G-grbz](https://github.com/G-grbz) |
| Release signing approvers | [@G-grbz](https://github.com/G-grbz) |

Changes from contributors who do not have commit access are reviewed by a
project reviewer before they are merged. Accounts used for source control and
code-signing administration must use multi-factor authentication.

## Build and signing process

Official releases are created from version tags in this repository by GitHub
Actions. The release workflow verifies that the tag version matches the
application version and that the tagged commit is reachable from `main`. Tests,
security checks, checksums, provenance attestations, and the software bill of
materials are produced by the repository's workflows.

Current public Windows packages are distributed without a trusted Authenticode
signature. Any future change in this status must be verified on the published
artifacts before the documentation describes those artifacts as signed.

The Windows NSIS installer and the standalone portable executable must carry
valid Authenticode signatures before publication as signed artifacts. A ZIP
archive cannot itself carry an Authenticode signature; for the portable-folder
distribution, the application executable inside the archive must be signed
before the archive is created.

A Windows artifact is described as signed only when its Authenticode signature
was created with a trusted code-signing certificate and successfully verified.
Self-signed test certificates are never used for public releases.

## Verification and official distribution

Official binaries are published only on the
[GitHub Releases](https://github.com/G-grbz/Gharmonize/releases) page. Release
assets also include a signed `SHA256SUMS` manifest and GitHub artifact
attestations. Verification instructions are provided in
[SECURITY.md](SECURITY.md#release-verification).

Report suspected signing-key misuse, modified release artifacts, or other
security issues according to [SECURITY.md](SECURITY.md#reporting-a-vulnerability).

## Privacy

Release verification does not require uploading end-user media or credentials.
Gharmonize's runtime data handling and network connections are
described in the [Privacy Policy](PRIVACY.md).
