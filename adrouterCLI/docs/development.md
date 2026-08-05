# Maintainer development

Use Node.js 22.19 or newer and install without lifecycle scripts:

```sh
npm ci --ignore-scripts
npm run build
npm run check
./test.sh
```

`npm run release:local -- --skip-binary --skip-bun-install` builds the three
private internal workspace tarballs in temporary staging, installs them into a
staged CLI tree, and packs only `@adrouter/cli`.

`npm run check` is read-only. Use `npm run format` explicitly to apply formatting. Development and tests must not use a maintainer's real home or AdRouter state. Package and smoke-test from a clean checkout outside the workspace.

## Local packaged CLI install

Build every workspace, stage the private packages, validate the resulting
tarball, and install it into the configured global npm prefix:

```sh
npm run install:local
adrouter --version
adrouter --help
adrouter-profile --help
adrouter --json doctor
```

The doctor result must be deployable and classified as `packaged`.

For fast source development only, create an explicit workspace link:

```sh
npm run link:dev
```

The link resolves dependencies from the checkout and can hide packaging
defects. It is classified as `source-linked` and must never be used as release
or deployment evidence. Generated JavaScript does not rebuild automatically;
run `npm run build` after source changes.

Remove the source link with:

```sh
npm unlink --global @adrouter/cli
```

To return to the public beta after unlinking:

```sh
npm install --global --ignore-scripts @adrouter/cli@beta
```
