# Code signing policy

Free code signing provided by [SignPath.io](https://signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).

This policy applies to Windows binaries distributed through the official
[`G-grbz/Gharmonize`](https://github.com/G-grbz/Gharmonize) GitHub repository.
Test-signed workflow artifacts are for validation only and are not official
releases.

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

Once the SignPath Foundation release certificate is active, Windows release
signing uses GitHub-hosted runners as the trusted build system. Artifacts are
submitted directly from GitHub Actions to SignPath, with origin verification and
the `release-signing` policy. A production signing request requires manual
approval by a release signing approver. Private signing keys are not stored in
this repository or exposed to its maintainers.

The Windows NSIS installer and the standalone portable executable must carry
valid Authenticode signatures before publication as signed artifacts. A ZIP
archive cannot itself carry an Authenticode signature; for the portable-folder
distribution, the application executable inside the archive must be signed
before the archive is created.

A Windows artifact is described as SignPath-signed only when its Authenticode
signature was created with the release certificate and successfully verified.
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

Code signing happens in the release build pipeline and does not send end-user
data to SignPath. Gharmonize's runtime data handling and network connections are
described in the [Privacy Policy](PRIVACY.md).
