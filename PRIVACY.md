# Privacy Policy

Gharmonize is a locally run or self-hosted application. The Gharmonize project
does not operate an analytics, advertising, account, or telemetry service and
does not intentionally collect end-user usage data.

## Data stored by Gharmonize

Depending on the enabled features, Gharmonize may store the following data on
the device or server where it is operated:

- application settings and administrator authentication data;
- service credentials or cookies supplied by the operator;
- job state, download lists, cached metadata, logs, and generated media files;
- temporary-access requests and grants, including security metadata derived
  from client IP addresses when application access controls are enabled.

Operators are responsible for protecting the application data directory,
configuration files, cookie files, credentials, logs, media inputs, and output
directories. Sensitive values supported by the settings interface are encrypted
at rest where documented, but filesystem permissions and host security remain
the operator's responsibility.

## Network connections

Gharmonize makes network requests to provide features selected or configured by
the user or operator. Depending on use, these requests may disclose the host's
IP address, user agent, requested URLs or search terms, and any credentials or
cookies deliberately configured for that service.

Network destinations can include:

- media and catalog services used for search, metadata, playback, and downloads,
  including YouTube/YouTube Music, Spotify, Apple Music, Deezer, TIDAL,
  SoundCloud, Vimeo, Dailymotion, Facebook, Instagram, TikTok, X, and other
  sites supported by the configured download tools;
- LRCLIB when lyric lookup is requested;
- GitHub and MKVToolNix infrastructure for application update checks and managed
  runtime-binary version checks or downloads;
- Google Fonts when the YTLive interface loads its web fonts;
- image, thumbnail, player, or CDN hosts belonging to the selected media
  services.

The privacy policy and terms of each contacted third-party service apply to its
handling of those requests. Common policies include
[Google](https://policies.google.com/privacy),
[GitHub](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement),
[Spotify](https://www.spotify.com/legal/privacy-policy/),
[Apple](https://www.apple.com/legal/privacy/),
[Deezer](https://www.deezer.com/legal/personal-datas),
[TIDAL](https://tidal.com/privacy), and
[SoundCloud](https://soundcloud.com/pages/privacy). Users should also review the
policy of any other site whose URL they submit to Gharmonize.

Gharmonize does not send runtime or end-user data to SignPath. SignPath is used
only by the official release build pipeline to sign project-produced Windows
binaries.

## Cookies and service credentials

Browser cookies, exported cookie files, API credentials, and service tokens are
optional and are used only for features that require them. When used, they are
sent to the applicable third-party service as part of requests made on the
operator's behalf. These values can grant access to personal accounts and must
not be shared, committed to source control, or included in public logs.

See [docs/COOKIES.md](docs/COOKIES.md) and
[docs/CONFIGURATION.md](docs/CONFIGURATION.md) for configuration and storage
guidance.

## Self-hosted deployments

The person or organization operating a remotely accessible Gharmonize instance
controls that server and its logs. That operator is responsible for providing
any additional privacy notice required for its users, configuring access
controls, securing transport with HTTPS, setting retention rules, and complying
with applicable law. The Gharmonize project does not receive data stored by an
independent deployment.

## Data removal

Because project maintainers do not operate a Gharmonize cloud service, there is
no central Gharmonize account or project-held user profile to delete. Local data
can be removed by deleting the relevant cache, configuration, log, job, and
output files on the system running Gharmonize. Deleting data held by third-party
services must be handled through those services.

Security concerns should be reported using the process in
[SECURITY.md](SECURITY.md#reporting-a-vulnerability).
