# Lifecycle navigation privacy

Lifecycle navigation is disabled by default. The `lifecycle-feedback` option is
the single opt-in control; turning it off clears the uninstall URL and prevents
install/update tabs from being created.

When enabled, the extension can make only these outbound navigations:

- install/update: `https://github.com/ErDreiwen/auto-tab-discard/releases/tag/v<VERSION>`;
- uninstall: `https://github.com/ErDreiwen/auto-tab-discard/issues/new`.

The release-notes URL contains only the public extension version. The uninstall
URL has no query, fragment, version, install reason, extension ID, tab data,
profile value, or generated identifier. Both destinations are exact HTTPS
paths on the fixed `github.com` origin; redirects and the destination site's
own processing are governed by GitHub's policies.

Non-store/development installations do not open lifecycle tabs. Update notices
are inactive and rate-limited to one per 45 days. The normal settings export
records the local boolean preference, but it does not contact either origin.
