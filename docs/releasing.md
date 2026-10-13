# Releasing

ExtraLife publishes npm packages from GitHub Releases with GitHub Actions and npm trusted publishing. The workflow is `.github/workflows/publish.yml`.

## One-time setup

1. Create the public GitHub repository at `rroy233/extralife` and push the source.
2. Publish the first npm version interactively with `npm publish --access public`. The npm package must exist before its Trusted Publisher settings can be configured; a GitHub Release for this bootstrap version is optional.
3. In npmjs.com, open the `@rroy233/extralife` package's **Settings → Trusted Publisher** and select **GitHub Actions**. Set the owner to `rroy233`, repository to `extralife`, and workflow filename to `publish.yml`. Leave the environment blank unless the workflow is later changed to use a GitHub deployment environment.
4. Allow direct `npm publish` for this trusted publisher. Newly created npm trusted-publisher configurations must complete a successful publish within two days, so configure this shortly before the next release.
5. Keep the npm package's `repository` field aligned with `https://github.com/rroy233/extralife`.

The first package version is a bootstrap publish. After the trusted publisher is configured, the first successful workflow publish validates the OIDC relationship. If that publish does not happen within two days, recreate the trusted-publisher configuration.

## Each release

1. Update `version` in `package.json` using semantic versioning and commit the change.
2. Create and publish a GitHub Release whose tag is `v<package-version>` (for example, `v1.0.1`).
3. The workflow checks that the release tag matches the package version, runs the existing test suite on Node.js 24, and publishes to npm using OIDC. Pre-releases are skipped.

The workflow uses the GitHub release's tagged commit. A mismatch between the tag and `package.json` stops the publish. No long-lived npm publish token is stored in GitHub Secrets.

## Runtime and authentication requirements

npm trusted publishing requires npm CLI 11.5.1 or newer and Node.js 22.14.0 or newer. The workflow uses Node.js 24, installs npm 11.5.1 or newer, and grants `id-token: write`. GitHub Actions must use a GitHub-hosted runner.

See [npm's trusted publishing guide](https://docs.npmjs.com/trusted-publishers/) for the current setup and troubleshooting details.
