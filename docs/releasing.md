# Releasing

ExtraLife publishes npm packages and creates GitHub Releases from pushed version tags with GitHub Actions and npm trusted publishing. The workflow is `.github/workflows/publish.yml`.

## One-time setup

1. Create the public GitHub repository at `rroy233/extralife` and push the source.
2. Publish the first npm version interactively with `npm publish --access public`. The npm package must exist before its Trusted Publisher settings can be configured; a GitHub Release for this bootstrap version is optional.
3. In npmjs.com, open the `@rroy233/extralife` package's **Settings → Trusted Publisher** and select **GitHub Actions**. Set the owner to `rroy233`, repository to `extralife`, and workflow filename to `publish.yml`. Leave the environment blank unless the workflow is later changed to use a GitHub deployment environment.
4. Allow direct `npm publish` for this trusted publisher. Newly created npm trusted-publisher configurations must complete a successful publish within two days, so configure this shortly before the next release.
5. Keep the npm package's `repository` field aligned with `https://github.com/rroy233/extralife`.

The first package version is a bootstrap publish. After the trusted publisher is configured, the first successful workflow publish validates the OIDC relationship. If that publish does not happen within two days, recreate the trusted-publisher configuration.

## Each stable release

1. Update `version` in `package.json` and commit the change to the default branch.
2. Create and push a matching tag, such as `v1.0.1` for package version `1.0.1`:

   ```sh
   git tag v1.0.1
   git push origin v1.0.1
   ```

3. The workflow checks that the tag matches `package.json`, runs the build script when present and the test suite on Node.js 24, creates the npm tarball, and publishes it using OIDC. It then creates a GitHub Release with generated release notes and attaches the same tarball. Pre-release versions are skipped.

The workflow uses the commit referenced by the pushed tag. A tag/package version mismatch stops the release. If that exact package version is already on npm, the workflow verifies its integrity and skips republishing it. No long-lived npm publish token is stored in GitHub Secrets.

## Runtime and authentication requirements

npm trusted publishing requires npm CLI 11.5.1 or newer and Node.js 22.14.0 or newer. The workflow uses Node.js 24, installs npm 11.5.1 or newer, and grants `id-token: write`. GitHub Actions must use a GitHub-hosted runner. Creating the GitHub Release also requires `contents: write` and the workflow's `GITHUB_TOKEN`.

See [npm's trusted publishing guide](https://docs.npmjs.com/trusted-publishers/) for the current setup and troubleshooting details.
